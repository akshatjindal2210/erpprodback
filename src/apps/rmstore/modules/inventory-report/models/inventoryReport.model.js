import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

/**
 * RM Inventory — simple coil qty zones (one readable query).
 *
 * Total Stock     = active coils (in store + unassigned) — excludes shop floor
 * Shop Floor      = status out (issued to machine) — separate from stock
 * In Store        = active + location set
 * Unassigned Area = active + no location (Coil Area)
 * Pending QC      = active + QC not finished (null / draft / awaiting / pending)
 * Pending Reject  = rejected status OR QC failed
 */
export function buildRmInventoryReportSql() {
  const LOC_LABEL = `NULLIF(TRIM(COALESCE(lm.location_no, CONCAT('RM-', lm.rack_no, UPPER(COALESCE(lm.row_no::text, ''))))), '')`;

  const ACTIVE = `COALESCE(c.status, 'active') = 'active'`;
  const IN_STORE = `${ACTIVE} AND c.location_id IS NOT NULL`;
  const UNASSIGNED = `${ACTIVE} AND c.location_id IS NULL`;
  const QC_STATUS = `LOWER(TRIM(COALESCE(c.qc_check_status, '')))`;
  const PENDING_QC = `${ACTIVE} AND ${QC_STATUS} NOT IN ('passed', 'failed')`;
  const PENDING_REJECT = `(
    COALESCE(c.status, 'active') = 'rejected'
    OR ${QC_STATUS} = 'failed'
  )`;
  const SHOP_FLOOR = `COALESCE(c.status, 'active') = 'out'`;

  return `
    SELECT
      COALESCE(NULLIF(TRIM(MAX(c.mrn_uid::text)), ''), MAX(c.mrn_no)::text, '—') AS mrn_uid,
      COALESCE(MAX(c.mrn_no)::text, NULLIF(TRIM(MAX(c.mrn_uid::text)), ''), '—') AS mrn_no,
      COALESCE(
        TO_CHAR(MAX(m.mrn_dt), 'YYYY-MM-DD'),
        TO_CHAR(MIN(c.created_at), 'YYYY-MM-DD')
      ) AS doc_dt,
      COALESCE(NULLIF(TRIM(MAX(c.heat_no)), ''), '—') AS heat_no,
      COALESCE(MAX(c.item_dcode)::text, NULLIF(TRIM(MAX(c.item_code)), ''), '—') AS item_dcode,
      COALESCE(NULLIF(TRIM(MAX(c.item_code)), ''), MAX(c.item_dcode)::text, '—') AS item_code,
      MAX(c.item_desc) AS item_desc,
      COALESCE(MAX(c.acc_code)::text, NULLIF(TRIM(MAX(c.acc_name)), ''), '—') AS customer_code,
      COALESCE(NULLIF(TRIM(MAX(c.acc_name)), ''), MAX(c.acc_code)::text, '—') AS customer_name,

      COALESCE(SUM(c.qty) FILTER (WHERE ${ACTIVE}), 0)::numeric AS total_stock_qty,
      COALESCE(SUM(c.qty) FILTER (WHERE ${SHOP_FLOOR}), 0)::numeric AS shop_floor_qty,
      COALESCE(SUM(c.qty) FILTER (WHERE ${IN_STORE}), 0)::numeric AS in_store_qty,
      COALESCE(SUM(c.qty) FILTER (WHERE ${UNASSIGNED}), 0)::numeric AS unassigned_qty,
      COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_QC}), 0)::numeric AS pending_qc_qty,
      COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_REJECT}), 0)::numeric AS pending_reject_qty,

      COUNT(*) FILTER (WHERE ${IN_STORE})::int AS in_store_coils,
      COUNT(*) FILTER (WHERE ${SHOP_FLOOR})::int AS shop_floor_coils,
      COUNT(*) FILTER (WHERE ${UNASSIGNED})::int AS unassigned_coils,
      COUNT(*) FILTER (WHERE ${ACTIVE})::int AS stock_coil_count,
      COALESCE(
        ARRAY_AGG(c.coil_no_uid::text ORDER BY c.coil_no_uid::text)
          FILTER (WHERE ${ACTIVE} AND NULLIF(TRIM(c.coil_no_uid::text), '') IS NOT NULL),
        ARRAY[]::text[]
      ) AS stock_coil_nos,
      STRING_AGG(DISTINCT ${LOC_LABEL}, ', ') FILTER (WHERE ${IN_STORE}) AS location_details,
      COALESCE(
        ARRAY_AGG(DISTINCT c.location_id::text) FILTER (WHERE ${IN_STORE}),
        ARRAY[]::text[]
      ) AS in_store_location_ids
    FROM ${T.COIL_TABLE} c
    LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
    LEFT JOIN ${T.MASTER_LOCATION} lm
      ON lm.location_id = c.location_id AND lm.is_deleted = false
    WHERE c.is_deleted = false
      AND NULLIF(TRIM(COALESCE(c.item_code, c.item_dcode::text, '')), '') IS NOT NULL
    GROUP BY
      COALESCE(NULLIF(TRIM(c.mrn_uid::text), ''), c.mrn_no::text, '—'),
      COALESCE(NULLIF(TRIM(c.heat_no), ''), '—'),
      COALESCE(c.item_dcode, -1),
      COALESCE(NULLIF(TRIM(c.item_code), ''), ''),
      COALESCE(c.acc_code, -1),
      COALESCE(NULLIF(TRIM(c.acc_name), ''), '')
    HAVING
      COALESCE(SUM(c.qty) FILTER (WHERE ${ACTIVE}), 0) > 0
      OR COALESCE(SUM(c.qty) FILTER (WHERE ${PENDING_REJECT}), 0) > 0
      OR COALESCE(SUM(c.qty) FILTER (WHERE ${SHOP_FLOOR}), 0) > 0
  `;
}

