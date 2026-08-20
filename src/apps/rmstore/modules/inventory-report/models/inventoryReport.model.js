import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { coilQcStatusExpr, coilQcJoinForAlias } from "../../../lib/utils/coilQcStatusSql.js";

/**
 * RM Inventory Report — single source of truth (rmstore_coil_table only).
 *
 * Physical buckets (where material is):
 *   In Store    = on rack (location set) · not shop floor · not consumed
 *   Unassigned  = no rack location · not shop floor · not consumed
 *   Shop Floor  = issued out (out_uid set)
 *
 * Total Stock  = In Store + Unassigned + Shop Floor (physical — includes QC pending / RM rejection)
 * Issuable     = in store + unassigned · QC passed · not RM rejection · not consumed · not shop floor
 * QC Pending   = subset awaiting QC (informational; already counted in In Store / Unassigned)
 */

const MRN_NO_FROM_UID = `CASE
  WHEN NULLIF(TRIM(c.mrn_uid::text), '') ~ '^[0-9]+_' THEN split_part(TRIM(c.mrn_uid::text), '_', 1)
  ELSE NULL
END`;

/** Shared coil predicates — keep all bucket rules in one place. */
function buildCoilRules(alias = "c", qcAlias = "q") {
  const STATUS = `LOWER(TRIM(COALESCE(${alias}.status, 'active')))`;
  const QC = coilQcStatusExpr(alias, qcAlias);
  const QC_PASSED = `(${QC} = 'passed' OR ${alias}.sa_id IS NOT NULL)`;
  const NOT_CONSUMED = `${STATUS} <> 'consumed'`;
  /** In warehouse (not issued out) — includes active + rejected (RM rejection). */
  const NOT_SHOP_FLOOR = `${STATUS} NOT IN ('out', 'consumed') AND ${alias}.out_uid IS NULL`;
  const NOT_RM_REJECTION = `NOT (${QC} = 'failed' OR ${STATUS} = 'rejected')`;

  /** Physical location — QC / rejection status ignored. */
  // const IN_STORE = `${NOT_SHOP_FLOOR} AND ${NOT_CONSUMED} AND ${alias}.location_id IS NOT NULL`;
  // const UNASSIGNED = `${NOT_SHOP_FLOOR} AND ${NOT_CONSUMED} AND ${alias}.location_id IS NULL`;
  // const IN_WAREHOUSE = `(${IN_STORE}) OR (${UNASSIGNED})`;
  
  // /** Issuable — QC passed only (subset of physical warehouse). */
  // const ISSUABLE = `${IN_WAREHOUSE} AND ${NOT_RM_REJECTION} AND ${QC_PASSED}`;
  
  /* Physical location — QC / rejection status ignored. */
  const IN_STORE = `(${NOT_SHOP_FLOOR} AND ${NOT_CONSUMED} AND ${alias}.location_id IS NOT NULL)`;
  const UNASSIGNED = `(${NOT_SHOP_FLOOR} AND ${NOT_CONSUMED} AND ${alias}.location_id IS NULL)`;
  const IN_WAREHOUSE = `(${IN_STORE} OR ${UNASSIGNED})`;

  /** Issuable = warehouse + QC passed + no RM rejection */
  const ISSUABLE = `(${IN_WAREHOUSE} AND ${NOT_RM_REJECTION} AND ${QC_PASSED})`;

  const SHOP_FLOOR = `${STATUS} = 'out' AND ${alias}.out_uid IS NOT NULL`;
  const PENDING_QC = `${STATUS} = 'active' AND ${alias}.sa_id IS NULL AND ${QC} NOT IN ('passed', 'failed') AND ${alias}.out_uid IS NULL`;
  const PENDING_REJECT = `(${QC} = 'failed' OR ${STATUS} = 'rejected') AND ${STATUS} NOT IN ('out', 'consumed') AND ${alias}.out_uid IS NULL`;

  return { IN_STORE, UNASSIGNED, IN_WAREHOUSE, ISSUABLE, SHOP_FLOOR, PENDING_QC, PENDING_REJECT };
}

function locationLabelSql(cAlias, lmAlias = "lm") {
  return `CASE
    WHEN ${cAlias}.location_id IS NULL THEN '—'
    ELSE COALESCE(NULLIF(TRIM(${lmAlias}.location_no), ''), CONCAT('RM-', ${lmAlias}.rack_no, UPPER(COALESCE(${lmAlias}.row_no::text, ''))))
  END`;
}

