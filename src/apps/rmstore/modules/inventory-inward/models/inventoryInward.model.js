import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.INVENTORY_INWARDS;

export const findInwards = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["i.is_deleted = false"];

  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`i.approved = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`i.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`i.created_at <= $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(i.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(i.heat_nos,'') ILIKE $${idx} OR
      COALESCE(i.item_codes,'') ILIKE $${idx} OR
      COALESCE(i.remarks,'') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} i ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT i.*,
            i.created_by AS created_by_name,
            i.updated_by AS updated_by_name,
            i.approved_by AS approved_by_name
     FROM ${TABLE} i
     ${where}
     ORDER BY i.in_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findInward = async (in_uid) => {
  const id = Number(in_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT i.*,
            i.created_by AS created_by_name,
            i.updated_by AS updated_by_name,
            i.approved_by AS approved_by_name
     FROM ${TABLE} i WHERE i.in_uid = $1 AND i.is_deleted = false LIMIT 1`,
    [id]
  );
  return row ?? null;
};

export const insertInward = async (data) => {
  const {
    mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count, remarks, created_by,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      mrn_refs ?? null, heat_nos ?? null, item_codes ?? null, qtys ?? null,
      total_qty ?? 0, coil_count ?? 0, remarks ?? null, created_by,
    ]
  );
  return row;
};

export const updateInward = async (in_uid, fields = {}) => {
  const allowed = [
    "mrn_refs", "heat_nos", "item_codes", "qtys", "total_qty", "coil_count", "remarks",
    "approved", "approved_by", "approved_at", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findInward(in_uid);
  const values = Object.values(safe);
  values.push(Number(in_uid));
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE in_uid = $${keys.length + 1} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteInward = async (in_uid, deleted_by) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE in_uid = $1 AND is_deleted = false`,
    [Number(in_uid), deleted_by ?? null]
  );
};
