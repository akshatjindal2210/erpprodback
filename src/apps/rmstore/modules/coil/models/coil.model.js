import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as IT, RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { hasCoilJourneyFilter, appendCoilJourneyCondition } from "../../../lib/utils/logJourneyFilter.js";
import { formatCoilNoUid, formatStockAdjustmentCoilUid, sqlStickerUidEquals } from "../../../lib/coilUidFormat.js";
import { parseCoilNoUidMeta, resolveSerialNoForUid } from "../../../lib/coilUidHelpers.js";
import { COIL_QC_JOIN, COIL_QC_PASSED_COND, COIL_QC_STATUS_EXPR } from "../../../lib/utils/coilQcStatusSql.js";
import { COIL_REJECTION_JOIN, COIL_REJECTION_SELECT } from "../../../lib/utils/coilRejectionSql.js";
import { coilAreaEligibleSql, coilAreaPhysicalStatusSql, portalMrnCoilBaseSql } from "../../../lib/utils/mrnPortalCoilSql.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { roundCoilQty } from "../../../lib/utils/coilQtySplit.js";
import { isIssuedToShopFloor, isSaMinusWriteOff } from "../../../lib/utils/saMinusInventory.js";

const TABLE = T.COIL_TABLE;
const OUT_ENTRY = T.OUT_ENTRY;
const IPR_TABLE = T.IN_PROCESS_REQUEST;
const COIL_HEAT_NO_SQL = `COALESCE(NULLIF(TRIM(m.heat_no), ''), NULLIF(TRIM(m.it_lot_no), ''))`;
const COIL_QC_STATUS_SELECT = `${COIL_QC_STATUS_EXPR} AS qc_check_status`;
const COIL_REJECTION_FIELDS = `${COIL_REJECTION_SELECT.replace(/\s+/g, " ").trim()}`;
export const SA_ENTRY_TYPE = {
  STOCK_IN: "stock_in",
  STOCK_OUT: "stock_out",
  PRODUCTION_RETURN: "production_return",
};

export function enrichCoilUidMeta(row) {
  if (!row) return row;
  const meta = parseCoilNoUidMeta(row.coil_no_uid);
  return { ...row, coil_index: meta.index, total_coils: meta.total };
}

/** Job card column: single JC or reassign split (source qty → balance qty on target JC). */
export function enrichCoilJobCardDisplay(row) {
  if (!row) return row;
  const base = enrichCoilUidMeta(row);
  const source = String(base.reassign_source_pjobcardno || "").trim();
  const target = String(base.reassign_target_pjobcardno || base.pjobcardno || "").trim();
  const consumed = Number(base.reassign_consumed_qty);
  const balance = Number(base.reassign_balance_qty ?? base.qty);
  const hasSplit =
    source &&
    target &&
    source.toUpperCase() !== target.toUpperCase() &&
    (consumed > 0 || balance > 0);

  const macnameFromAssignments = (list) => {
    const macs = (list || []).map((a) => String(a?.macname || "").trim()).filter(Boolean);
    const unique = [...new Map(macs.map((m) => [m.toUpperCase(), m])).values()];
    return unique.length ? unique.join(", ") : null;
  };

  if (!hasSplit) {
    return {
      ...base,
      pjobcardno_label: base.pjobcardno || null,
      macname_label: base.reassign_target_macname || base.macname || null,
      job_card_assignments: null,
    };
  }

  const assignments = [];
  const parts = [];
  if (consumed > 0) {
    parts.push(`${source} (${consumed})`);
    assignments.push({
      pjobcardno: source,
      macname: base.reassign_source_macname || base.macname || null,
      qty: consumed,
      kind: "consumed",
    });
  }
  if (balance > 0) {
    parts.push(`${target} (${balance})`);
    assignments.push({
      pjobcardno: target,
      macname: base.reassign_target_macname || base.macname || null,
      qty: balance,
      kind: "balance",
    });
  }

  const pjobcardno_label = parts.length > 1 ? parts.join(", ") : parts[0] || base.pjobcardno || null;

  return {
    ...base,
    pjobcardno_label,
    macname_label:
      macnameFromAssignments(assignments) ||
      base.reassign_target_macname ||
      base.macname ||
      null,
    job_card_assignments: assignments.length > 1 ? assignments : assignments.length ? assignments : null,
    reassign: assignments.length > 1,
  };
}

export function coilIndexFromUidSql(alias = "c") {
  const col = alias ? `${alias}.coil_no_uid` : "coil_no_uid";
  return `NULLIF(regexp_replace(${col}, '^.*_', ''), '')::integer`;
}

export function coilTotalFromUidSql(alias = "c") {
  const col = alias ? `${alias}.coil_no_uid` : "coil_no_uid";
  return `NULLIF(regexp_replace(regexp_replace(${col}, '_[^_]*$', ''), '^.*_', ''), '')::integer`;
}

const COIL_INDEX_SELECT = `${coilIndexFromUidSql("c")} AS coil_index`;
const COIL_TOTAL_SELECT = `${coilTotalFromUidSql("c")} AS total_coils`;
const COIL_QC_UID_SELECT = `COALESCE(c.qc_uid, q.qc_check_uid) AS qc_uid`;
const COIL_SA_BILL_JOIN = `LEFT JOIN ${T.STOCK_ADJUSTMENT} sa_bill ON sa_bill.adjustment_id = c.sa_id AND sa_bill.is_deleted = false`;
const COIL_BILL_NO_SQL = `COALESCE(NULLIF(TRIM(m.bill_no), ''), NULLIF(TRIM(sa_bill.bill_no), '')) AS bill_no`;
const COIL_BILL_DT_SQL = `COALESCE(m.bill_dt, sa_bill.bill_dt) AS bill_dt`;
const COIL_DETAIL_SELECT = `c.coil_uid, c.coil_no_uid, c.mrn_uid, m.mrn_no, m.serial_no, m.mrn_dt, m.sticker_generated, m.sticker_approved, ${COIL_BILL_NO_SQL}, ${COIL_BILL_DT_SQL}, ${COIL_HEAT_NO_SQL} AS heat_no, m.it_lot_no, m.it_unit, m.item_dcode, m.item_code, m.item_desc, m.acc_code, m.acc_name, ${COIL_INDEX_SELECT}, ${COIL_TOTAL_SELECT}, m.remarks, c.qty, c.location_id, c.in_uid, ${COIL_REJECTION_FIELDS}, ${COIL_QC_UID_SELECT}, ${COIL_QC_STATUS_SELECT}, c.out_uid, c.sa_id, c.sa_entry_type, c.ipr_uid, jc.pjobcardno, jc.macname, jc.fg_item_code, jc.fg_item_desc, c.status, c.download_count, c.is_deleted, c.deleted_by, c.deleted_at, c.created_by, c.created_at, c.updated_by, c.updated_at`;
const COIL_MRN_JOIN = `LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid`;

/**
 * Job card + machine — shop floor / consumed only (not Stored).
 * JC from Store Out (live out_uid, or scanned history after consume).
 * Machine from IR job card for that same JC (same pattern as Store Out list).
 * Consumed fallback: IPR line pjobcardno / macname.
 * Reassign delete restores out_entry.pjobcardno in revertStoreInReturnCoils — keep this join thin.
 */