function locationDetailsSubquerySql(mrnUidRef) {
  const rules = buildCoilRules("c2", "q2");
  const label = locationLabelSql("c2", "lm2");
  return `(
    SELECT NULLIF(
      STRING_AGG(loc_parts.part, ', ' ORDER BY loc_parts.sort_key, loc_parts.part_label),
      ''
    )
    FROM (
      SELECT
        CASE WHEN c2.location_id IS NULL THEN 0 ELSE 1 END AS sort_key,
        ${label} AS part_label,
        ${label} || ' (' || COUNT(*)::text || ')' AS part
      FROM ${T.COIL_TABLE} c2
      LEFT JOIN ${T.MASTER_LOCATION} lm2 ON lm2.location_id = c2.location_id AND lm2.is_deleted = false
      ${coilQcJoinForAlias("c2", "q2")}
      WHERE c2.is_deleted = false
        AND COALESCE(NULLIF(TRIM(c2.mrn_uid::text), ''), '—') = ${mrnUidRef}
        AND (${rules.ISSUABLE})
      GROUP BY c2.location_id, ${label}
    ) loc_parts
  )`;
}

export function buildRmInventoryReportSql() {
  const rules = buildCoilRules("c");
  const { IN_STORE, UNASSIGNED, IN_WAREHOUSE, ISSUABLE, SHOP_FLOOR, PENDING_QC, PENDING_REJECT } = rules;

  const HEAT_DISPLAY = `COALESCE(
    NULLIF(TRIM(MAX(COALESCE(NULLIF(TRIM(m.heat_no), ''), NULLIF(TRIM(m.it_lot_no), '')))), ''),
    '—'
  )`;

  const groupedSql = `
SELECT
  COALESCE(NULLIF(TRIM(c.mrn_uid::text), ''), '—') AS mrn_uid,
  COALESCE(MAX(m.mrn_no)::text, MAX(${MRN_NO_FROM_UID}), '—') AS mrn_no,
  COALESCE(
    MAX(m.mrn_no),
    CASE WHEN MAX(${MRN_NO_FROM_UID}) ~ '^[0-9]+$' THEN (MAX(${MRN_NO_FROM_UID}))::int ELSE NULL END
  ) AS mrn_no_sort,
  COALESCE(TO_CHAR(MAX(m.mrn_dt), 'YYYY-MM-DD'), TO_CHAR(MIN(c.created_at), 'YYYY-MM-DD'), '—') AS doc_dt,
  ${HEAT_DISPLAY} AS heat_no,
  COALESCE(MAX(m.item_dcode)::text, '—') AS item_dcode,
  COALESCE(NULLIF(TRIM(MAX(m.item_code)), ''), MAX(m.item_dcode)::text, '—') AS item_code,
  MAX(m.item_desc) AS item_desc,
  COALESCE(MAX(m.acc_code)::text, '—') AS customer_code,
  COALESCE(NULLIF(TRIM(MAX(m.acc_name)), ''), MAX(m.acc_code)::text, '—') AS customer_name,

  COALESCE(SUM(c.qty) FILTER (WHERE ${ISSUABLE}), 0)::numeric AS issuable_qty,
  COALESCE(SUM(c.qty) FILTER (WHERE ${IN_STORE}), 0)::numeric AS in_store_qty,
  COALESCE(SUM(c.qty) FILTER (WHERE ${UNASSIGNED}), 0)::numeric AS unassigned_qty,
  COALESCE(SUM(c.qty) FILTER (WHERE ${SHOP_FLOOR}), 0)::numeric AS shop_floor_qty,
  COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_QC}), 0)::numeric AS pending_qc_qty,
  COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_REJECT}), 0)::numeric AS pending_reject_qty,

  COUNT(*) FILTER (WHERE ${IN_STORE})::int AS in_store_coils,
  COUNT(*) FILTER (WHERE ${UNASSIGNED})::int AS unassigned_coils,
  COUNT(*) FILTER (WHERE ${ISSUABLE})::int AS issuable_coil_count,
  COUNT(*) FILTER (WHERE ${SHOP_FLOOR})::int AS shop_floor_coils,

  COALESCE(ARRAY_AGG(DISTINCT c.location_id::text) FILTER (WHERE ${IN_STORE}), ARRAY[]::text[]) AS in_store_location_ids,

  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${ISSUABLE}) AS issuable_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${IN_STORE} OR ${UNASSIGNED} OR ${SHOP_FLOOR}) AS total_stock_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${IN_STORE}) AS in_store_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${UNASSIGNED}) AS unassigned_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${SHOP_FLOOR}) AS shop_floor_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${PENDING_QC}) AS pending_qc_coil_uids,
  STRING_AGG(DISTINCT c.coil_no_uid, E'\\n' ORDER BY c.coil_no_uid) FILTER (WHERE ${PENDING_REJECT}) AS pending_reject_coil_uids

FROM ${T.COIL_TABLE} c
LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
${coilQcJoinForAlias("c", "q")}

WHERE c.is_deleted = false

GROUP BY COALESCE(NULLIF(TRIM(c.mrn_uid::text), ''), '—')

HAVING
  COALESCE(SUM(c.qty) FILTER (WHERE ${IN_STORE}), 0) > 0
  OR COALESCE(SUM(c.qty) FILTER (WHERE ${UNASSIGNED}), 0) > 0
  OR COALESCE(SUM(c.qty) FILTER (WHERE ${SHOP_FLOOR}), 0) > 0
  OR COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_QC}), 0) > 0
  OR COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_REJECT}), 0) > 0
`;

  return `
  SELECT
    grouped.*,
    COALESCE(${locationDetailsSubquerySql("grouped.mrn_uid")}, '—') AS location_details
  FROM (${groupedSql}) grouped
  `;
}