export async function findRmInventoryReport(options = {}) {
  const { filters = {}, search, page = 1, limit = 10000 } = options;
  const values = [];
  let i = 1;
  const conditions = [];

  if (filters.item_code) {
    values.push(String(filters.item_code).trim());
    conditions.push(`UPPER(trim(rep.item_code)) = UPPER(trim($${i++}))`);
  }
  if (filters.mrn_no) {
    values.push(String(filters.mrn_no).trim());
    conditions.push(`rep.mrn_no::text = $${i++}`);
  }
  if (filters.heat_no) {
    values.push(String(filters.heat_no).trim());
    conditions.push(`UPPER(trim(rep.heat_no)) = UPPER(trim($${i++}))`);
  }
  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(rep.mrn_no,'') ILIKE $${idx} OR
      COALESCE(rep.heat_no,'') ILIKE $${idx} OR
      COALESCE(rep.item_code,'') ILIKE $${idx} OR
      COALESCE(rep.item_desc,'') ILIKE $${idx} OR
      COALESCE(rep.customer_name,'') ILIKE $${idx} OR
      COALESCE(rep.location_details,'') ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const baseSql = buildRmInventoryReportSql();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 10000));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (${baseSql}) rep ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const rows = await dbQuery(
    `SELECT
       CONCAT(
         COALESCE(rep.mrn_uid, ''), ':',
         COALESCE(rep.heat_no, ''), ':',
         COALESCE(rep.item_dcode, ''), ':',
         COALESCE(rep.customer_code, ''), ':',
         COALESCE(rep.doc_dt, '')
       ) AS id,
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
       COALESCE(rep.total_stock_qty, 0) AS total_stock_qty,
       COALESCE(rep.shop_floor_qty, 0) AS shop_floor_qty,
       COALESCE(rep.in_store_qty, 0) AS in_store_qty,
       COALESCE(rep.unassigned_qty, 0) AS unassigned_qty,
       COALESCE(rep.pending_qc_qty, 0) AS pending_qc_qty,
       COALESCE(rep.pending_reject_qty, 0) AS pending_reject_qty,
       COALESCE(rep.in_store_coils, 0) AS in_store_coils,
       COALESCE(rep.shop_floor_coils, 0) AS shop_floor_coils,
       COALESCE(rep.stock_coil_count, 0) AS stock_coil_count,
       COALESCE(rep.stock_coil_nos, ARRAY[]::text[]) AS stock_coil_nos
     FROM (${baseSql}) rep
     ${where}
     ORDER BY
       NULLIF(regexp_replace(rep.mrn_no::text, '\\D', '', 'g'), '')::bigint DESC NULLS LAST,
       rep.mrn_no DESC,
       rep.doc_dt DESC NULLS LAST,
       rep.item_code ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
}