const COIL_JOB_CARD_JOIN = `
LEFT JOIN LATERAL (
  SELECT
    COALESCE(NULLIF(TRIM(o.pjobcardno), ''), NULLIF(TRIM(ipr_jc.pjobcardno), '')) AS pjobcardno,
    COALESCE(NULLIF(TRIM(jc_ir.macname), ''), NULLIF(TRIM(ipr_jc.macname), '')) AS macname,
    NULLIF(TRIM(jc_ir.item_code), '') AS fg_item_code,
    NULLIF(TRIM(jc_ir.item_desc), '') AS fg_item_desc,
    CASE WHEN c.out_uid IS NOT NULL THEN COALESCE(o.approved_at, o.created_at) END AS shop_floor_at
  FROM (SELECT 1) AS gate
  LEFT JOIN LATERAL (
    SELECT o.out_uid, o.issue_uid, o.pjobcardno, o.approved_at, o.created_at
    FROM ${T.OUT_ENTRY} o
    WHERE o.is_deleted = false
      AND (
        (c.out_uid IS NOT NULL AND o.out_uid = c.out_uid)
        OR (
          c.out_uid IS NULL
          AND LOWER(COALESCE(c.status, 'active')) = 'consumed'
          AND COALESCE(o.approved, false) = true
          AND NULLIF(TRIM(o.pjobcardno), '') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM ${T.OUT_ENTRY_SCANNED_COIL} s
            WHERE s.out_uid = o.out_uid
              AND LOWER(TRIM(s.coil_no_uid)) = LOWER(TRIM(c.coil_no_uid))
          )
        )
      )
    ORDER BY
      CASE WHEN c.out_uid IS NOT NULL AND o.out_uid = c.out_uid THEN 0 ELSE 1 END,
      COALESCE(o.approved_at, o.created_at) DESC NULLS LAST,
      o.out_uid DESC
    LIMIT 1
  ) o ON TRUE
  LEFT JOIN LATERAL (
    SELECT jc.macname, jc.item_code, jc.item_desc
    FROM ${T.ISSUE_REQUEST_JOB_CARD} jc
    WHERE o.out_uid IS NOT NULL
      AND jc.is_deleted = false
      AND NULLIF(TRIM(o.pjobcardno), '') IS NOT NULL
      AND UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i'))
        = UPPER(REGEXP_REPLACE(TRIM(o.pjobcardno), '^JC[[:space:]\\-]*', '', 'i'))
    ORDER BY
      CASE WHEN o.issue_uid IS NOT NULL AND jc.issue_uid = o.issue_uid THEN 0 ELSE 1 END,
      CASE WHEN NULLIF(TRIM(jc.macname), '') IS NOT NULL THEN 0 ELSE 1 END,
      jc.id DESC
    LIMIT 1
  ) jc_ir ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      NULLIF(TRIM(line->>'pjobcardno'), '') AS pjobcardno,
      NULLIF(TRIM(line->>'macname'), '') AS macname
    FROM ${IPR_TABLE} ipr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ipr.coils) = 'array' THEN ipr.coils ELSE '[]'::jsonb END
    ) AS line
    WHERE LOWER(COALESCE(c.status, 'active')) = 'consumed'
      AND ipr.is_deleted = false
      AND ipr.request_type = 'consume'
      AND LOWER(TRIM(line->>'coil_no_uid')) = LOWER(TRIM(c.coil_no_uid))
      AND NULLIF(TRIM(line->>'pjobcardno'), '') IS NOT NULL
      AND (c.ipr_uid IS NULL OR ipr.ipr_uid = c.ipr_uid)
    ORDER BY
      CASE WHEN c.ipr_uid IS NOT NULL AND ipr.ipr_uid = c.ipr_uid THEN 0 ELSE 1 END,
      COALESCE(ipr.approved, false) DESC,
      COALESCE(ipr.approved_at, ipr.updated_at, ipr.created_at) DESC NULLS LAST,
      ipr.ipr_uid DESC
    LIMIT 1
  ) ipr_jc ON TRUE
  WHERE c.out_uid IS NOT NULL
     OR LOWER(COALESCE(c.status, 'active')) IN ('out', 'consumed')
) jc ON TRUE`;

/** Latest approved reassign IPR line for a shop-floor coil (source JC + target JC + qty split). */
const COIL_REASSIGN_JOIN = `
LEFT JOIN LATERAL (
  SELECT
    ipr.ipr_uid AS reassign_ipr_uid,
    NULLIF(TRIM(line->>'pjobcardno'), '') AS reassign_target_pjobcardno,
    NULLIF(TRIM(line->>'macname'), '') AS reassign_target_macname,
    NULLIF(TRIM(prev.val->>'pjobcardno'), '') AS reassign_source_pjobcardno,
    NULLIF(TRIM(prev.val->>'macname'), '') AS reassign_source_macname,
    COALESCE(NULLIF(line->>'consumed_qty', '')::numeric, 0) AS reassign_consumed_qty,
    COALESCE(
      NULLIF(line->>'remaining_qty', '')::numeric,
      NULLIF(line->>'qty', '')::numeric,
      c.qty
    ) AS reassign_balance_qty
  FROM ${IPR_TABLE} ipr
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(ipr.coils) = 'array' THEN ipr.coils ELSE '[]'::jsonb END
  ) AS line
  LEFT JOIN LATERAL (
    SELECT p AS val
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ipr.previous_coils) = 'array' THEN ipr.previous_coils ELSE '[]'::jsonb END
    ) AS p
    WHERE LOWER(TRIM(p->>'coil_no_uid')) = LOWER(TRIM(c.coil_no_uid))
    LIMIT 1
  ) prev ON TRUE
  WHERE ipr.is_deleted = false
    AND ipr.request_type = 'consume'
    AND COALESCE(ipr.approved, false) = true
    AND LOWER(TRIM(line->>'coil_no_uid')) = LOWER(TRIM(c.coil_no_uid))
    AND COALESCE((line->>'reassign')::boolean, false) = true
    AND LOWER(COALESCE(c.status, 'active')) = 'out'
  ORDER BY ipr.approved_at DESC NULLS LAST, ipr.ipr_uid DESC
  LIMIT 1
) ipr_r ON TRUE`;

/** Shared SOURCE label for list/group queries (alias = coil table alias). */
export function coilSourceSql(alias = "c") {
  return `CASE
    WHEN ${alias}.sa_id IS NOT NULL THEN 'STOCK ADJUSTMENT'
    WHEN LOWER(COALESCE(${alias}.sa_entry_type, '')) = '${SA_ENTRY_TYPE.PRODUCTION_RETURN}' THEN 'PRODUCTION RETURN'
    WHEN NULLIF(TRIM(${alias}.mrn_uid::text), '') IS NOT NULL THEN 'MRN PORTAL'
    ELSE 'OTHER'
  END`;
}

/** Coils from MRN Portal sticker generation (excludes Stock Adjustment and Production Return). */
export function portalMrnCoilSql(alias = "c") {
  return portalMrnCoilBaseSql(alias);
}

/** List columns only (no remarks/audit) — faster reads from coil_table. */
const COIL_LAST_BY_SQL = `CASE
  WHEN c.updated_at IS NOT NULL AND (c.created_at IS NULL OR c.updated_at >= c.created_at)
    THEN COALESCE(NULLIF(TRIM(c.updated_by), ''), c.created_by)
  ELSE c.created_by
END`;

const COIL_LIST_SELECT = `c.coil_uid, c.coil_no_uid, c.mrn_uid, m.mrn_no, m.serial_no, ${COIL_HEAT_NO_SQL} AS heat_no, m.it_lot_no, m.item_dcode, m.item_code, m.item_desc, m.acc_code, m.acc_name, c.qty, ${COIL_INDEX_SELECT}, ${COIL_TOTAL_SELECT}, c.location_id, c.in_uid, ${COIL_REJECTION_FIELDS}, ${COIL_QC_UID_SELECT}, ${COIL_QC_STATUS_SELECT}, c.out_uid, c.sa_id, c.sa_entry_type, c.ipr_uid, jc.pjobcardno, jc.macname, jc.fg_item_code, jc.fg_item_desc, jc.shop_floor_at, c.status, c.created_at, ${COIL_LAST_BY_SQL} AS last_by, COALESCE(c.updated_at, c.created_at) AS last_at, ${coilSourceSql("c")}::varchar AS source`;

export const findCoilUidsByQcCheck = async (qc_uid) => {
  const id = Number(qc_uid);
  if (!Number.isFinite(id)) return [];
  const rows = await dbQuery(
    `SELECT coil_no_uid FROM ${TABLE} WHERE qc_uid = $1 AND is_deleted = false`,
    [id]
  );
  return rows.map((r) => r.coil_no_uid);
};