export async function findRmInventoryReport(options = {}) {
  const { filters = {}, search, page = 1, limit = 10000 } = options;
  const values = [];
  let i = 1;
  const conditions = [];

  if (filters.item_code) {
    values.push(String(filters.item_code).trim());
    conditions.push(`UPPER(TRIM(rep.item_code)) = UPPER(TRIM($${i++}))`);
  }

  if (filters.mrn_no) {
    values.push(String(filters.mrn_no).trim());
    conditions.push(`rep.mrn_no::text = $${i++}`);
  }

  if (filters.heat_no) {
    values.push(String(filters.heat_no).trim());
    conditions.push(`UPPER(TRIM(rep.heat_no)) = UPPER(TRIM($${i++}))`);
  }

  if (search) {
    values.push(`%${String(search).trim()}%`);
    const idx = i++;
    conditions.push(`(
      COALESCE(rep.mrn_uid, '') ILIKE $${idx}
      OR COALESCE(rep.mrn_no, '') ILIKE $${idx}
      OR COALESCE(rep.heat_no, '') ILIKE $${idx}
      OR COALESCE(rep.item_code, '') ILIKE $${idx}
      OR COALESCE(rep.item_dcode, '') ILIKE $${idx}
      OR COALESCE(rep.item_desc, '') ILIKE $${idx}
      OR COALESCE(rep.customer_name, '') ILIKE $${idx}
      OR COALESCE(rep.location_details, '') ILIKE $${idx}
      OR COALESCE(rep.total_stock_coil_uids, '') ILIKE $${idx}
      OR COALESCE(rep.issuable_coil_uids, '') ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const baseSql = buildRmInventoryReportSql();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 10000));
  const offset = (safePage - 1) * safeLimit;
  const limitParam = i++;
  const offsetParam = i++;

  const rows = await dbQuery(
    `SELECT
      CONCAT(COALESCE(rep.mrn_uid, ''), ':', COALESCE(rep.heat_no, ''), ':', COALESCE(rep.item_dcode, ''), ':', COALESCE(rep.customer_code, ''), ':', COALESCE(rep.doc_dt, '')) AS id,
      rep.mrn_uid,
      rep.mrn_no,
      rep.doc_dt,
      rep.heat_no,
      rep.item_dcode,
      rep.item_code,
      rep.item_desc,
      rep.customer_code,
      rep.customer_name,
      COALESCE(rep.location_details, '—') AS location_details,
      COALESCE(rep.in_store_location_ids, ARRAY[]::text[]) AS in_store_location_ids,
      COALESCE(rep.in_store_qty, 0) + COALESCE(rep.unassigned_qty, 0) + COALESCE(rep.shop_floor_qty, 0) AS total_stock_qty,
      COALESCE(rep.issuable_qty, 0) AS issuable_qty,
      COALESCE(rep.in_store_qty, 0) AS in_store_qty,
      COALESCE(rep.unassigned_qty, 0) AS unassigned_qty,
      COALESCE(rep.shop_floor_qty, 0) AS shop_floor_qty,
      COALESCE(rep.pending_qc_qty, 0) AS pending_qc_qty,
      COALESCE(rep.pending_reject_qty, 0) AS pending_reject_qty,
      COALESCE(rep.in_store_coils, 0) AS in_store_coils,
      COALESCE(rep.unassigned_coils, 0) AS unassigned_coils,
      COALESCE(rep.issuable_coil_count, 0) AS issuable_coil_count,
      COALESCE(rep.shop_floor_coils, 0) AS shop_floor_coils,
      rep.issuable_coil_uids,
      rep.total_stock_coil_uids,
      rep.in_store_coil_uids,
      rep.unassigned_coil_uids,
      rep.shop_floor_coil_uids,
      rep.pending_qc_coil_uids,
      rep.pending_reject_coil_uids,
      COUNT(*) OVER()::int AS _report_total
    FROM (${baseSql}) rep
    ${where}
    ORDER BY rep.mrn_no_sort DESC NULLS LAST, rep.doc_dt DESC NULLS LAST, rep.item_code ASC
    LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...values, safeLimit, offset],
  );

  const total = rows.length ? Number(rows[0]._report_total) || 0 : 0;
  const data = rows.map(({ _report_total, ...row }) => row);

  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
}
