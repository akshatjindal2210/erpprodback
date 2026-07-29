import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.STOCK_ADJUSTMENT;

const ALLOWED_UPDATE = [
  "entry_type",
  "item_dcode",
  "item_code",
  "item_desc",
  "heat_no",
  "acc_code",
  "acc_name",
  "mrn_uid",
  "mrn_no",
  "qty",
  "unit",
  "per_coil_qty",
  "coil_count_impact",
  "removed_coil_uids",
  "remarks",
  "doc_dt",
  "approved",
  "approved_by",
  "approved_at",
  "updated_by",
  "updated_at",
  "is_deleted",
  "deleted_by",
  "deleted_at",
];

function assertFields(obj, whitelist, label) {
  for (const key of Object.keys(obj || {})) {
    if (!whitelist.includes(key)) throw new Error(`Invalid ${label}: "${key}"`);
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
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
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
  if (!Object.keys(fields).length) throw new Error("No changes were provided to update.");
  if (!fieldKeys.length) throw new Error("No filters provided");

  const setClause = Object.keys(fields)
    .map((k, idx) => `${k} = $${idx + 1}`)
    .join(", ");
  const whereClause = fieldKeys
    .map((k, idx) => `${k} = $${Object.keys(fields).length + idx + 1}`)
    .join(" AND ");

  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    [...Object.values(fields), ...Object.values(filters)]
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