/** All live coils linked to a QC check — batch QC returns every coil with qty. */
export const findCoilsByQcCheckUid = async (qc_uid) => {
  const uids = await findCoilUidsByQcCheck(qc_uid);
  return fetchCoilsWithMrnDetails(uids);
};

async function fetchCoilsWithMrnDetails(coilNoUids = []) {
  const uids = (coilNoUids || []).map((uid) => String(uid || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `SELECT ${COIL_DETAIL_SELECT},
            ipr_r.reassign_ipr_uid,
            ipr_r.reassign_target_pjobcardno,
            ipr_r.reassign_target_macname,
            ipr_r.reassign_source_pjobcardno,
            ipr_r.reassign_source_macname,
            ipr_r.reassign_consumed_qty,
            ipr_r.reassign_balance_qty
     FROM ${TABLE} c
     ${COIL_MRN_JOIN}
     ${COIL_SA_BILL_JOIN}
     ${COIL_QC_JOIN}
     ${COIL_REJECTION_JOIN}
     ${COIL_JOB_CARD_JOIN}
     ${COIL_REASSIGN_JOIN}
     WHERE c.coil_no_uid = ANY($1::text[])
       AND c.is_deleted = false
     ORDER BY c.created_at ASC`,
    [uids]
  );
  return (rows || []).map(enrichCoilJobCardDisplay);
}

export const findCoils = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, sortBy = "coil_uid", order = "DESC", permission = {} } = options;
  const values = [];
  let i = 1;
  const conditions = ["c.is_deleted = false"];
  const journeyMode = hasCoilJourneyFilter(filters);
  const operationalLookup =
    filters.coil_area === true ||
    filters.coil_area === "true" ||
    filters.only_stock === true ||
    filters.only_stock === "true" ||
    filters.shop_floor === true ||
    filters.shop_floor === "true" ||
    (filters.out_uid != null && filters.out_uid !== "") ||
    (filters.in_uid != null && filters.in_uid !== "") ||
    (filters.rm_uid != null && filters.rm_uid !== "") ||
    (filters.qc_uid != null && filters.qc_uid !== "") ||
    (filters.qc_check_uid != null && filters.qc_check_uid !== "") ||
    (filters.sa_id != null && filters.sa_id !== "") ||
    (filters.adjustment_id != null && filters.adjustment_id !== "");

  // Register date window only — never clamp stock pickers / linked-coil lookups
  if (!journeyMode && !operationalLookup && permission?.can_view_days > 0) {
    conditions.push(`c.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  const status = filters.status != null && String(filters.status).trim() !== "" ? String(filters.status).trim().toLowerCase() : null;

  if (filters.coil_area === true || filters.coil_area === "true") {
    conditions.push("c.location_id IS NULL");
    // Physical unassigned only — QC pass/fail/draft must NOT remove coils from Store In queue
    conditions.push(`(${coilAreaPhysicalStatusSql("c")})`);
    conditions.push(coilAreaEligibleSql("c"));
  }
  if (filters.stored === true || filters.stored === "true") {
    conditions.push("c.location_id IS NOT NULL");
  }

  /** Issued to shop floor (Store Out) — not SA-minus write-offs that lack out_uid. */
  if (filters.shop_floor === true || filters.shop_floor === "true") {
    conditions.push(`LOWER(COALESCE(c.status, 'active')) = 'out'`);
    conditions.push(`c.out_uid IS NOT NULL`);
  }

  if (filters.only_stock === true || filters.only_stock === "true") {
    conditions.push(COIL_QC_PASSED_COND);
  }
  if (status) {
    values.push(status);
    conditions.push(`COALESCE(c.status, 'active') = $${i++}`);
  }
  if (filters.rm_uid != null && filters.rm_uid !== "") {
    values.push(Number(filters.rm_uid));
    conditions.push(`c.rm_uid = $${i++}`);
  } else if (filters.qc_reject_uid != null && filters.qc_reject_uid !== "") {
    values.push(Number(filters.qc_reject_uid));
    conditions.push(`c.rm_uid = $${i++}`);
  }
  if (filters.qc_uid != null && filters.qc_uid !== "") {
    values.push(Number(filters.qc_uid));
    conditions.push(`c.qc_uid = $${i++}`);
  } else if (filters.qc_check_uid != null && filters.qc_check_uid !== "") {
    values.push(Number(filters.qc_check_uid));
    conditions.push(`c.qc_uid = $${i++}`);
  }
  if (filters.out_uid != null && filters.out_uid !== "") {
    values.push(Number(filters.out_uid));
    conditions.push(`c.out_uid = $${i++}`);
  }
  if (filters.mrn_or_match === true || filters.mrn_or_match === "true") {
    const orParts = [];
    const uidList = Array.isArray(filters.mrn_uid_list)
      ? filters.mrn_uid_list.map((u) => String(u || "").trim()).filter(Boolean)
      : [];
    const singleUid =
      filters.mrn_uid != null && String(filters.mrn_uid).trim() !== ""
        ? String(filters.mrn_uid).trim()
        : "";
    const uids = [...new Set([...uidList, ...(singleUid ? [singleUid] : [])])];
    const no =
      filters.mrn_no != null && String(filters.mrn_no).trim() !== ""
        ? String(filters.mrn_no).trim()
        : "";
    for (const uid of uids) {
      values.push(uid);
      orParts.push(`c.mrn_uid = $${i++}`);
      values.push(`%${uid}`);
      orParts.push(`c.mrn_uid LIKE $${i++}`);
    }
    if (no) {
      values.push(no);
      orParts.push(`m.mrn_no::text = $${i++}`);
    }
    if (orParts.length) {
      conditions.push(`(${orParts.join(" OR ")})`);
    }
  } else {
    if (filters.mrn_uid != null && filters.mrn_uid !== "") {
      values.push(String(filters.mrn_uid).trim());
      conditions.push(`c.mrn_uid = $${i++}`);
    }
    // legacy alias
    if (filters.mrn_id != null && filters.mrn_id !== "" && (filters.mrn_uid == null || filters.mrn_uid === "")) {
      values.push(String(filters.mrn_id).trim());
      conditions.push(`c.mrn_uid = $${i++}`);
    }
    if (filters.mrn_no != null && filters.mrn_no !== "") {
      values.push(String(filters.mrn_no).trim());
      conditions.push(`m.mrn_no::text = $${i++}`);
    }
  }
  if (filters.source != null && String(filters.source).trim() !== "") {
    const src = String(filters.source).trim().toUpperCase();
    if (src === "PRODUCTION RETURN") {
      conditions.push(
        `LOWER(COALESCE(c.sa_entry_type, '')) = '${SA_ENTRY_TYPE.PRODUCTION_RETURN}'`
      );
    } else if (src.startsWith("STOCK ADJ")) {
      conditions.push(`c.sa_id IS NOT NULL`);
    } else if (src === "MRN PORTAL") {
      conditions.push(`c.sa_id IS NULL`);
      conditions.push(
        `LOWER(COALESCE(c.sa_entry_type, '')) <> '${SA_ENTRY_TYPE.PRODUCTION_RETURN}'`
      );
      conditions.push(`NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL`);
    }
  }
  if (filters.heat_no != null && String(filters.heat_no).trim() !== "") {
    values.push(String(filters.heat_no).trim());
    const idx = i++;
    conditions.push(
      `(UPPER(trim(m.heat_no)) = UPPER(trim($${idx})) OR UPPER(trim(m.it_lot_no)) = UPPER(trim($${idx})))`
    );
  }
  if (filters.in_uid != null && filters.in_uid !== "") {
    values.push(Number(filters.in_uid));
    conditions.push(`c.in_uid = $${i++}`);
  }
  if (filters.location_id != null && filters.location_id !== "") {
    values.push(Number(filters.location_id));
    conditions.push(`c.location_id = $${i++}`);
  }
  if (filters.item_code != null && String(filters.item_code).trim() !== "") {
    values.push(String(filters.item_code).trim());
    conditions.push(`UPPER(trim(m.item_code)) = UPPER(trim($${i++}))`);
  }
  if (filters.item_dcode != null && filters.item_dcode !== "") {
    values.push(Number(filters.item_dcode));
    conditions.push(`m.item_dcode = $${i++}`);
  }
  if (filters.pjobcardno != null && String(filters.pjobcardno).trim() !== "") {
    values.push(`%${String(filters.pjobcardno).trim()}%`);
    conditions.push(`COALESCE(jc.pjobcardno, '') ILIKE $${i++}`);
  }
  if (filters.macname != null && String(filters.macname).trim() !== "") {
    values.push(`%${String(filters.macname).trim()}%`);
    conditions.push(`COALESCE(jc.macname, '') ILIKE $${i++}`);
  }

  if (journeyMode) {
    i = appendCoilJourneyCondition(conditions, values, filters.journey, i, "m");
  } else {
    if (filters.from_date) {
      values.push(filters.from_date);
      conditions.push(`c.created_at >= $${i++}::timestamp`);
    }
    if (filters.to_date) {
      values.push(filters.to_date);
      conditions.push(`c.created_at <= $${i++}::timestamp`);
    }
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      c.coil_uid::text ILIKE $${idx} OR
      c.coil_no_uid ILIKE $${idx} OR
      COALESCE(c.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(m.heat_no,'') ILIKE $${idx} OR
      COALESCE(m.item_code,'') ILIKE $${idx} OR
      COALESCE(m.item_desc,'') ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx} OR
      COALESCE(jc.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} c ${COIL_MRN_JOIN} ${COIL_QC_JOIN} ${COIL_REJECTION_JOIN} ${COIL_JOB_CARD_JOIN} ${COIL_REASSIGN_JOIN} ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const sortExpr = {
    coil_uid: "c.coil_uid",
    coil_no_uid: "c.coil_no_uid",
    created_at: "c.created_at",
    mrn_no: "m.mrn_no",
    heat_no: "m.heat_no",
    item_code: "m.item_code",
    qty: "c.qty",
    coil_index: coilIndexFromUidSql("c"),
  }[sortBy] || "c.coil_uid";
  const sortOrder = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(
    `SELECT ${COIL_LIST_SELECT},
            ipr_r.reassign_ipr_uid,
            ipr_r.reassign_target_pjobcardno,
            ipr_r.reassign_target_macname,
            ipr_r.reassign_source_pjobcardno,
            ipr_r.reassign_source_macname,
            ipr_r.reassign_consumed_qty,
            ipr_r.reassign_balance_qty,
            lm.location_no,
            lm.rack_no,
            lm.shelf_no AS row_no
     FROM ${TABLE} c
     ${COIL_MRN_JOIN}
     ${COIL_QC_JOIN}
     ${COIL_REJECTION_JOIN}
     ${COIL_JOB_CARD_JOIN}
     ${COIL_REASSIGN_JOIN}
     LEFT JOIN ${IT.LOCATION_MASTER} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     ${where}
     ORDER BY ${sortExpr} ${sortOrder} NULLS LAST
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: (rows || []).map(enrichCoilJobCardDisplay),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
};

/** Latest issue-request machine per coil — for pending store-in display only. */
export async function findMacnamesForCoilUids(coilNoUids = []) {
  const uids = [...new Set((coilNoUids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uids.length) return new Map();
  const rows = await dbQuery(
    `SELECT c.coil_no_uid, jc.macname
     FROM ${TABLE} c
     ${COIL_JOB_CARD_JOIN}
     WHERE c.coil_no_uid = ANY($1::text[])
       AND c.is_deleted = false`,
    [uids]
  );
  const map = new Map();
  for (const r of rows || []) {
    const uid = String(r.coil_no_uid || "").trim();
    const mac = String(r.macname || "").trim();
    if (uid && mac) map.set(uid, mac);
  }
  return map;
}

/** Machine by job-card no — Register IPR when coil join has JC but empty macname. */
export async function findMacnamesForJobCards(jobCardNos = []) {
  const raw = [...new Set((jobCardNos || []).map((j) => String(j || "").trim()).filter(Boolean))];
  if (!raw.length) return new Map();
  const normalized = raw.map((j) => j.replace(/^JC[\s\-]*/i, "").trim().toUpperCase()).filter(Boolean);
  if (!normalized.length) return new Map();

  const rows = await dbQuery(
    `SELECT
       UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')) AS jc_key,
       NULLIF(TRIM(jc.macname), '') AS macname
     FROM ${T.ISSUE_REQUEST_JOB_CARD} jc
     WHERE jc.is_deleted = false
       AND NULLIF(TRIM(jc.macname), '') IS NOT NULL
       AND UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')) = ANY($1::text[])
     ORDER BY jc.id DESC`,
    [normalized]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.jc_key || "").trim().toUpperCase();
    const mac = String(r.macname || "").trim();
    if (key && mac && !map.has(key)) map.set(key, mac);
  }
  return map;
}

export const findCoilByUid = async (coil_no_uid) => {
  const val = String(coil_no_uid || "").trim();
  if (!val) return null;
  const [row] = await dbQuery(
    `SELECT ${COIL_DETAIL_SELECT},
            ipr_r.reassign_ipr_uid,
            ipr_r.reassign_target_pjobcardno,
            ipr_r.reassign_target_macname,
            ipr_r.reassign_source_pjobcardno,
            ipr_r.reassign_source_macname,
            ipr_r.reassign_consumed_qty,
            ipr_r.reassign_balance_qty,
            lm.location_no,
            lm.rack_no,
            lm.shelf_no AS row_no
     FROM ${TABLE} c
     ${COIL_MRN_JOIN}
     ${COIL_SA_BILL_JOIN}
     ${COIL_QC_JOIN}
     ${COIL_REJECTION_JOIN}
     ${COIL_JOB_CARD_JOIN}
     ${COIL_REASSIGN_JOIN}
     LEFT JOIN ${IT.LOCATION_MASTER} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE ${sqlStickerUidEquals("c.coil_no_uid", "$1")} AND c.is_deleted = false
     ORDER BY
       CASE
         WHEN trim(c.coil_no_uid::text) = trim($1::text) THEN 0
         WHEN lower(trim(c.coil_no_uid::text)) = lower(trim($1::text)) THEN 1
         ELSE 2
       END,
       c.coil_uid DESC
     LIMIT 1`,
    [val]
  );
  return row ? enrichCoilJobCardDisplay(row) : null;
};

export const findCoilsByUids = async (uids = []) => {
  const list = [...new Set((uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!list.length) return [];
  const placeholders = list.map((_, i) => `$${i + 1}`).join(", ");
  return dbQuery(
    `SELECT c.coil_no_uid, c.coil_uid, m.mrn_no, c.qty, m.heat_no, m.item_code, c.status
     FROM ${TABLE} c
     ${COIL_MRN_JOIN}
     WHERE c.is_deleted = false AND c.coil_no_uid IN (${placeholders})`,
    list
  );
};

export const countCoilsForMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE}
     WHERE mrn_uid = $1 AND is_deleted = false AND sa_id IS NULL`,
    [uid]
  );
  return Number(row?.count || 0);
};

/**
 * Sum MRN-allocated coil qty (MRN Portal + approved SA Add).
 * Uses current coil.qty plus partial IPR consume logged in coil transactions —
 * partial consume reduces coil.qty but the consumed portion still counts toward the MRN cap.
 */
export const sumCoilQtyForMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT
       COALESCE((
         SELECT SUM(COALESCE(c.qty, 0))
         FROM ${TABLE} c
         WHERE c.is_deleted = false
           AND TRIM(c.mrn_uid) = $1
       ), 0)::float AS coil_qty,
       COALESCE((
         SELECT SUM(COALESCE((e->>'qty')::float, 0))
         FROM ${T.COIL_TRANSACTION} tx
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tx.details->'coil_sticker_entries', '[]'::jsonb)) e
         INNER JOIN ${TABLE} c ON c.coil_no_uid = TRIM(e->>'coil_no_uid')
           AND c.is_deleted = false
           AND TRIM(c.mrn_uid) = $1
         WHERE tx.transaction_type = $2
           AND COALESCE(tx.details->>'partial', '') IN ('true', '1')
       ), 0)::float AS partial_consumed_qty`,
    [uid, COIL_TX_TYPES.CONSUME]
  );
  const total = Number(row?.coil_qty || 0) + Number(row?.partial_consumed_qty || 0);
  return roundCoilQty(total);
};

/** Approved Stock Adjustment Add coil qty — credited back when editing that adjustment. */
export const sumApprovedAddCoilQtyForAdjustment = async (adjustmentId) => {
  const id = Number(adjustmentId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const [row] = await dbQuery(
    `SELECT COALESCE(SUM(COALESCE(qty, 0)), 0)::float AS total
     FROM ${TABLE}
     WHERE is_deleted = false
       AND sa_id = $1
       AND LOWER(COALESCE(sa_entry_type, 'stock_in')) = 'stock_in'`,
    [id]
  );
  return roundCoilQty(Number(row?.total || 0));
};

export const insertBulkCoils = async (rows = []) => {
  const created = [];
  for (const r of rows) {
    const [row] = await dbQuery(
      `INSERT INTO ${TABLE}
       (coil_no_uid, mrn_uid, qty, created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [
        r.coil_no_uid,
        r.mrn_uid ?? r.uid ?? null,
        r.qty,
        r.created_by,
      ]
    );
    created.push(enrichCoilUidMeta(row));
  }
  return created;
};

export const updateCoilsAfterInward = async (in_uid, location_id, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || [])
    .map((u) => {
      if (u == null) return "";
      if (typeof u === "object") return String(u.coil_no_uid || "").trim();
      return String(u).trim();
    })
    .filter(Boolean);
  if (!uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = $1,
         in_uid = $2,
         updated_by = $3,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($4::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
       AND out_uid IS NULL`,
    [location_id, in_uid, userName ?? null, uids]
  );
};

function inwardCoilUidList(coils = []) {
  return (coils || [])
    .map((u) => {
      if (u == null) return "";
      if (typeof u === "object") return String(u.coil_no_uid || "").trim();
      return String(u).trim();
    })
    .filter(Boolean);
}

/**
 * Sync store-in register without wiping every coil first.
 * Detaches only active coils removed from the payload, then assigns locations.
 */
export const syncInwardRegisterCoils = async (in_uid, locations = [], userName) => {
  const id = Number(in_uid);
  if (!Number.isFinite(id)) return;

  const keepUids = [
    ...new Set((locations || []).flatMap((loc) => inwardCoilUidList(loc.coils))),
  ];

  await withTransaction(async (client) => {
    if (keepUids.length) {
      await client.query(
        `UPDATE ${TABLE}
         SET location_id = NULL,
             in_uid = NULL,
             updated_by = $2,
             updated_at = NOW()
         WHERE in_uid = $1
           AND is_deleted = false
           AND COALESCE(status, 'active') = 'active'
           AND NOT (coil_no_uid = ANY($3::text[]))`,
        [id, userName ?? null, keepUids]
      );
    } else {
      await client.query(
        `UPDATE ${TABLE}
         SET location_id = NULL,
             in_uid = NULL,
             updated_by = $2,
             updated_at = NOW()
         WHERE in_uid = $1
           AND is_deleted = false
           AND COALESCE(status, 'active') = 'active'`,
        [id, userName ?? null]
      );
    }

    for (const loc of locations || []) {
      const lid = Number(loc.location_id);
      if (!Number.isFinite(lid) || lid <= 0) continue;
      const uids = inwardCoilUidList(loc.coils);
      if (!uids.length) continue;
      await client.query(
        `UPDATE ${TABLE}
         SET location_id = $1,
             in_uid = $2,
             updated_by = $3,
             updated_at = NOW()
         WHERE coil_no_uid = ANY($4::text[])
           AND is_deleted = false
           AND COALESCE(status, 'active') = 'active'
           AND out_uid IS NULL`,
        [lid, id, userName ?? null, uids]
      );
    }
  });
};

/** Return coils to Coil Area when a Store-In is deleted. */
export const clearCoilsForInward = async (in_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE in_uid = $1
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'`,
    [Number(in_uid), userName ?? null]
  );
};

/** Clear QC check link on coil(s) so they return to Pending / Unapproved queue. */
export const clearCoilQcLink = async (coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET qc_uid = NULL,
         status = CASE
           WHEN rm_uid IS NULL
             AND ipr_uid IS NULL
             AND LOWER(COALESCE(status, 'active')) = 'rejected'
           THEN 'active'
           ELSE status
         END,
         updated_by = $1,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($2::text[])
       AND is_deleted = false`,
    [userName ?? null, uids]
  );
};

/**
 * Hold coil(s) after authorized QC fail — Rejection Pending until Store Out.
 * Unassigned coils stay active so they remain in Store In > Unassigned until store-out.
 * Racked coils use status=rejected to block issue until rejection store-out.
 */
export const markCoilsQcFailPending = async (qc_uid, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET qc_uid = $1,
         status = CASE
           WHEN location_id IS NOT NULL THEN 'rejected'
           ELSE 'active'
         END,
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND rm_uid IS NULL
       AND ipr_uid IS NULL
       AND (
         COALESCE(status, 'active') = 'active'
         OR LOWER(COALESCE(status, 'active')) = 'rejected'
       )
     RETURNING coil_no_uid`,
    [Number(qc_uid), userName ?? null, uids]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/**
 * QC authorized pass — coil returns to issueable stock.
 * Restores active even if a prior fail approval had set status=rejected.
 */
export const markCoilsQcPassed = async (qc_uid, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET qc_uid = $1,
         rm_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
     RETURNING coil_no_uid`,
    [Number(qc_uid), userName ?? null, uids]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/** Link coil(s) to a QC Check header (status lives on qc_check row). */
export const linkCoilsToQcCheck = async (qc_uid, coil_no_uids = [], _qc_check_status, userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET qc_uid = $1,
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false`,
    [qc_uid, userName ?? null, coil_no_uids]
  );
};

/** Restore coils held for an in-process rejection (not yet in qc_rejection register). */
export const revertCoilsInProcessRejection = async (ipr_uid, userName) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET ipr_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE ipr_uid = $1
       AND is_deleted = false
       AND LOWER(COALESCE(status, 'active')) = 'rejected'
       AND rm_uid IS NULL
     RETURNING coil_no_uid`,
    [id, userName ?? null]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/** After IPR rejection hold is released — restore shop-floor out when Store In is still pending. */
export const restoreCoilsToShopFloorOut = async (coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET status = 'out',
         ipr_uid = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[])
       AND is_deleted = false
       AND LOWER(COALESCE(status, 'active')) IN ('active', 'rejected')
     RETURNING coil_no_uid`,
    [uids, userName ?? null]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/**
 * Store In receive wins over an in-process rejection hold on the same coil —
 * release hold and restore shop-floor out so receive can proceed.
 */
export const releaseCoilFromIprRejectionHoldForStoreIn = async (coil_no_uid, userName) => {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET ipr_uid = NULL,
         location_id = NULL,
         in_uid = NULL,
         out_uid = NULL,
         status = 'out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = $1
       AND is_deleted = false
       AND LOWER(COALESCE(status, 'active')) = 'rejected'
       AND rm_uid IS NULL
     RETURNING coil_no_uid, ipr_uid AS released_from_ipr_uid`,
    [uid, userName ?? null]
  );
  if (!rows?.[0]) return null;
  const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
  return detail ? { ...detail, released_from_ipr_uid: rows[0].released_from_ipr_uid ?? null } : rows[0];
};

/**
 * Hold coils for an approved in-process rejection until RM Rejection → Store Out.
 * Removes them from issue / store stock (status rejected, linked to ipr_uid).
 */
export const markCoilsInProcessRejectionPending = async (ipr_uid, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         out_uid = NULL,
         ipr_uid = $1,
         status = 'rejected',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND rm_uid IS NULL
       AND (
         LOWER(COALESCE(status, 'active')) = 'active'
         OR (
           LOWER(COALESCE(status, 'active')) = 'out'
           AND out_uid IS NOT NULL
         )
         OR (
           LOWER(COALESCE(status, 'active')) = 'rejected'
           AND ipr_uid = $1
         )
       )
     RETURNING coil_no_uid`,
    [Number(ipr_uid), userName ?? null, uids]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/** Link coils to rejection register — hold for Store Out scan (no out_uid yet). */
export const linkCoilsToRejectionRegister = async (
  rm_uid,
  coil_no_uids = [],
  userName,
  { fromIprUid = null } = {}
) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return;
  const iprId = Number(fromIprUid);
  const hasIpr = Number.isFinite(iprId) && iprId > 0;
  const statusClause = hasIpr
    ? `(COALESCE(status, 'active') = 'active' OR (LOWER(COALESCE(status, 'active')) = 'rejected' AND ipr_uid = $4 AND (rm_uid IS NULL OR rm_uid = $1)))`
    : `(COALESCE(status, 'active') = 'active' OR (LOWER(COALESCE(status, 'active')) = 'rejected' AND (rm_uid IS NULL OR rm_uid = $1) AND ipr_uid IS NULL))`;
  const params = [Number(rm_uid), userName ?? null, uids];
  if (hasIpr) params.push(iprId);
  await dbQuery(
    `UPDATE ${TABLE}
     SET rm_uid = $1,
         status = 'rejected',
         out_uid = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND ${statusClause}`,
    params
  );
};

/** Mark coils QC-rejected — keep rack location until Store Out removes stock. */
export const updateCoilsAfterQcReject = async (rm_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET rm_uid = $1,
         out_uid = NULL,
         status = 'rejected',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND (
         COALESCE(status, 'active') = 'active'
         OR (
           LOWER(COALESCE(status, 'active')) = 'rejected'
           AND rm_uid IS NULL
           AND ipr_uid IS NULL
         )
       )`,
    [rm_uid, userName ?? null, coil_no_uids]
  );
};

/** Restore coils after RM Rejection register delete — back to QC fail / IPR pending hold. */
export const revertCoilsFromRejectionRegister = async (rm_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET rm_uid = NULL,
         status = 'rejected',
         updated_by = $2,
         updated_at = NOW()
     WHERE rm_uid = $1 AND is_deleted = false`,
    [Number(rm_uid), userName ?? null]
  );
};

/** Restore QC-rejected coils to Coil Area — clear QC link so they reappear as virtual pending. */
export const clearCoilsForQcReject = async (rm_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET rm_uid = NULL,
         qc_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE rm_uid = $1 AND is_deleted = false AND status = 'rejected'`,
    [Number(rm_uid), userName ?? null]
  );
};

/**
 * In-process consumption — coils fully used at the machine leave stock.
 * Only active coils move, so a repeated approve cannot double-consume.
 */
export const markCoilsConsumed = async (ipr_uid, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         out_uid = NULL,
         ipr_uid = $1,
         status = 'consumed',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'out'
     RETURNING coil_no_uid, qty, mrn_uid`,
    [Number(ipr_uid), userName ?? null, uids]
  );
  return rows ?? [];
};

