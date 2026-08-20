import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { enrichProductionRow } from "../utils/productionRmHelpers.js";

const TBL = T.MASTER_PRODUCTION;

const ALLOWED_FILTER_FIELDS = ["production_id", "item_dcode", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["production_id", "item_dcode", "item_code", "approved", "created_at", "updated_at"];

function normalizeApprovedFilter(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "approved", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "pending", "draft", "n", "off"].includes(normalized)) return false;
  }
  return value;
}

export const findProductions = async ({ filters = {}, search, sort = {}, page = 1, limit = 10 }) => {
  const values = [];
  let i = 1;
  const conds = ["is_deleted = false"];

  for (const [key, rawVal] of Object.entries(filters)) {
    if (rawVal === undefined || rawVal === null || rawVal === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "from_date") {
      values.push(rawVal);
      conds.push(`created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(rawVal);
      conds.push(`created_at <= $${i++}`);
      continue;
    }

    const val = key === "approved" ? normalizeApprovedFilter(rawVal) : rawVal;
    values.push(val);
    conds.push(`${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conds.push(
      `(item_dcode::text ILIKE $${i} OR COALESCE(item_code, '') ILIKE $${i} OR COALESCE(item_desc, '') ILIKE $${i} OR rm_items::text ILIKE $${i})`
    );
    i++;
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  const [{ count }] = await dbQuery(`SELECT COUNT(*) FROM ${TBL} ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "production_id";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(
    `SELECT * FROM ${TBL} ${where} ORDER BY ${sortByField} ${sortOrder} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, (safePage - 1) * safeLimit]
  );

  return {
    data: rows.map(enrichProductionRow),
    total: Number(count),
    page: safePage,
    limit: safeLimit,
  };
};

export const findProduction = async (filters) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;
  const conds = keys.map((k, idx) => `${k} = $${idx + 1}`).join(" AND ");
  const [row] = await dbQuery(`SELECT * FROM ${TBL} WHERE ${conds} AND is_deleted = false LIMIT 1`, Object.values(filters));
  return row ? enrichProductionRow(row) : null;
};

export const insertProduction = async (data) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TBL}
     (item_dcode, item_code, item_desc, rm_items, approved, approved_by, approved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.item_dcode,
      data.item_code,
      data.item_desc,
      JSON.stringify(data.rm_items || []),
      data.approved === true,
      data.approved_by ?? null,
      data.approved_at ?? null,
      data.created_by,
    ]
  );
  return enrichProductionRow(row);
};

export const updateProductions = async (fields, id) => {
  if (fields.rm_items != null && typeof fields.rm_items !== "string") {
    fields.rm_items = JSON.stringify(fields.rm_items);
  }
  const keys = Object.keys(fields);
  if (!keys.length) return findProduction({ production_id: id });
  const setClause = keys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TBL} SET ${setClause} WHERE production_id = $${keys.length + 1} AND is_deleted = false RETURNING *`,
    [...Object.values(fields), id]
  );
  return row ? enrichProductionRow(row) : null;
};

export const deleteProductions = async (id, deleted_by) => {
  await dbQuery(`UPDATE ${TBL} SET is_deleted = true, deleted_at = NOW(), deleted_by = $1 WHERE production_id = $2`, [deleted_by, id]);
};
