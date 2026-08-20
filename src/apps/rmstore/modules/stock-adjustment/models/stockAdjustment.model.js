import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

import { SA_ADD_LIKE_ENTRY_TYPES_SQL } from "../utils/stockAdjustmentEntryTypes.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.STOCK_ADJUSTMENT;

const ALLOWED_UPDATE = [
  "entry_type",
  "financial_year",
  "it_lot_no",
  "item_dcode",
  "item_code",
  "item_desc",
  "heat_no",
  "acc_code",
  "acc_name",
  "mrn_uid",
  "mrn_no",
  "serial_no",
  "mrn_dt",
  "bill_no",
  "bill_dt",
  "qty",
  "unit",
  "per_coil_qty",
  "coil_qtys",
  "coil_count_impact",
  "removed_coil_uids",
  "remarks",
  "doc_dt",
  "tc_file_path",
  "tc_file_name",
  "rmtc_file_path",
  "rmtc_file_name",
  "approved",
  "approved_by",
  "approved_at",
  "updated_by",
  "updated_at",
  "is_deleted",
  "deleted_by",
  "deleted_at",
];

/** JSONB columns — must be JSON.stringify + ::jsonb (not raw JS arrays). */
const JSONB_COLS = new Set(["coil_qtys"]);

function prepJsonbValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sqlPlaceholder(key, index) {
  return JSONB_COLS.has(key) ? `$${index}::jsonb` : `$${index}`;
}

function prepFieldValue(key, value) {
  return JSONB_COLS.has(key) ? prepJsonbValue(value) : value;
}

function assertFields(obj, whitelist, label) {
  for (const key of Object.keys(obj || {})) {
    if (!whitelist.includes(key)) throw new Error(`Unknown ${label}: ${key}`);
  }
}

export async function findAdjustments({ filters = {}, search, page = 1, limit = 100 } = {}) {
  const values = [];
  let i = 1;
  const conditions = ["s.is_deleted = false"];

  if (filters.adjustment_id != null && filters.adjustment_id !== "") {
    values.push(Number(filters.adjustment_id));
    conditions.push(`s.adjustment_id = $${i++}`);
  }
  if (filters.approved === true || filters.approved === false) {
    values.push(filters.approved);
    conditions.push(`s.approved = $${i++}`);
  }
  if (filters.entry_type) {
    values.push(String(filters.entry_type).trim().toLowerCase());
    conditions.push(`LOWER(s.entry_type) = $${i++}`);
  }
  if (filters.from_date || filters.fromDate) {
    values.push(filters.from_date || filters.fromDate);
    conditions.push(`s.created_at >= $${i++}::timestamp`);
  }
  if (filters.to_date || filters.toDate) {
    values.push(filters.to_date || filters.toDate);
    conditions.push(`s.created_at <= $${i++}::timestamp`);
  }
  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(s.item_code,'') ILIKE $${idx} OR
      COALESCE(s.item_desc,'') ILIKE $${idx} OR
      COALESCE(s.heat_no,'') ILIKE $${idx} OR
      COALESCE(s.it_lot_no,'') ILIKE $${idx} OR
      COALESCE(s.financial_year,'') ILIKE $${idx} OR
      COALESCE(s.remarks,'') ILIKE $${idx} OR
      COALESCE(s.entry_type,'') ILIKE $${idx} OR
      s.adjustment_id::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${TABLE} s ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT
       s.*,
       s.created_by AS created_by_name,
       s.updated_by AS updated_by_name,
       s.approved_by AS approved_by_name
     FROM ${TABLE} s
     ${where}
     ORDER BY s.adjustment_id DESC
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
}

export async function findAdjustmentById(id) {
  const adjId = Number(id);
  if (!Number.isFinite(adjId) || adjId <= 0) return null;
  const result = await findAdjustments({ filters: { adjustment_id: adjId }, page: 1, limit: 1 });
  return result.data?.[0] ?? null;
}

export async function insertAdjustment(data) {
  const keys = Object.keys(data);
  const values = keys.map((k) => prepFieldValue(k, data[k]));
  const placeholders = keys.map((k, idx) => sqlPlaceholder(k, idx + 1)).join(", ");
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (${keys.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return row;
}

export async function updateAdjustment(fields = {}, filters = {}) {
  assertFields(fields, ALLOWED_UPDATE, "update field");
  const fieldKeys = Object.keys(filters);
  if (!Object.keys(fields).length) throw new Error("Nothing to update.");
  if (!fieldKeys.length) throw new Error("Update needs a filter.");

  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(fields, {
    jsonKeys: JSONB_COLS,
    nowKeys: ["updated_at", "approved_at", "deleted_at"],
  });
  const whereClause = fieldKeys
    .map((k, idx) => `${k} = $${nextIndex + idx}`)
    .join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET ${setParts.join(", ")}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    [...values, ...Object.values(filters)]
  );
  return row ?? null;
}

export async function softDeleteAdjustment(id, userName) {
  return updateAdjustment(
    {
      is_deleted: true,
      deleted_by: userName ?? null,
      deleted_at: new Date(),
      updated_by: userName ?? null,
      updated_at: new Date(),
    },
    { adjustment_id: Number(id) }
  );
}

/** Sum Add (+) qty already booked on an MRN (approved + pending), excluding one adjustment when editing. */
export async function sumPriorAddQtyForMrn(mrn_uid, excludeAdjustmentId = null) {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const values = [uid];
  let exclude = "";
  const excludeId = Number(excludeAdjustmentId);
  if (Number.isFinite(excludeId) && excludeId > 0) {
    values.push(excludeId);
    exclude = ` AND s.adjustment_id <> $2`;
  }
  const [row] = await dbQuery(
    `SELECT COALESCE(SUM(s.qty), 0)::float AS total
     FROM ${TABLE} s
     WHERE s.is_deleted = false
       AND LOWER(s.entry_type) IN ${SA_ADD_LIKE_ENTRY_TYPES_SQL}
       AND TRIM(s.mrn_uid) = $1
       ${exclude}`,
    values
  );
  return Number(row?.total || 0);
}

/** Pending Add (+) qty on an MRN — not yet converted to coils (exclude when editing that row). */
export async function sumPendingAddQtyForMrn(mrn_uid, excludeAdjustmentId = null) {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const values = [uid];
  let exclude = "";
  const excludeId = Number(excludeAdjustmentId);
  if (Number.isFinite(excludeId) && excludeId > 0) {
    values.push(excludeId);
    exclude = ` AND s.adjustment_id <> $2`;
  }
  const [row] = await dbQuery(
    `SELECT COALESCE(SUM(s.qty), 0)::float AS total
     FROM ${TABLE} s
     WHERE s.is_deleted = false
       AND LOWER(s.entry_type) IN ${SA_ADD_LIKE_ENTRY_TYPES_SQL}
       AND COALESCE(s.approved, false) = false
       AND TRIM(s.mrn_uid) = $1
       ${exclude}`,
    values
  );
  return Number(row?.total || 0);
}