/** Undo a consume request — its coils return to the Coil Area as active. */
export const revertCoilsConsumed = async (ipr_uid, userName) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET ipr_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE ipr_uid = $1 AND is_deleted = false AND status = 'consumed'
     RETURNING coil_no_uid`,
    [id, userName ?? null]
  );
  return fetchCoilsWithMrnDetails(rows?.map((row) => row.coil_no_uid) ?? []);
};

/**
 * In-process consume — full or partial used qty per coil.
 * Full: coil → consumed. Partial: log used qty, reduce coil qty, keep on shop floor (out) for Store In later.
 */
export const processConsumeCoils = async (ipr_uid, coilLines = [], userName) => {
  const fullConsumed = [];
  const partialConsumed = [];

  for (const line of coilLines || []) {
    const uid = String(line?.coil_no_uid || "").trim();
    if (!uid) continue;

    const original = Number(line.original_qty ?? line.qty) || 0;
    const used =
      line.consumed_qty != null ? Number(line.consumed_qty) || 0 : original;
    const balance =
      line.remaining_qty != null
        ? Number(line.remaining_qty) || 0
        : Math.max(0, original - used);

    if (used < 0) {
      throw Object.assign(
        new Error(`Used qty for coil ${uid} must be greater than 0.`),
        { status: 400 }
      );
    }
    if (used > original) {
      throw Object.assign(
        new Error(`Used qty for coil ${uid} cannot exceed issued qty (${original}).`),
        { status: 400 }
      );
    }

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (!isIssuedToShopFloor(coil)) {
      throw Object.assign(
        new Error(
          isSaMinusWriteOff(coil)
            ? `Coil ${uid} was removed by stock adjustment and is not on the shop floor.`
            : `Coil ${uid} is not on the shop floor (status: ${status}).`
        ),
        { status: 400 }
      );
    }

    if (balance <= 0 || used >= original) {
      const rows = await dbQuery(
        `UPDATE ${TABLE}
         SET location_id = NULL,
             in_uid = NULL,
             out_uid = NULL,
             ipr_uid = $1,
             status = 'consumed',
             updated_by = $2,
             updated_at = NOW()
         WHERE coil_no_uid = $3
           AND is_deleted = false
           AND status = 'out'
         RETURNING coil_no_uid`,
        [Number(ipr_uid), userName ?? null, uid]
      );
      if (rows?.[0]) {
        const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
        fullConsumed.push({
          ...(detail ?? rows[0]),
          consumed_qty: original,
          original_qty: original,
          partial: false,
        });
      }
      continue;
    }

    const rows = await dbQuery(
      `UPDATE ${TABLE}
       SET qty = $1,
           updated_by = $2,
           updated_at = NOW()
       WHERE coil_no_uid = $3
         AND is_deleted = false
         AND status = 'out'
       RETURNING coil_no_uid`,
      [balance, userName ?? null, uid]
    );
    if (rows?.[0]) {
      const isReassign = line.reassign === true;
      const targetJc = String(line.pjobcardno || "").trim();
      if (isReassign && targetJc && coil.out_uid != null) {
        await dbQuery(
          `UPDATE ${OUT_ENTRY}
           SET pjobcardno = $1,
               updated_at = NOW()
           WHERE out_uid = $2
             AND is_deleted = false`,
          [targetJc, Number(coil.out_uid)]
        );
      }
      const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
      partialConsumed.push({
       ...(detail ?? rows[0]),
       consumed_qty: used,
       original_qty: original,
       remaining_qty: balance,
       partial: true,
       reassign: isReassign,
      });
    }
  }

  return { fullConsumed, partialConsumed };
};

/**
 * Store-in return from machine — partial or full.
 * Each line: original_qty (issued), remaining_qty (return to stock), consumed = original - remaining.
 */
export const processStoreInReturnCoils = async (ipr_uid, coilLines = [], userName) => {
  const returned = [];
  const consumed = [];

  for (const line of coilLines || []) {
    const uid = String(line?.coil_no_uid || "").trim();
    if (!uid) continue;

    const original = Number(line.original_qty ?? line.qty) || 0;
    const remaining = Number(line.remaining_qty ?? line.qty) || 0;
    const used =
      line.consumed_qty != null
        ? Number(line.consumed_qty) || 0
        : Math.max(0, original - remaining);

    if (remaining > original) {
      throw Object.assign(
        new Error(`Return qty for coil ${uid} cannot exceed issued qty (${original}).`),
        { status: 400 }
      );
    }

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status !== "out") {
      throw Object.assign(
        new Error(`Coil ${uid} is not out at the machine (status: ${status}).`),
        { status: 400 }
      );
    }

    if (remaining <= 0) {
      const rows = await dbQuery(
        `UPDATE ${TABLE}
         SET location_id = NULL,
             in_uid = NULL,
             out_uid = NULL,
             ipr_uid = $1,
             status = 'consumed',
             updated_by = $2,
             updated_at = NOW()
         WHERE coil_no_uid = $3
           AND is_deleted = false
           AND status = 'out'
         RETURNING coil_no_uid`,
        [Number(ipr_uid), userName ?? null, uid]
      );
      if (rows?.[0]) {
        const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
        consumed.push({
         ...(detail ?? rows[0]),
         consumed_qty: original,
         original_qty: original,
         partial: false,
        });
      }
      continue;
    }

    const rows = await dbQuery(
      `UPDATE ${TABLE}
       SET location_id = NULL,
           in_uid = NULL,
           out_uid = NULL,
           ipr_uid = NULL,
           sa_entry_type = $4,
           status = 'active',
           qty = $1,
           updated_by = $2,
           updated_at = NOW()
       WHERE coil_no_uid = $3
         AND is_deleted = false
         AND status = 'out'
       RETURNING coil_no_uid`,
      [remaining, userName ?? null, uid, SA_ENTRY_TYPE.PRODUCTION_RETURN]
    );
    if (rows?.[0]) {
      const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
      returned.push({
       ...(detail ?? rows[0]),
       original_qty: original,
       consumed_qty: used,
       remaining_qty: remaining,
      });
      if (used > 0) {
       consumed.push({
         coil_no_uid: uid,
         qty: used,
         mrn_no: detail?.mrn_no ?? null,
         consumed_qty: used,
         original_qty: original,
         partial: true,
       });
      }
    }
  }

  return { returned, consumed };
};

/** Undo an approved store-in return — put coils back out at the machine. */
export const revertStoreInReturnCoils = async (ipr_uid, previousCoils = [], userName) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return { restored: [] };
  const restored = [];

  for (const line of previousCoils || []) {
    const uid = String(line?.coil_no_uid || "").trim();
    if (!uid) continue;
    const original = Number(line.original_qty ?? line.qty) || 0;
    const outUid = line.out_uid != null ? Number(line.out_uid) : null;
    const sourceJc = String(line?.pjobcardno || "").trim();

    const coil = await findCoilByUid(uid);
    if (!coil) continue;

    const status = String(coil.status || "active").toLowerCase();
    if (status === "consumed" && Number(coil.ipr_uid) === id) {
      const rows = await dbQuery(
        `UPDATE ${TABLE}
         SET ipr_uid = NULL,
             status = 'out',
             out_uid = COALESCE($1, out_uid),
             qty = $2,
             updated_by = $3,
             updated_at = NOW()
         WHERE coil_no_uid = $4 AND is_deleted = false AND status = 'consumed'
         RETURNING coil_no_uid`,
        [outUid, original, userName ?? null, uid]
      );
      if (rows?.[0]) {
        const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
        restored.push(detail ?? rows[0]);
      }
    } else if (status === "active") {
      const rows = await dbQuery(
        `UPDATE ${TABLE}
         SET status = 'out',
             out_uid = COALESCE($1, out_uid),
             qty = $2,
             sa_entry_type = NULL,
             updated_by = $3,
             updated_at = NOW()
         WHERE coil_no_uid = $4 AND is_deleted = false AND status = 'active'
         RETURNING coil_no_uid`,
        [outUid, original, userName ?? null, uid]
      );
      if (rows?.[0]) {
        const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
        restored.push(detail ?? rows[0]);
      }
    } else if (status === "out") {
      const rows = await dbQuery(
        `UPDATE ${TABLE}
         SET qty = $1,
             out_uid = COALESCE($2, out_uid),
             updated_by = $3,
             updated_at = NOW()
         WHERE coil_no_uid = $4 AND is_deleted = false AND status = 'out'
         RETURNING coil_no_uid`,
        [original, outUid, userName ?? null, uid]
      );
      if (rows?.[0]) {
        const detail = (await fetchCoilsWithMrnDetails([rows[0].coil_no_uid]))[0] ?? null;
        restored.push(detail ?? rows[0]);
      }
    }

    // Reassign approve overwrites Store Out JC to target; undo must put source JC back
    // so IR machine join works again (macname is not stored on out_entry).
    const restoreOutUid = outUid ?? (coil.out_uid != null ? Number(coil.out_uid) : null);
    if (restoreOutUid && sourceJc) {
      await dbQuery(
        `UPDATE ${OUT_ENTRY}
         SET pjobcardno = $1,
             updated_at = NOW()
         WHERE out_uid = $2
           AND is_deleted = false`,
        [sourceJc, restoreOutUid]
      );
    }
  }

  return { restored };
};

/** Job Card Store Out — link coils (IMS-style: keep in_uid + location on register). */
export const updateCoilsAfterJobCardStoreOut = async (out_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = $1,
         status = 'out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
       AND out_uid IS NULL`,
    [out_uid, userName ?? null, coil_no_uids]
  );
};

