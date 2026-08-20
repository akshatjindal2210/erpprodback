import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { orderMrnQuotasFifo } from "../../../lib/utils/mrnFifoOrder.js";
import { COIL_QC_JOIN, COIL_QC_PASSED_COND } from "../../../lib/utils/coilQcStatusSql.js";
import { coilIndexFromUidSql } from "../../coil/models/coil.model.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.OUT_ENTRY;
const SCANNED = T.OUT_ENTRY_SCANNED_COIL;
const COIL = T.COIL_TABLE;
const LOC = T.MASTER_LOCATION;
const ISSUE_REQUEST = T.ISSUE_REQUEST;
const ISSUE_REQUEST_JC = T.ISSUE_REQUEST_JOB_CARD;
const REJECTION = T.REJECTION;
const MRN = T.MRN;

/** Stored register description, else unique MRN descriptions from scanned / linked coils. */
const OUT_ITEM_DESCS_SQL = `COALESCE(
  NULLIF(TRIM(o.item_descs), ''),
  (
    SELECT STRING_AGG(DISTINCT x.item_desc, ' | ')
    FROM (
      SELECT NULLIF(TRIM(m.item_desc), '') AS item_desc
      FROM ${SCANNED} s
      JOIN ${COIL} c ON c.coil_no_uid = s.coil_no_uid AND c.is_deleted = false
      JOIN ${MRN} m ON m.uid = c.mrn_uid
      WHERE s.out_uid = o.out_uid
      UNION
      SELECT NULLIF(TRIM(m.item_desc), '') AS item_desc
      FROM ${COIL} c
      JOIN ${MRN} m ON m.uid = c.mrn_uid
      WHERE c.out_uid = o.out_uid AND c.is_deleted = false
    ) x
    WHERE x.item_desc IS NOT NULL
  )
)`;

/** Job-card machine for Store Out list/get — not stored on the out-entry row. */
const OUT_ENTRY_JC_JOIN = `
LEFT JOIN LATERAL (
  SELECT jc.macname
  FROM ${ISSUE_REQUEST_JC} jc
  WHERE jc.issue_uid = o.issue_uid
    AND jc.is_deleted = false
    AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM(COALESCE(o.pjobcardno, '')))
  ORDER BY jc.id DESC
  LIMIT 1
) jc ON TRUE`;

/**
 * Open store-out reservation scope — draft AND scan-complete pending authorize.
 * Reserve stays until `approved = true`; scan_complete alone does NOT release (IMS FN style).
 */
export const OPEN_STORE_OUT_RESERVE_SQL = "COALESCE(o.approved, false) = false";

/** Active coil not already out and not on an open store-out entry (draft or scan-complete pending). */
function coilAvailableForOutSql(alias = "c") {
  return `${alias}.out_uid IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${SCANNED} s
      JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
      WHERE LOWER(TRIM(s.coil_no_uid)) = LOWER(TRIM(${alias}.coil_no_uid))
        AND ${OPEN_STORE_OUT_RESERVE_SQL}
    )`;
}

/** Coil already on an approved issue-request job card — show under Job Card pending only. */
function coilNotOnApprovedIssueRequestSql(alias = "c") {
  return `NOT EXISTS (
    SELECT 1
    FROM ${ISSUE_REQUEST} ir
    INNER JOIN ${ISSUE_REQUEST_JC} jc
      ON jc.issue_uid = ir.issue_uid AND jc.is_deleted = false
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS jc_coil(coil)
    WHERE ir.is_deleted = false
      AND ir.approved = true
      AND LOWER(TRIM(jc_coil.coil->>'coil_no_uid')) = LOWER(TRIM(${alias}.coil_no_uid))
  )`;
}

