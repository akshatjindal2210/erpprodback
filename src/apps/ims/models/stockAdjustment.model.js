import dbQuery from "../../../config/db.js";
import { findAdjustments } from "../utils/stock-adjustment/stockAdjustmentList.js";

export { findAdjustments } from "../utils/stock-adjustment/stockAdjustmentList.js";

const ALLOWED_UPDATE_FIELDS = [
  "item_dcode",
  "qty",
  "unit",
  "remarks",
  "entry_type",
  "packing_number",
  "financial_year",
  "per_box_qty",
  "box_count_impact",
  "removed_box_ids",
  "acc_code",
  "doc_dt",
  "job_card_no",
  "item_code",
  "item_desc",
  "acc_name",
  "category_id",
  "approved",
  "approved_by",
  "approved_at",
  "updated_by",
  "updated_at",
  "is_deleted",
  "deleted_by",
  "deleted_at",
];

const ALLOWED_FILTER_FIELDS = ["adjustment_id", "is_deleted"];

function assertField(key, whitelist, context = "field") {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
}

export const findAdjustmentById = async (id) => {
  const result = await findAdjustments({
    filters: { adjustment_id: id },
    page: 1,
    limit: 1,
  });
  return result.data?.[0] ?? null;
};

// --- CREATE ---
export const insertAdjustment = async (data) => {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");

  const [row] = await dbQuery(
    `INSERT INTO ims_stock_adjustment (${keys.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return row;
};

export const insertAdjustmentTx = async (client, data) => {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
  const { rows } = await client.query(
    `INSERT INTO ims_stock_adjustment (${keys.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );
  return rows[0];
};

// --- UPDATE ---
export const updateAdjustments = async (fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length) throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values = [...Object.values(fields), ...Object.values(filters)];

  return await dbQuery(
    `UPDATE ims_stock_adjustment
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    values
  );
};

export const updateAdjustmentsTx = async (client, fields = {}, filters = {}) => {
  const fieldKeys = Object.keys(fields);
  const filterKeys = Object.keys(filters);

  if (!fieldKeys.length) throw new Error("No fields to update");
  if (!filterKeys.length) throw new Error("No filters provided");

  for (const key of fieldKeys) assertField(key, ALLOWED_UPDATE_FIELDS, "update field");
  for (const key of filterKeys) assertField(key, ALLOWED_FILTER_FIELDS, "filter field");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const vals = [...Object.values(fields), ...Object.values(filters)];

  const { rows } = await client.query(
    `UPDATE ims_stock_adjustment
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    vals
  );
  return rows;
};

/** Latest `financial_year` on stock adjustment for this packing (same IMS source as SA view drawer). */
export const findFinancialYearForPacking = async (packing_number) => {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return null;
  const [row] = await dbQuery(
    `SELECT financial_year
     FROM ims_stock_adjustment
     WHERE trim(packing_number::text) = trim($1::text)
       AND financial_year IS NOT NULL
       AND trim(financial_year::text) <> ''
     ORDER BY adjustment_id DESC
     LIMIT 1`,
    [pn]
  );
  const fy = row?.financial_year;
  return fy != null && String(fy).trim() !== "" ? String(fy).trim() : null;
};

export const findFinancialYearForSaId = async (adjustment_id) => {
  const id = Number(adjustment_id);
  if (!Number.isFinite(id) || id < 1) return null;
  const [row] = await dbQuery(
    `SELECT financial_year
     FROM ims_stock_adjustment
     WHERE adjustment_id = $1::int
       AND financial_year IS NOT NULL
       AND trim(financial_year::text) <> ''
     LIMIT 1`,
    [id]
  );
  const fy = row?.financial_year;
  return fy != null && String(fy).trim() !== "" ? String(fy).trim() : null;
};