/** Store Out — link coils to out entry (IMS-style: keep in_uid + location for historical register). */
export const updateCoilsAfterStoreOut = async (out_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = $1,
         status = 'out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
       AND out_uid IS NULL`,
    [out_uid, userName ?? null, coil_no_uids]
  );
};

/**
 * RM Rejection Store Out — final returned step.
 * Keeps the coil linked to the rejection and removes it from the active shop-floor state.
 */
export const updateCoilsAfterRejectionStoreOut = async (out_uid, rm_uid, coil_no_uids = [], userName, { fromIprUid = null } = {}) => {  if (!coil_no_uids.length) return;
  const iprId = Number(fromIprUid);
  const hasIpr = Number.isFinite(iprId) && iprId > 0;
  const statusClause = hasIpr
    ? `(LOWER(COALESCE(status, 'active')) IN ('active', 'rejected', 'out', 'returned') AND ipr_uid = $5 AND (rm_uid IS NULL OR rm_uid = $2))`
    : `(LOWER(COALESCE(status, 'active')) IN ('active', 'rejected', 'out', 'returned') AND (rm_uid IS NULL OR rm_uid = $2) AND ipr_uid IS NULL)`;
  const params = [out_uid, rm_uid, userName ?? null, coil_no_uids];
  if (hasIpr) params.push(iprId);
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         out_uid = $1,
         rm_uid = $2,
         status = 'returned',
         updated_by = $3,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($4::text[])
       AND is_deleted = false
       AND ${statusClause}`,
    params
  );
};