export const findOutEntries = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["o.is_deleted = false"];

  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`o.approved = $${i++}`);
  }
  if (filters.scan_complete !== undefined && filters.scan_complete !== null && filters.scan_complete !== "") {
    values.push(filters.scan_complete === true || filters.scan_complete === "true");
    conditions.push(`COALESCE(o.scan_complete, false) = $${i++}`);
  }
  if (filters.entry_type) {
    values.push(String(filters.entry_type).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(o.entry_type, 'store_out')) = $${i++}`);
  }
  if (filters.qc_reject_uid != null && filters.qc_reject_uid !== "") {
    values.push(Number(filters.qc_reject_uid));
    conditions.push(`o.qc_reject_uid = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`o.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`o.created_at <= $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(o.mrn_uids,'') ILIKE $${idx} OR
      COALESCE(o.heat_nos,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(o.item_descs,'') ILIKE $${idx} OR
      COALESCE(o.location_refs,'') ILIKE $${idx} OR
      COALESCE(o.remarks,'') ILIKE $${idx} OR
      COALESCE(o.reason,'') ILIKE $${idx} OR
      COALESCE(o.entry_type,'') ILIKE $${idx} OR
      COALESCE(o.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      o.out_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} o ${OUT_ENTRY_JC_JOIN} ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT o.*,
            ${OUT_ITEM_DESCS_SQL} AS item_descs,
            jc.macname,
            o.created_by AS created_by_name,
            o.approved_by AS approved_by_name,
            o.updated_by AS updated_by_name
     FROM ${TABLE} o
     ${OUT_ENTRY_JC_JOIN}
     ${where}
     ORDER BY o.out_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findOutEntry = async (out_uid) => {
  const id = Number(out_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT o.*, ${OUT_ITEM_DESCS_SQL} AS item_descs,
            jc.macname,
            o.created_by AS created_by_name, o.approved_by AS approved_by_name, o.updated_by AS updated_by_name
     FROM ${TABLE} o
     ${OUT_ENTRY_JC_JOIN}
     WHERE o.out_uid = $1 AND o.is_deleted = false LIMIT 1`,
    [id]
  );
  return row ?? null;
};

/** Distinct reasons used on MRN store-out entries — powers the type/search suggest field. */
export const findStoreOutReasons = async ({ search } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    "o.is_deleted = false",
    "LOWER(COALESCE(o.entry_type, 'store_out')) = 'store_out'",
    "COALESCE(TRIM(o.reason), '') <> ''",
  ];
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`o.reason ILIKE $${i++}`);
  }
  return dbQuery(
    `SELECT TRIM(o.reason) AS reason,
            MAX(COALESCE(o.updated_at, o.created_at)) AS last_used_at
     FROM ${TABLE} o
     WHERE ${conditions.join(" AND ")}
     GROUP BY TRIM(o.reason)
     ORDER BY last_used_at DESC NULLS LAST, TRIM(o.reason) ASC
     LIMIT 100`,
    values
  );
};

export const insertOutEntry = async (data) => {
  const {
    entry_type, issue_uid, pjobcardno, qc_reject_uid, mrn_refs, mrn_uids, heat_nos, item_codes, item_descs, qtys, total_qty, coil_count,
    location_refs, reason, remarks, created_by, scan_complete,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (entry_type, issue_uid, pjobcardno, qc_reject_uid, mrn_refs, mrn_uids, heat_nos, item_codes, item_descs, qtys, total_qty, coil_count,
      location_refs, reason, remarks, created_by, scan_complete)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      entry_type ?? "store_out",
      issue_uid ?? null,
      pjobcardno ?? null,
      qc_reject_uid ?? null,
      mrn_refs ?? null, mrn_uids ?? null, heat_nos ?? null, item_codes ?? null, item_descs ?? null, qtys ?? null,
      total_qty ?? 0, coil_count ?? 0, location_refs ?? null, reason ?? null, remarks ?? null, created_by,
      scan_complete === true,
    ]
  );
  return row;
};

export const updateOutEntry = async (out_uid, fields = {}) => {
  const allowed = [
    "reason", "remarks", "approved", "approved_by", "approved_at", "updated_by", "updated_at",
    "scan_complete", "mrn_refs", "mrn_uids", "heat_nos", "item_codes", "item_descs", "qtys", "total_qty",
    "coil_count", "location_refs",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findOutEntry(out_uid);
  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(safe);
  values.push(Number(out_uid));
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE out_uid = $${nextIndex} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteOutEntry = async (out_uid, deleted_by) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE out_uid = $1 AND is_deleted = false`,
    [Number(out_uid), deleted_by ?? null]
  );
};

export const replaceOutEntryScannedCoils = async (out_uid, coil_no_uids = []) => {
  const id = Number(out_uid);
  const list = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  await dbQuery(`DELETE FROM ${SCANNED} WHERE out_uid = $1`, [id]);
  if (!list.length) return [];
  for (const uid of list) {
    await dbQuery(
      `INSERT INTO ${SCANNED} (out_uid, coil_no_uid) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, uid]
    );
  }
  return list;
};

export const findOutEntryScannedCoilUids = async (out_uid) => {
  const rows = await dbQuery(
    `SELECT coil_no_uid FROM ${SCANNED} WHERE out_uid = $1 ORDER BY created_at ASC`,
    [Number(out_uid)]
  );
  return (rows || []).map((r) => r.coil_no_uid);
};

export const findOutEntryScannedCoilsDetailed = async (out_uid) => {
  return dbQuery(
    `SELECT c.*,
            m.mrn_no,
            m.serial_no,
            m.heat_no,
            m.item_dcode,
            m.item_code,
            m.item_desc,
            lm.location_no,
            lm.rack_no,
            lm.row_no,
            s.created_at AS scanned_at
     FROM ${SCANNED} s
     JOIN ${COIL} c ON c.coil_no_uid = s.coil_no_uid AND c.is_deleted = false
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE s.out_uid = $1
     ORDER BY s.created_at ASC`,
    [Number(out_uid)]
  );
};

/**
 * Coils for this store-out entry.
 * Draft / pending: scanned table.
 * Authorized: scanned snapshot (issued coils) so history survives consume / store-in
 * when live coil.out_uid is cleared; fall back to live out_uid link for legacy rows.
 */
export const findOutEntryLinkedCoils = async (out_uid) => {
  if (!out_uid) return [];
  const [entry] = await dbQuery(
    `SELECT approved FROM ${TABLE} WHERE out_uid = $1 AND is_deleted = false LIMIT 1`,
    [Number(out_uid)]
  );
  if (entry?.approved) {
    const scanned = await findOutEntryScannedCoilsDetailed(out_uid);
    if (scanned.length > 0) return scanned;
    return dbQuery(
      `SELECT c.*,
              m.mrn_no,
              m.serial_no,
              m.heat_no,
              m.item_dcode,
              m.item_code,
              m.item_desc,
              lm.location_no,
              lm.rack_no,
              lm.row_no
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
       WHERE c.out_uid = $1 AND c.is_deleted = false
       ORDER BY c.coil_uid ASC`,
      [Number(out_uid)]
    );
  }
  return findOutEntryScannedCoilsDetailed(out_uid);
};

/** Coil already reserved on another open (non-approved) store-out draft/pending. */
export const findOpenOutDraftForCoil = async (coil_no_uid, excludeOutUid = null) => {
  const values = [String(coil_no_uid || "").trim()];
  let i = 2;
  let excludeSql = "";
  if (excludeOutUid != null && Number.isFinite(Number(excludeOutUid))) {
    values.push(Number(excludeOutUid));
    excludeSql = ` AND o.out_uid <> $${i++}`;
  }
  const [row] = await dbQuery(
    `SELECT o.out_uid
     FROM ${SCANNED} s
     JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
     WHERE s.coil_no_uid = $1
       AND ${OPEN_STORE_OUT_RESERVE_SQL}
       ${excludeSql}
     LIMIT 1`,
    values
  );
  return row ?? null;
};

/** Coils on open store-out entries (draft + scan-complete pending) — block issue request picks until authorize. */
export const findOutDraftReservedCoilUids = async () => {
  const rows = await dbQuery(
    `SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_no_uid
     FROM ${SCANNED} s
     JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
     WHERE ${OPEN_STORE_OUT_RESERVE_SQL}
       AND TRIM(s.coil_no_uid) <> ''`
  );
  return new Set((rows || []).map((r) => String(r.coil_no_uid || "").trim()).filter(Boolean));
};

export const clearOutEntryScannedCoils = async (out_uid) => {
  await dbQuery(`DELETE FROM ${SCANNED} WHERE out_uid = $1`, [Number(out_uid)]);
};

function uniquePipeJoin(values = []) {
  return [...new Set(
    values
      .map((v) => (v == null ? "" : String(v).trim()))
      .filter(Boolean)
  )].join(" | ");
}

export function buildOutEntryCoilSummary(coils = []) {
  const list = Array.isArray(coils) ? coils : [];
  const mrnRefs = uniquePipeJoin(list.map((c) => c.mrn_no).filter((v) => v != null));
  const mrnUids = uniquePipeJoin(list.map((c) => c.mrn_uid));
  const heatNos = uniquePipeJoin(list.map((c) => c.heat_no));
  const itemCodes = uniquePipeJoin(list.map((c) => c.item_code));
  const itemDescs = uniquePipeJoin(list.map((c) => c.item_desc || c.rm_item_desc || c.itemdesc));
  const locationRefs = uniquePipeJoin(
    list.map((c) => c.location_no || (c.location_id != null ? String(c.location_id) : null))
  );
  const total_qty = list.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const qtys = list.map((c) => c.qty ?? "").join(",");
  return {
    mrn_refs: mrnRefs || null,
    mrn_uids: mrnUids || null,
    heat_nos: heatNos || null,
    item_codes: itemCodes || null,
    item_descs: itemDescs || null,
    location_refs: locationRefs || null,
    total_qty,
    qtys,
    coil_count: list.length,
  };
}

/**
 * MRNs with active store coils (rack location OR unassigned / coil area) — Store Out picker (IMS style).
 */
export const findStoredMrnSummaries = async ({ search, page = 1, limit = 50 } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    "c.is_deleted = false",
    `COALESCE(c.status, 'active') = 'active'`,
    COIL_QC_PASSED_COND,
    `NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(c.mrn_uid, '') ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx} OR
      COALESCE(m.item_code, '') ILIKE $${idx} OR
      COALESCE(m.heat_no, '') ILIKE $${idx} OR
      COALESCE(m.acc_name, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM (
       SELECT c.mrn_uid
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${COIL_QC_JOIN}
       ${where}
       GROUP BY c.mrn_uid
     ) x`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `SELECT c.mrn_uid,
            MAX(m.mrn_no) AS mrn_no,
            MAX(COALESCE(m.sticker_mode, 'coil')) AS sticker_mode,
            MAX(m.item_code) AS item_code,
            MAX(m.item_desc) AS item_desc,
            MAX(m.acc_name) AS acc_name,
            COUNT(*)::int AS coil_count,
            COALESCE(SUM(c.qty), 0)::float AS total_qty,
            COUNT(DISTINCT COALESCE(c.location_id::text, 'unassigned'))::int AS location_count
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     ${COIL_QC_JOIN}
     ${where}
     GROUP BY c.mrn_uid
     ORDER BY MIN(c.created_at) ASC NULLS LAST, MAX(m.mrn_no) ASC NULLS LAST, c.mrn_uid ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

/** Active coils for one MRN (stored + unassigned) — Store Out pick plan (IMS packing style). */
export const findStoredMrnDetail = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return null;

  const [mrn] = await dbQuery(
    `SELECT m.uid AS mrn_uid, m.mrn_no, m.sticker_mode, m.item_code, m.item_dcode, m.item_desc, m.acc_name
     FROM ${T.MRN} m
     WHERE m.uid = $1
     LIMIT 1`,
    [uid]
  );

  const coils = await dbQuery(
    `SELECT c.*,
            m.mrn_no AS mrn_no,
            m.serial_no AS serial_no,
            m.heat_no AS heat_no,
            m.item_dcode AS item_dcode,
            m.item_code AS item_code,
            m.item_desc AS item_desc,
            m.acc_code AS acc_code,
            m.acc_name AS acc_name,
            m.remarks AS remarks,
            lm.location_no,
            lm.rack_no,
            lm.row_no
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     ${COIL_QC_JOIN}
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE c.is_deleted = false
       AND COALESCE(c.status, 'active') = 'active'
       AND ${COIL_QC_PASSED_COND}
       AND c.mrn_uid = $1
     ORDER BY
       CASE WHEN c.location_id IS NULL THEN 1 ELSE 0 END ASC,
       c.created_at ASC NULLS LAST,
       lm.location_no ASC NULLS LAST,
       ${coilIndexFromUidSql("c")} ASC NULLS LAST,
       c.coil_no_uid ASC`,
    [uid]
  );

  if (!coils.length && !mrn) return null;

  const first = coils[0] || {};
  const sticker_mode =
    String(mrn?.sticker_mode || "coil").trim().toLowerCase() === "batch" ? "batch" : "coil";

  const locMap = new Map();
  for (const c of coils) {
    const key = c.location_id != null ? String(c.location_id) : "none";
    if (!locMap.has(key)) {
      locMap.set(key, {
        location_id: c.location_id ?? null,
        location_no:
          c.location_no ||
          (c.location_id != null ? `ID ${c.location_id}` : "Unassigned — not on rack"),
        rack_no: c.rack_no || null,
        row_no: c.row_no || null,
        coils: [],
      });
    }
    locMap.get(key).coils.push(c);
  }

  const heat_nos = [...new Set(coils.map((c) => c.heat_no).filter(Boolean))];
  const total_qty = coils.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const itemFromCoils =
    coils.find((c) => c.item_code)?.item_code ||
    coils.find((c) => c.item_dcode)?.item_dcode ||
    null;
  const accFromCoils = coils.find((c) => c.acc_name)?.acc_name || null;

  return {
    mrn_uid: uid,
    mrn_no: mrn?.mrn_no ?? first.mrn_no ?? null,
    sticker_mode,
    item_code: mrn?.item_code || first.item_code || itemFromCoils || null,
    item_dcode: mrn?.item_dcode ?? first.item_dcode ?? null,
    item_desc: mrn?.item_desc || first.item_desc || null,
    acc_name: mrn?.acc_name || first.acc_name || accFromCoils || null,
    heat_nos: heat_nos.join(", ") || null,
    coil_count: coils.length,
    total_qty,
    location_count: locMap.size,
    locations: [...locMap.values()],
    coils,
  };
};

const JC_ISSUE_QTY_EXPR = `COALESCE(jc.issue_qty, 0)`;

/** Oldest reserved MRN UID first; any coil on that MRN may be scanned. */
function sortCoilsByFifoMrn(coils = [], mrnQuotas = []) {
  const order = new Map(
    (mrnQuotas || [])
      .map((q, i) => [String(q?.mrn_uid || "").trim(), i])
      .filter(([k]) => k)
  );
  return [...(coils || [])].sort((a, b) => {
    const ka = String(a?.mrn_uid || "").trim();
    const kb = String(b?.mrn_uid || "").trim();
    const ia = order.has(ka) ? order.get(ka) : 9999;
    const ib = order.has(kb) ? order.get(kb) : 9999;
    if (ia !== ib) return ia - ib;
    return String(a?.coil_no_uid || "").localeCompare(String(b?.coil_no_uid || ""), undefined, {
      numeric: true,
    });
  });
}

/**
 * Issue-request job card scan plan:
 * count and MRN quotas come from the issue request; any available coil on those
 * same mrn_uid values may be scanned (physical access), oldest MRN first.
 */
export const findJobCardStoreOutPlan = async ({ issue_uid, pjobcardno, excludeOutUid = null } = {}) => {
  const issueId = Number(issue_uid);
  const jcNo = String(pjobcardno || "").trim();
  if (!Number.isFinite(issueId) || issueId <= 0 || !jcNo) return null;

  const [jcMeta] = await dbQuery(
    `SELECT
       r.issue_uid,
       TRIM(jc.pjobcardno) AS pjobcardno,
       jc.macname,
       jc.item_code,
       jc.item_desc,
       jc.rm_item_code,
       jc.rm_item_desc,
       jc.rm_item_dcode,
       ${JC_ISSUE_QTY_EXPR}::float8 AS issue_qty,
       jc.coils
     FROM ${ISSUE_REQUEST} r
     INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     WHERE r.is_deleted = false
       AND r.approved = true
       AND r.issue_uid = $1
       AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM($2))
     LIMIT 1`,
    [issueId, jcNo]
  );
  if (!jcMeta) return null;

  // Reserved coil UIDs from IR (quota source)
  const reservedRows = await dbQuery(
    `SELECT TRIM(c.coil->>'coil_no_uid') AS coil_no_uid
     FROM ${ISSUE_REQUEST} r
     INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
     ) AS c(coil)
     WHERE r.is_deleted = false
       AND r.approved = true
       AND r.issue_uid = $1
       AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM($2))
       AND TRIM(c.coil->>'coil_no_uid') <> ''`,
    [issueId, jcNo]
  );
  const reservedUids = (reservedRows || []).map((r) => String(r.coil_no_uid || "").trim()).filter(Boolean);
  if (!reservedUids.length) {
    return {
      issue_uid: jcMeta.issue_uid,
      pjobcardno: jcMeta.pjobcardno,
      macname: jcMeta.macname,
      item_code: jcMeta.item_code,
      item_desc: jcMeta.item_desc,
      rm_item_code: jcMeta.rm_item_code,
      rm_item_desc: jcMeta.rm_item_desc,
      issue_qty: jcMeta.issue_qty,
      required_coil_count: 0,
      coil_count: 0,
      total_qty: 0,
      locations: [],
      coils: [],
      coil_no_uids: [],
      mrn_quotas: [],
    };
  }

  // Resolve MRN quotas from reserved coils
  const reservedCoilRows = await dbQuery(
    `SELECT c.coil_no_uid, c.mrn_uid, m.mrn_no AS mrn_no, c.qty, m.item_code AS item_code, m.item_dcode AS item_dcode
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE c.is_deleted = false
       AND LOWER(TRIM(c.coil_no_uid)) = ANY($1::text[])`,
    [reservedUids.map((u) => u.toLowerCase())]
  );
  const mrnQuotaMap = new Map(); // mrn_uid -> { count, qty, mrn_no }
  for (const c of reservedCoilRows || []) {
    const muid = String(c.mrn_uid || "").trim();
    if (!muid) continue;
    if (!mrnQuotaMap.has(muid)) {
      mrnQuotaMap.set(muid, { mrn_uid: muid, mrn_no: c.mrn_no, count: 0, qty: 0 });
    }
    const q = mrnQuotaMap.get(muid);
    q.count += 1;
    q.qty += Number(c.qty) || 0;
    if (c.mrn_no != null) q.mrn_no = c.mrn_no;
  }
  const mrnUids = [...mrnQuotaMap.keys()];
  const required_coil_count = reservedUids.length;
  const required_qty = (reservedCoilRows || []).reduce((s, c) => s + (Number(c.qty) || 0), 0);

  if (!mrnUids.length) {
    return {
      issue_uid: jcMeta.issue_uid,
      pjobcardno: jcMeta.pjobcardno,
      macname: jcMeta.macname,
      item_code: jcMeta.item_code,
      item_desc: jcMeta.item_desc,
      rm_item_code: jcMeta.rm_item_code,
      rm_item_desc: jcMeta.rm_item_desc,
      issue_qty: jcMeta.issue_qty,
      required_coil_count,
      coil_count: required_coil_count,
      total_qty: required_qty,
      locations: [],
      coils: [],
      coil_no_uids: [],
      mrn_quotas: [],
    };
  }

  // Scan pool: any active coil on the reserved MRN UID(s). FIFO is by mrn_uid only.
  const expandValues = [mrnUids];
  const mrnParam = "$1";
  let expandDraftExclude = "";
  let expandOutUidParam = "NULL::int";
  if (excludeOutUid != null && excludeOutUid !== "") {
    expandValues.push(Number(excludeOutUid));
    expandOutUidParam = "$2";
    expandDraftExclude = "AND o.out_uid <> $2";
  }

  const coils = await dbQuery(
    `WITH draft_blocked AS (
       SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_key
       FROM ${SCANNED} s
       JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
       WHERE COALESCE(o.approved, false) = false
         AND TRIM(s.coil_no_uid) <> ''
         ${expandDraftExclude}
     )
     SELECT c.*,
            m.mrn_no AS mrn_no,
            m.serial_no AS serial_no,
            m.heat_no AS heat_no,
            m.item_dcode AS item_dcode,
            m.item_code AS item_code,
            m.item_desc AS item_desc,
            m.acc_code AS acc_code,
            m.acc_name AS acc_name,
            m.remarks AS remarks,
            lm.location_no,
            lm.rack_no,
            lm.row_no
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     ${COIL_QC_JOIN}
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     LEFT JOIN draft_blocked db ON db.coil_key = LOWER(TRIM(c.coil_no_uid))
     WHERE c.is_deleted = false
       AND c.mrn_uid = ANY(${mrnParam}::text[])
       AND (
         (COALESCE(c.status, 'active') = 'active' AND c.out_uid IS NULL)
         OR (${expandOutUidParam} IS NOT NULL AND c.out_uid = ${expandOutUidParam})
       )
       AND ${COIL_QC_PASSED_COND}
       AND (db.coil_key IS NULL OR (${expandOutUidParam} IS NOT NULL AND c.out_uid = ${expandOutUidParam}))
     ORDER BY
       CASE WHEN c.location_id IS NULL THEN 1 ELSE 0 END ASC,
       lm.location_no ASC NULLS LAST,
       ${coilIndexFromUidSql("c")} ASC NULLS LAST,
       c.coil_no_uid ASC`,
    expandValues
  );

  const mrn_quotas = orderMrnQuotasFifo([...mrnQuotaMap.values()], reservedCoilRows || []);
  const fifoCoils = sortCoilsByFifoMrn(coils, mrn_quotas);

  const locMap = new Map();
  for (const c of fifoCoils) {
    const key = c.location_id != null ? String(c.location_id) : "none";
    if (!locMap.has(key)) {
      locMap.set(key, {
        location_id: c.location_id ?? null,
        location_no:
          c.location_no ||
          (c.location_id != null ? `ID ${c.location_id}` : "Unassigned — not on rack"),
        rack_no: c.rack_no || null,
        row_no: c.row_no || null,
        coils: [],
      });
    }
    locMap.get(key).coils.push(c);
  }

  const first = fifoCoils[0] || {};
  const heat_nos = [...new Set(fifoCoils.map((c) => c.heat_no).filter(Boolean))];
  const total_qty = fifoCoils.reduce((s, c) => s + (Number(c.qty) || 0), 0);

  return {
    issue_uid: jcMeta.issue_uid,
    pjobcardno: jcMeta.pjobcardno,
    macname: jcMeta.macname,
    item_code: jcMeta.item_code,
    item_desc: jcMeta.item_desc,
    rm_item_code: jcMeta.rm_item_code,
    rm_item_desc: jcMeta.rm_item_desc,
    issue_qty: jcMeta.issue_qty,
    mrn_uid: mrnUids.length === 1 ? mrnUids[0] : null,
    mrn_no:
      mrnUids.length === 1
        ? first.mrn_no || mrn_quotas[0]?.mrn_no || mrnUids[0]
        : mrnUids.length > 1
          ? "Multi MRN"
          : null,
    sticker_mode: "coil",
    heat_nos: heat_nos.join(", ") || null,
    /** How many coils must be scanned (IR reserved count) */
    required_coil_count,
    required_qty,
    coil_count: required_coil_count,
    pool_coil_count: fifoCoils.length,
    total_qty: required_qty || total_qty,
    location_count: locMap.size,
    locations: [...locMap.values()],
    coils: fifoCoils,
    coil_no_uids: fifoCoils.map((c) => c.coil_no_uid).filter(Boolean),
    reserved_coil_uids: reservedUids,
    mrn_quotas,
    ims_any_coil_in_mrn: true,
  };
};

/**
 * True when coil can fulfill this job-card store-out:
 * it belongs to an MRN reserved on the approved issue request.
 */
export const isCoilPendingJobCardStoreOut = async (
  coil_no_uid,
  excludeOutUid = null,
  { issue_uid = null, pjobcardno = null } = {}
) => {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return false;

  const issueId = issue_uid != null ? Number(issue_uid) : null;
  const jcNo = String(pjobcardno || "").trim();
  if (!(Number.isFinite(issueId) && issueId > 0 && jcNo)) {
    // Without JC context, fall back to exact reserved-UID membership
    const values = [uid.toLowerCase()];
    let i = 2;
    let draftExclude = "";
    if (excludeOutUid != null && excludeOutUid !== "") {
      values.push(Number(excludeOutUid));
      draftExclude = `AND o.out_uid <> $${i++}`;
    }
    const [row] = await dbQuery(
      `WITH jc_coils AS (
         SELECT TRIM(c.coil->>'coil_no_uid') AS coil_no_uid
         FROM ${ISSUE_REQUEST} r
         INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
         ) AS c(coil)
         WHERE r.is_deleted = false AND r.approved = true
       ),
       available_coils AS (
         SELECT LOWER(TRIM(c.coil_no_uid)) AS coil_key
         FROM ${COIL} c
         WHERE c.is_deleted = false
           AND COALESCE(c.status, 'active') = 'active'
           AND c.out_uid IS NULL
       ),
       draft_blocked AS (
         SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_key
         FROM ${SCANNED} s
         JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
         WHERE COALESCE(o.approved, false) = false
           AND TRIM(s.coil_no_uid) <> ''
           ${draftExclude}
       )
       SELECT 1 AS ok
       FROM jc_coils j
       INNER JOIN available_coils s ON s.coil_key = LOWER(TRIM(j.coil_no_uid))
       LEFT JOIN draft_blocked db ON db.coil_key = s.coil_key
       WHERE LOWER(TRIM(j.coil_no_uid)) = $1
         AND TRIM(j.coil_no_uid) <> ''
         AND db.coil_key IS NULL
       LIMIT 1`,
      values
    );
    return Boolean(row);
  }

  const plan = await findJobCardStoreOutPlan({
    issue_uid: issueId,
    pjobcardno: jcNo,
    excludeOutUid,
  });
  if (!plan?.coils?.length) return false;
  const key = uid.toLowerCase();
  return (plan.coils || []).some((c) => String(c.coil_no_uid || "").toLowerCase() === key);
};

/**
 * Pending Store Out grouped by approved issue-request job card.
 * A row stays visible while that issue still has remaining coil quota and at least
 * one scan-eligible coil on its reserved MRN(s). Coils assigned to another
 * unfulfilled issue request are not counted as available here.
 */
export const findPendingStoreOutByJobCard = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false", "r.approved = true", "jc.is_deleted = false"];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  const baseCte = `
    WITH jc_headers AS (
      SELECT
        r.issue_uid,
        MAX(r.shift) AS shift,
        MAX(r.approved_at) AS approved_at,
        MAX(r.approved_by) AS approved_by_name,
        TRIM(jc.pjobcardno) AS pjobcardno,
        MAX(jc.macname) AS macname,
        MAX(jc.item_code) AS item_code,
        MAX(jc.item_desc) AS item_desc,
        MAX(jc.rm_item_code) AS rm_item_code,
        MAX(jc.rm_item_desc) AS rm_item_desc,
        MAX(${JC_ISSUE_QTY_EXPR})::float8 AS issue_qty
      FROM ${ISSUE_REQUEST} r
      INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
      ${where}
      GROUP BY r.issue_uid, TRIM(jc.pjobcardno)
    ),
    jc_reserved AS (
      SELECT
        r.issue_uid,
        TRIM(jc.pjobcardno) AS pjobcardno,
        LOWER(TRIM(c.coil->>'coil_no_uid')) AS coil_key,
        TRIM(c.coil->>'coil_no_uid') AS coil_no_uid
      FROM ${ISSUE_REQUEST} r
      INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
      ) AS c(coil)
      WHERE r.is_deleted = false
        AND r.approved = true
        AND TRIM(c.coil->>'coil_no_uid') <> ''
    ),
    available_coils AS (
      SELECT
        LOWER(TRIM(c.coil_no_uid)) AS coil_key,
        c.coil_no_uid,
        c.qty,
        c.mrn_uid,
        m.mrn_no,
        m.heat_no,
        lm.location_no
      FROM ${COIL} c
      LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
      ${COIL_QC_JOIN}
      LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
      WHERE c.is_deleted = false
        AND COALESCE(c.status, 'active') = 'active'
        AND ${COIL_QC_PASSED_COND}
        AND c.out_uid IS NULL
    ),
    draft_blocked AS (
      SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_key
      FROM ${SCANNED} s
      JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
      WHERE COALESCE(o.approved, false) = false
        AND TRIM(s.coil_no_uid) <> ''
    ),
    jc_fulfillment AS (
      SELECT
        jc.issue_uid,
        TRIM(jc.pjobcardno) AS pjobcardno,
        COUNT(*) FILTER (WHERE TRIM(c.coil->>'coil_no_uid') <> '')::int AS assigned_coil_count,
        (
          SELECT COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int
          FROM ${TABLE} o
          INNER JOIN ${SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
          WHERE o.is_deleted = false
            AND COALESCE(o.approved, false) = true
            AND o.issue_uid = jc.issue_uid
            AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(COALESCE(jc.pjobcardno, '')))
            AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
        ) AS out_coil_count
      FROM ${ISSUE_REQUEST} r
      INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
      ) AS c(coil)
      WHERE r.is_deleted = false AND r.approved = true
      GROUP BY jc.issue_uid, jc.pjobcardno
    ),
    reserved_mrns AS (
      SELECT DISTINCT
        res.issue_uid,
        res.pjobcardno,
        c.mrn_uid
      FROM jc_reserved res
      INNER JOIN ${COIL} c
        ON LOWER(TRIM(c.coil_no_uid)) = res.coil_key
       AND c.is_deleted = false
      WHERE NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL
    ),
    pool AS (
      SELECT
        rm.issue_uid,
        rm.pjobcardno,
        s.coil_no_uid,
        s.qty,
        s.mrn_uid,
        s.mrn_no
      FROM reserved_mrns rm
      INNER JOIN available_coils s ON s.mrn_uid = rm.mrn_uid
      LEFT JOIN draft_blocked db ON db.coil_key = s.coil_key
      WHERE db.coil_key IS NULL
    ),
    pending AS (
      SELECT
        h.issue_uid,
        h.pjobcardno,
        MAX(h.shift) AS shift,
        MAX(h.macname) AS macname,
        MAX(h.item_code) AS item_code,
        MAX(h.item_desc) AS item_desc,
        MAX(h.rm_item_code) AS rm_item_code,
        MAX(h.rm_item_desc) AS rm_item_desc,
        MAX(h.issue_qty) AS issue_qty,
        MAX(h.approved_at) AS approved_at,
        MAX(h.approved_by_name) AS approved_by_name,
        'job_card'::varchar AS pending_type,
        GREATEST(
          COALESCE(MAX(f.assigned_coil_count), 0) - COALESCE(MAX(f.out_coil_count), 0),
          0
        )::int AS pending_coil_count,
        (
          CASE
            WHEN COALESCE(MAX(f.assigned_coil_count), 0) > 0
            THEN MAX(h.issue_qty)
              * (GREATEST(COALESCE(MAX(f.assigned_coil_count), 0) - COALESCE(MAX(f.out_coil_count), 0), 0)::float8
                / MAX(f.assigned_coil_count)::float8)
            ELSE MAX(h.issue_qty)
          END
        )::float8 AS pending_qty,
        (SELECT STRING_AGG(DISTINCT p.mrn_no::text, ', ' ORDER BY p.mrn_no::text) FROM pool p WHERE p.issue_uid = h.issue_uid AND UPPER(TRIM(p.pjobcardno)) = UPPER(TRIM(h.pjobcardno))) AS mrn_nos,
        (SELECT MIN(p.mrn_uid) FROM pool p WHERE p.issue_uid = h.issue_uid AND UPPER(TRIM(p.pjobcardno)) = UPPER(TRIM(h.pjobcardno))) AS mrn_uid,
        (SELECT STRING_AGG(p.coil_no_uid, ', ' ORDER BY p.coil_no_uid) FROM pool p WHERE p.issue_uid = h.issue_uid AND UPPER(TRIM(p.pjobcardno)) = UPPER(TRIM(h.pjobcardno))) AS coil_no_uids
      FROM jc_headers h
      LEFT JOIN jc_fulfillment f
        ON f.issue_uid = h.issue_uid
       AND UPPER(TRIM(f.pjobcardno)) = UPPER(TRIM(h.pjobcardno))
      WHERE NOT (
          COALESCE(f.assigned_coil_count, 0) > 0
          AND COALESCE(f.out_coil_count, 0) >= COALESCE(f.assigned_coil_count, 0)
        )
        AND EXISTS (
          SELECT 1
          FROM pool p
          WHERE p.issue_uid = h.issue_uid
            AND UPPER(TRIM(p.pjobcardno)) = UPPER(TRIM(h.pjobcardno))
        )
      GROUP BY h.issue_uid, h.pjobcardno
      HAVING GREATEST(
        COALESCE(MAX(f.assigned_coil_count), 0) - COALESCE(MAX(f.out_coil_count), 0),
        0
      ) > 0
    )`;

  const countRes = await dbQuery(`${baseCte} SELECT COUNT(*)::int AS count FROM pending`, values);
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `${baseCte}
     SELECT *
     FROM pending
     ORDER BY approved_at DESC NULLS LAST, issue_uid DESC, pjobcardno ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};

/**
 * Open job-card Store Out drafts — shown in Pending after coils are scanned/submitted.
 * Keeps the two-step flow: Issue Request → scan here → authorize moves stock to shop floor.
 */
export const findPendingJobCardStoreOutDrafts = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "o.is_deleted = false",
    "COALESCE(o.approved, false) = false",
    "LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'",
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(o.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(o.item_descs,'') ILIKE $${idx} OR
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      o.out_uid::text ILIKE $${idx} OR
      o.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  const fromClause = `
    FROM ${TABLE} o
    LEFT JOIN ${ISSUE_REQUEST} ir ON ir.issue_uid = o.issue_uid AND ir.is_deleted = false
    LEFT JOIN ${ISSUE_REQUEST_JC} jc
      ON jc.issue_uid = ir.issue_uid
     AND jc.is_deleted = false
     AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM(o.pjobcardno))`;

  const countRes = await dbQuery(`SELECT COUNT(*)::int AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `SELECT
       o.out_uid,
       o.issue_uid,
       TRIM(o.pjobcardno) AS pjobcardno,
       o.scan_complete,
       o.approved,
       o.entry_type,
       o.coil_count,
       o.total_qty AS pending_qty,
       o.coil_count AS pending_coil_count,
       o.item_codes AS rm_item_code,
       COALESCE(NULLIF(TRIM(o.item_descs), ''), jc.rm_item_desc) AS rm_item_desc,
       o.mrn_refs AS mrn_nos,
       o.mrn_uids,
       o.created_at,
       o.created_at AS sort_at,
       ir.shift,
       ir.approved_at,
       ir.approved_by AS approved_by_name,
       jc.macname,
       jc.item_code,
       jc.item_desc,
       jc.issue_qty,
       'job_card'::varchar AS pending_type,
       false AS is_virtual_pending,
       (
         SELECT STRING_AGG(s.coil_no_uid, ', ' ORDER BY s.created_at ASC, s.coil_no_uid ASC)
         FROM ${SCANNED} s
         WHERE s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
       ) AS coil_no_uids
     ${fromClause}
     ${where}
     ORDER BY o.created_at DESC, o.out_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};

/**
 * RM Rejection queued for Store Out — virtual pending (no open out_entry draft) + existing drafts.
 * Register approval is skipped; leaves this list once Store Out is authorized.
 */
export const findPendingRejectionStoreOut = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;

  const storeOutApprovedSql = `NOT EXISTS (
    SELECT 1 FROM ${TABLE} o
    WHERE o.is_deleted = false
      AND o.qc_reject_uid = r.qc_reject_uid
      AND COALESCE(o.approved, false) = true
      AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'rm_rejection'
  )`;

  const openDraftExistsSql = `NOT EXISTS (
    SELECT 1 FROM ${TABLE} o
    WHERE o.is_deleted = false
      AND COALESCE(o.approved, false) = false
      AND (
        (r.out_uid IS NOT NULL AND o.out_uid = r.out_uid)
        OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid)
      )
  )`;

  const virtualConditions = [
    "r.is_deleted = false",
    storeOutApprovedSql,
    openDraftExistsSql,
  ];
  const draftConditions = [
    "o.is_deleted = false",
    "COALESCE(o.approved, false) = false",
    "r.is_deleted = false",
    storeOutApprovedSql,
    "(o.out_uid = r.out_uid OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid))",
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    const searchClause = `(
      COALESCE(r.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(r.heat_nos,'') ILIKE $${idx} OR
      COALESCE(r.item_codes,'') ILIKE $${idx} OR
      COALESCE(r.item_descs,'') ILIKE $${idx} OR
      COALESCE(r.reason,'') ILIKE $${idx} OR
      r.qc_reject_uid::text ILIKE $${idx} OR
      COALESCE(r.out_uid::text,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${COIL} c
        WHERE c.is_deleted = false AND c.rm_uid = r.qc_reject_uid
          AND COALESCE(c.coil_no_uid,'') ILIKE $${idx}
      )
    )`;
    virtualConditions.push(searchClause);
    draftConditions.push(`(
      o.out_uid::text ILIKE $${idx} OR
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(o.heat_nos,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(o.item_descs,'') ILIKE $${idx} OR
      COALESCE(r.reason,'') ILIKE $${idx} OR
      r.qc_reject_uid::text ILIKE $${idx}
    )`);
  }

  const virtualWhere = `WHERE ${virtualConditions.join(" AND ")}`;
  const draftWhere = `WHERE ${draftConditions.join(" AND ")}`;

  const virtualRows = await dbQuery(
    `SELECT
       NULL::int AS out_uid,
       r.qc_reject_uid,
       r.mrn_refs AS mrn_no,
       r.mrn_refs,
       r.mrn_uids,
       r.heat_nos AS heat_no,
       r.heat_nos,
       COALESCE(NULLIF(TRIM(r.item_codes), ''), m.item_code) AS rm_item_code,
       COALESCE(NULLIF(TRIM(r.item_descs), ''), m.item_desc) AS rm_item_desc,
       r.item_codes AS item_code,
       r.item_codes,
       r.item_descs,
       r.total_qty AS qty,
       r.total_qty,
       r.coil_count,
       false AS scan_complete,
       r.remarks,
       r.remarks AS rejection_remarks,
       COALESCE(r.approved_at, r.created_at) AS created_at,
       'rm_rejection'::varchar AS entry_type,
       r.reason,
       r.ipr_uid,
       'rejection'::varchar AS pending_type,
       true AS is_virtual_pending,
       COALESCE(r.approved_at, r.created_at) AS sort_at
     FROM ${REJECTION} r
     LEFT JOIN ${MRN} m ON m.uid = NULLIF(TRIM(split_part(COALESCE(r.mrn_uids, ''), '|', 1)), '')
     ${virtualWhere}`,
    values
  );

  const draftFrom = `
    FROM ${TABLE} o
    INNER JOIN ${REJECTION} r ON r.is_deleted = false
      AND (o.out_uid = r.out_uid OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid))`;

  const draftRows = await dbQuery(
    `SELECT
       o.out_uid,
       o.qc_reject_uid,
       o.mrn_refs AS mrn_no,
       o.mrn_refs,
       o.mrn_uids,
       o.heat_nos AS heat_no,
       o.heat_nos,
       COALESCE(NULLIF(TRIM(o.item_codes), ''), NULLIF(TRIM(r.item_codes), ''), m.item_code) AS rm_item_code,
       COALESCE(NULLIF(TRIM(o.item_descs), ''), NULLIF(TRIM(r.item_descs), ''), m.item_desc) AS rm_item_desc,
       o.item_codes AS item_code,
       o.item_codes,
       COALESCE(o.item_descs, r.item_descs) AS item_descs,
       o.total_qty AS qty,
       o.total_qty,
       o.coil_count,
       o.scan_complete,
       o.remarks,
       r.remarks AS rejection_remarks,
       o.created_at,
       o.entry_type,
       r.reason,
       r.ipr_uid,
       'rejection'::varchar AS pending_type,
       false AS is_virtual_pending,
       o.created_at AS sort_at
     ${draftFrom}
     LEFT JOIN ${MRN} m ON m.uid = NULLIF(TRIM(split_part(COALESCE(o.mrn_uids, r.mrn_uids, ''), '|', 1)), '')
     ${draftWhere}`,
    values
  );

  const merged = [...(virtualRows || []), ...(draftRows || [])].sort((a, b) => {
    const ta = new Date(a.sort_at || 0).getTime();
    const tb = new Date(b.sort_at || 0).getTime();
    return tb - ta;
  });

  const total = merged.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;
  const data = merged.slice(offset, offset + safeLimit);

  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};

/** Count non-deleted store-out rows for an issue request (optional exclude one out_uid). */
export const countActiveOutEntriesForIssue = async (issue_uid, excludeOutUid = null) => {
  const issueId = Number(issue_uid);
  if (!Number.isFinite(issueId) || issueId <= 0) return 0;
  const values = [issueId];
  let excludeSql = "";
  if (excludeOutUid != null && excludeOutUid !== "") {
    values.push(Number(excludeOutUid));
    excludeSql = `AND out_uid <> $${values.length}`;
  }
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS cnt
     FROM ${TABLE}
     WHERE is_deleted = false
       AND issue_uid = $1
       AND LOWER(COALESCE(entry_type, 'store_out')) = 'job_card'
       ${excludeSql}`,
    values
  );
  return Number(row?.cnt || 0);
};