/** Restore Store-Out coils to Coil Area. */
export const clearCoilsForStoreOut = async (out_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE out_uid = $1 AND is_deleted = false AND status = 'out'`,
    [Number(out_uid), userName ?? null]
  );
};

/**
 * Undo RM Rejection Store Out — keep rejection link, restore coil as rejected.
 */
export const clearCoilsForRejectionStoreOut = async (out_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = NULL,
         status = 'rejected',
         updated_by = $2,
         updated_at = NOW()
     WHERE out_uid = $1 AND is_deleted = false AND LOWER(COALESCE(status, 'active')) IN ('returned', 'out')`,
    [Number(out_uid), userName ?? null]
  );
};

export const incrementCoilDownloadCount = async (coil_no_uids = []) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET download_count = COALESCE(download_count, 0) + 1,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[]) AND is_deleted = false`,
    [uids]
  );
};

/** Coils already Store-In'd for this MRN (cannot cancel portal stickers). */
export const countStoreInCoilsForMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS cnt
     FROM ${TABLE}
     WHERE mrn_uid = $1 AND is_deleted = false AND location_id IS NOT NULL AND sa_id IS NULL`,
    [uid]
  );
  return Number(row?.cnt || 0);
};

/** Soft-delete MRN Portal coil stickers for an MRN (Cancel stickers). SA coils are kept. */
export const softDeleteCoilsByMrn = async (mrn_uid, deleted_by = null) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
     WHERE mrn_uid = $1 AND is_deleted = false AND sa_id IS NULL
     RETURNING coil_uid`,
    [uid, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Permanently remove MRN Portal coils (incl. prior soft-deleted) so UIDs can be regenerated. */
export const hardDeleteCoilsByMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const rows = await dbQuery(
    `DELETE FROM ${TABLE}
     WHERE mrn_uid = $1 AND sa_id IS NULL
     RETURNING coil_uid`,
    [uid]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Any coil rows still linked to this MRN (portal or Stock Adjustment). */
export const countCoilsByMrnUid = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS cnt FROM ${TABLE} WHERE mrn_uid = $1`,
    [uid]
  );
  return Number(row?.cnt || 0);
};

/** Stock Adjustment coils still linked to this MRN (blocks full MRN delete). */
export const countSaCoilsByMrnUid = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS cnt FROM ${TABLE} WHERE mrn_uid = $1 AND sa_id IS NOT NULL`,
    [uid]
  );
  return Number(row?.cnt || 0);
};

/** Soft-delete specific coils by coil_no_uid (partial generate rollback). */
export const softDeleteCoilsByCoilNoUids = async (coil_no_uids = [], deleted_by = null) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[]) AND is_deleted = false
     RETURNING coil_uid`,
    [uids, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Build coil_no_uid list for a Stock Adjustment Add approve plan. */
export function buildStockAdjustmentAddCoilUidList({
  adjustmentId,
  coilCount,
  uidPrefix,
  mrn_no,
  serial_no,
  mrn_uid,
}) {
  const n = Math.max(0, Number(coilCount) || 0);
  if (n < 1) return [];
  const prefix = String(uidPrefix ?? "").trim() || "0";
  const mrnNo = mrn_no != null && String(mrn_no).trim() !== "" ? mrn_no : null;
  const serialNo = resolveSerialNoForUid({ serial_no, mrn_uid });
  const adjId = Number(adjustmentId);
  return Array.from({ length: n }, (_, i) =>
    formatStockAdjustmentCoilUid({
      prefix,
      mrn_no: mrnNo,
      serial_no: serialNo,
      adjustment_id: adjId,
      total: n,
      index: i + 1,
    })
  );
}

/** Insert coils on Stock Adjustment Add approve. These coils do not go to QC — QC is MRN Portal only. */
export const insertStockAdjustmentAddCoils = async ({
  adjustmentId,
  coilCount,
  perCoilQty,
  coilQtys = null,
  item_dcode,
  item_code,
  item_desc,
  heat_no,
  acc_code,
  acc_name,
  mrn_uid,
  mrn_no,
  serial_no,
  uidPrefix,
  remarks,
  userName,
}) => {
  const n = Math.max(0, Number(coilCount) || 0);
  if (n < 1) return [];

  const qtyList = Array.isArray(coilQtys) && coilQtys.length === n
    ? coilQtys.map((q) => Number(q) || 0)
    : null;
  const uniform = Number(perCoilQty);
  if (!qtyList && (!Number.isFinite(uniform) || uniform <= 0)) return [];

  const mrnUid = mrn_uid != null ? String(mrn_uid).trim() || null : null;
  if (!mrnUid) return [];

  const mrnNoRaw = mrn_no != null && String(mrn_no).trim() !== "" ? Number(mrn_no) : null;
  const mrnNo = Number.isFinite(mrnNoRaw) ? mrnNoRaw : null;

  const serialNo = resolveSerialNoForUid({ serial_no, mrn_uid });
  const prefix = String(uidPrefix ?? "").trim() || "0";

  const created = [];
  for (let i = 1; i <= n; i++) {
    const coil_no_uid = formatStockAdjustmentCoilUid({
      prefix,
      mrn_no: mrnNo,
      serial_no: serialNo,
      adjustment_id: adjustmentId,
      total: n,
      index: i,
    });
    const qty = qtyList ? qtyList[i - 1] : uniform;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const [row] = await dbQuery(
      `INSERT INTO ${TABLE}
       (coil_no_uid, mrn_uid, qty, sa_id, sa_entry_type, status, created_by)
       VALUES ($1,$2,$3,$4,'stock_in','active',$5)
       RETURNING *`,
      [
        coil_no_uid,
        mrnUid,
        qty,
        Number(adjustmentId),
        userName ?? null,
      ]
    );
    created.push(enrichCoilUidMeta(row));
  }
  if (!created.length) return [];
  const uids = created.map((r) => r.coil_no_uid).filter(Boolean);
  return fetchCoilsWithMrnDetails(uids);
};

/** Soft-delete coils created by an Add adjustment. */
export const softDeleteStockAdjustmentAddCoils = async (adjustmentId, userName) => {
  const adjId = Number(adjustmentId);
  if (!Number.isFinite(adjId) || adjId <= 0) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true,
         deleted_by = $2,
         deleted_at = NOW(),
         updated_by = $2,
         updated_at = NOW()
     WHERE sa_id = $1
       AND is_deleted = false
       AND COALESCE(sa_entry_type, 'stock_in') = 'stock_in'
     RETURNING coil_uid`,
    [adjId, userName ?? null]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Mark active coils as SA minus (consumed write-off — not shop floor). Keeps location for revert. */
export const markCoilsStockAdjustmentOut = async (adjustmentId, coil_no_uids = [], userName) => {
  const uids = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uids.length) return [];
  return dbQuery(
    `UPDATE ${TABLE}
     SET status = 'consumed',
         sa_id = $1,
         sa_entry_type = 'stock_out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND out_uid IS NULL
       AND (
         LOWER(COALESCE(status, 'active')) = 'active'
         OR (sa_entry_type = 'stock_out' AND sa_id = $1)
       )
     RETURNING *`,
    [Number(adjustmentId), userName ?? null, uids]
  );
};

/** Undo SA minus — restore coils to active. */
export const clearStockAdjustmentMinusMarks = async (adjustmentId, coil_no_uids = [], userName) => {
  const adjId = Number(adjustmentId);
  const uids = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  const conditions = ["is_deleted = false", "sa_entry_type = 'stock_out'"];
  const values = [userName ?? null];
  let i = 2;

  if (Number.isFinite(adjId) && adjId > 0) {
    values.push(adjId);
    conditions.push(`sa_id = $${i++}`);
  }
  if (uids.length) {
    values.push(uids);
    conditions.push(`coil_no_uid = ANY($${i++}::text[])`);
  } else if (!(Number.isFinite(adjId) && adjId > 0)) {
    return [];
  }

  return dbQuery(
    `UPDATE ${TABLE}
     SET status = 'active',
         sa_id = NULL,
         sa_entry_type = NULL,
         updated_by = $1,
         updated_at = NOW()
     WHERE ${conditions.join(" AND ")}
     RETURNING *`,
    values
  );
};

export const findCoilsBySaId = async (adjustmentId, sa_entry_type = null) => {
  const adjId = Number(adjustmentId);
  if (!Number.isFinite(adjId) || adjId <= 0) return [];
  const values = [adjId];
  let sql = `SELECT * FROM ${TABLE} WHERE sa_id = $1 AND is_deleted = false`;
  if (sa_entry_type === "stock_in") {
    sql += ` AND (sa_entry_type = 'stock_in' OR sa_entry_type IS NULL)`;
  } else if (sa_entry_type) {
    values.push(String(sa_entry_type));
    sql += ` AND sa_entry_type = $2`;
  }
  sql += ` ORDER BY ${coilIndexFromUidSql(null)} ASC NULLS LAST, coil_no_uid ASC`;
  return dbQuery(sql, values);
};

/** SA-linked coils with MRN display fields (for stock adjustment edit/view). */
export const findCoilsBySaIdWithMrn = async (adjustmentId, sa_entry_type = null) => {
  const rows = await findCoilsBySaId(adjustmentId, sa_entry_type);
  const uids = rows.map((r) => r.coil_no_uid).filter(Boolean);
  if (!uids.length) return rows;
  const detailed = await fetchCoilsWithMrnDetails(uids);
  const byUid = new Map(detailed.map((c) => [c.coil_no_uid, c]));
  return rows.map((r) => byUid.get(r.coil_no_uid) || r);
};

