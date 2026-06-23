/**
 * Packing Area list — boxes with no location (in-hand, sellable).
 *
 * Step 1: Query ims_box_table → group by packing + item + customer → qty / box count
 * Step 2: Attach doc_dt / job card / item / customer from local SA + dailyprod
 */

import dbQuery from "../../../../config/db.js";
import { sqlBoxSellable, sqlBoxPackingNumber, sqlDailyprodDocNoMatch, sqlDailyprodMatchOrder, sqlDocDtFromDailyprod, sqlDocDtText } from "../box/boxInventorySql.js";

const TRIM = (expr) => `NULLIF(TRIM((${expr})::text), '')`;
const DP_ITEM_CODE = TRIM("dp.item_code");
const DP_ITEM_DESC = TRIM("dp.item_desc");
const DP_ACC_NAME = TRIM("dp.acc_name");
const SA_ITEM_CODE = TRIM("sa.item_code");
const SA_ITEM_DESC = TRIM("sa.item_desc");
const SA_ACC_NAME = TRIM("sa.acc_name");

const PACKING_AREA_WHERE = (alias = "b") => [
  `${alias}.is_deleted = false`,
  sqlBoxSellable(alias),
  `${alias}.location_id IS NULL`,
  `NULLIF(TRIM(${alias}.packing_number::text), '-') IS NOT NULL`,
];

const BOX_ITEM_SQL = `COALESCE(NULLIF(TRIM(sa.item_dcode::text), ''), '—')`;
const BOX_CUST_SQL = `COALESCE(NULLIF(TRIM(b.override_cust::text), ''), NULLIF(TRIM(sa.acc_code::text), ''))`;

function packingNumberSortExpr(columnRef, direction = "DESC") {
  const dir = String(direction).toUpperCase() === "ASC" ? "ASC" : "DESC";
  return `NULLIF(regexp_replace(${columnRef}::text, '[^0-9]', '', 'g'), '')::bigint ${dir} NULLS LAST, ${columnRef} ${dir}`;
}

function resolveSummaryOrder(sortCol, sortOrder) {
  const dir = sortOrder === "DESC" ? "DESC" : "ASC";
  if (sortCol === "packing_number") return packingNumberSortExpr("packing_number", dir);
  return `${sortCol} ${dir} NULLS LAST`;
}

const SUMMARY_SORT = {
  packing_number: "packing_number",
  box_count: "box_count",
  stock_qty: "stock_qty",
  doc_dt: "doc_dt",
  job_card_no: "job_card_no",
};

const BOX_SORT = {
  box_no_uid: "b.box_no_uid",
  packing_number: "packing_number",
  qty: "b.qty",
  created_at: "b.created_at",
};

function resolveBoxOrder(sortCol, sortOrder) {
  const dir = sortOrder === "DESC" ? "DESC" : "ASC";
  if (sortCol === "packing_number") return packingNumberSortExpr("packing_number", dir);
  return `${sortCol} ${dir}`;
}

const META_FIELDS = [
  "doc_dt",
  "job_card_no",
  "item_code",
  "acc_name",
  "acc_code",
  "item_desc",
  "item_dcode",
];

function isFilled(v) {
  return v != null && String(v).trim() !== "" && String(v).trim() !== "—";
}

function rowKey(row) {
  const pn = String(row?.packing_number ?? "").trim();
  const item = String(row?.item_dcode ?? "").trim() || "—";
  const acc = String(row?.acc_code ?? "").trim() || "";
  return `${pn}:${item}:${acc}`;
}

function uniqueContexts(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const pn = String(row?.packing_number ?? "").trim();
    if (!pn) continue;
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      packing_number: pn,
      item_dcode: row.item_dcode,
      acc_code: row.acc_code,
      sa_financial_year: row.sa_financial_year != null ? String(row.sa_financial_year).trim() : "",
    });
  }
  return out;
}

/** Prefer `next` when filled, else keep `prev`. */
function mergeFields(prev = {}, next = {}, { preferNext = true } = {}) {
  const out = { ...prev };
  for (const field of META_FIELDS) {
    const n = next[field];
    const p = prev[field];
    out[field] = preferNext && isFilled(n) ? n : isFilled(p) ? p : n ?? p ?? null;
  }
  return out;
}

function mergeDisplayMeta(sa, dp) {
  if (!sa && !dp) return null;
  return {
    doc_dt: sa?.doc_dt ?? dp?.doc_dt ?? null,
    job_card_no: sa?.job_card_no ?? dp?.job_card_no ?? null,
    item_code: sa?.item_code ?? dp?.item_code ?? null,
    item_desc: sa?.item_desc ?? dp?.item_desc ?? null,
    acc_name: sa?.acc_name ?? dp?.acc_name ?? null,
    item_dcode: dp?.item_dcode ?? null,
    acc_code: dp?.acc_code ?? sa?.acc_code ?? null,
  };
}

/** Resolve date / names from local SA + dailyprod (no IMS). */
async function resolvePackingDisplayMeta(rows) {
  const contexts = uniqueContexts(rows);
  const map = new Map();
  if (!contexts.length) return map;

  const [dpMap, saMap] = await Promise.all([
    fetchDailyprodDocMetaByContexts(contexts),
    fetchSaPackingMetaByContexts(contexts),
  ]);

  for (const ctx of contexts) {
    const merged = mergeDisplayMeta(saMap.get(ctx.key), dpMap.get(ctx.key));
    if (merged) map.set(ctx.key, merged);
  }
  return map;
}

function applyMetaToRow(row, meta) {
  if (!meta) return row;
  const merged = mergeFields(row, meta, { preferNext: true });
  return {
    ...row,
    ...merged,
    stock_qty: row.stock_qty,
    box_count: row.box_count,
  };
}

function paginate(page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  return { safePage, safeLimit, offset: (safePage - 1) * safeLimit };
}

function packingAreaBaseSql(whereClause) {
  const pn = sqlBoxPackingNumber("b");
  return `
    SELECT
      ${pn} AS packing_number,
      ${BOX_ITEM_SQL} AS item_dcode,
      ${BOX_CUST_SQL} AS acc_code,
      NULLIF(TRIM(sa.financial_year::text), '') AS sa_financial_year,
      COALESCE(b.qty, 0)::int AS qty
    FROM ims_box_table b
    LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
    WHERE ${whereClause}`;
}

export async function attachPackingDisplayMeta(rows = []) {
  if (!rows?.length) return rows;
  const metaMap = await resolvePackingDisplayMeta(rows);
  return rows.map((row) => applyMetaToRow(row, metaMap.get(rowKey(row))));
}

/** Local dailyprod snapshot — packing only (no item/customer context). */
export async function fetchDailyprodDocMetaByPackings(packingNumbers = []) {
  const nums = [...new Set((packingNumbers || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!nums.length) return new Map();

  const rows = await dbQuery(
    `SELECT
       TRIM(x.pn::text) AS packing_number,
       ${sqlDocDtFromDailyprod("dp")} AS doc_dt,
       dp.job_card_no,
       ${DP_ITEM_CODE} AS item_code,
       ${DP_ITEM_DESC} AS item_desc,
       ${DP_ACC_NAME} AS acc_name,
       dp.item_dcode,
       dp.acc_code
     FROM unnest($1::text[]) AS x(pn)
     LEFT JOIN LATERAL (
       SELECT
         dp2.doc_dt,
         dp2.job_card_no,
         dp2.item_code,
         dp2.item_desc,
         dp2.acc_name,
         dp2.item_dcode,
         dp2.acc_code
       FROM ims_dailyprod dp2
       WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", "x.pn")}
       ORDER BY
         (CASE WHEN dp2.doc_dt IS NOT NULL THEN 0 ELSE 1 END) ASC,
         dp2.doc_dt ASC NULLS LAST
       LIMIT 1
     ) dp ON true`,
    [nums]
  );

  const map = new Map();
  for (const r of rows || []) {
    const pn = String(r.packing_number).trim();
    map.set(pn, r);
    if (/^\d+$/.test(pn)) map.set(String(Number(pn)), r);
  }
  for (const num of nums) {
    if (map.has(num)) continue;
    const n = String(num).trim();
    if (/^\d+$/.test(n) && map.has(String(Number(n)))) map.set(n, map.get(String(Number(n))));
  }
  return map;
}

/** Local dailyprod — match packing + item, then customer (duplicate docno safe). */
export async function fetchDailyprodDocMetaByContexts(contexts = []) {
  const list = (contexts || [])
    .map((c) => ({
      key: c.key ?? rowKey(c),
      packing_number: String(c?.packing_number ?? "").trim(),
      item_dcode: String(c?.item_dcode ?? "").trim() || "—",
      acc_code: String(c?.acc_code ?? "").trim(),
    }))
    .filter((c) => c.packing_number);
  if (!list.length) return new Map();

  const rows = await dbQuery(
    `SELECT
       TRIM(x.ctx_key::text) AS ctx_key,
       ${sqlDocDtFromDailyprod("dp")} AS doc_dt,
       dp.job_card_no,
       ${DP_ITEM_CODE} AS item_code,
       ${DP_ITEM_DESC} AS item_desc,
       ${DP_ACC_NAME} AS acc_name,
       dp.item_dcode,
       dp.acc_code
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       AS x(ctx_key, pn, item_dcode, acc_code)
     LEFT JOIN LATERAL (
       SELECT
         dp2.doc_dt,
         dp2.job_card_no,
         dp2.item_code,
         dp2.item_desc,
         dp2.acc_name,
         dp2.item_dcode,
         dp2.acc_code
       FROM ims_dailyprod dp2
       WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", "x.pn")}
       ORDER BY ${sqlDailyprodMatchOrder("x.item_dcode", "x.acc_code", "dp2")}
       LIMIT 1
     ) dp ON true`,
    [
      list.map((c) => c.key),
      list.map((c) => c.packing_number),
      list.map((c) => c.item_dcode),
      list.map((c) => c.acc_code),
    ]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.ctx_key ?? "").trim();
    if (key) map.set(key, r);
  }
  return map;
}

/** Local SA packing snapshot — match packing + item + customer. */
export async function fetchSaPackingMetaByContexts(contexts = []) {
  const list = (contexts || [])
    .map((c) => ({
      key: c.key ?? rowKey(c),
      packing_number: String(c?.packing_number ?? "").trim(),
      item_dcode: String(c?.item_dcode ?? "").trim() || "—",
      acc_code: String(c?.acc_code ?? "").trim(),
    }))
    .filter((c) => c.packing_number);
  if (!list.length) return new Map();

  const rows = await dbQuery(
    `SELECT
       TRIM(x.ctx_key::text) AS ctx_key,
       ${sqlDocDtText("sa.doc_dt")} AS doc_dt,
       sa.job_card_no,
       ${SA_ITEM_CODE} AS item_code,
       ${SA_ITEM_DESC} AS item_desc,
       ${SA_ACC_NAME} AS acc_name,
       sa.acc_code
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       AS x(ctx_key, pn, item_dcode, acc_code)
     LEFT JOIN LATERAL (
       SELECT sa2.*
       FROM ims_stock_adjustment sa2
       WHERE sa2.is_deleted = false
         AND sa2.approved = true
         AND sa2.entry_type IN ('add', 'minus')
         AND NULLIF(TRIM(sa2.packing_number::text), '') = NULLIF(TRIM(x.pn::text), '')
       ORDER BY
         (CASE WHEN sa2.item_dcode::text = NULLIF(TRIM(x.item_dcode::text), '—') THEN 0 ELSE 1 END),
         (CASE WHEN ${TRIM("sa2.acc_code")} = ${TRIM("x.acc_code")} THEN 0 ELSE 1 END),
         sa2.approved_at DESC NULLS LAST
       LIMIT 1
     ) sa ON true`,
    [
      list.map((c) => c.key),
      list.map((c) => c.packing_number),
      list.map((c) => c.item_dcode),
      list.map((c) => c.acc_code),
    ]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.ctx_key ?? "").trim();
    if (key) map.set(key, r);
  }
  return map;
}

/** By Packing tab — summary grouped from boxes in packing area. */
export async function findPackingAreaByPacking(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000 } = options;
  const values = [];
  let param = 1;
  const pnExpr = sqlBoxPackingNumber("b");
  const conditions = [...PACKING_AREA_WHERE("b")];

  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      ${pnExpr} ILIKE $${param++}
      OR ${BOX_ITEM_SQL} ILIKE $${param - 1}
      OR ${BOX_CUST_SQL} ILIKE $${param - 1}
    )`);
  }

  const where = conditions.join(" AND ");
  const sortCol = SUMMARY_SORT[sort.by] || "packing_number";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const orderSql = resolveSummaryOrder(sortCol, sortOrder);
  const { safePage, safeLimit, offset } = paginate(page, limit);
  const baseSql = packingAreaBaseSql(where);

  const [{ count = 0 } = {}] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT packing_number, item_dcode, acc_code FROM (${baseSql}) raw
       GROUP BY packing_number, item_dcode, acc_code
     ) g`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;

  const rows = await dbQuery(
    `WITH grouped AS (
       SELECT packing_number, item_dcode, acc_code,
         MAX(sa_financial_year) AS sa_financial_year,
         SUM(qty)::bigint AS stock_qty,
         COUNT(*)::int AS box_count
       FROM (${baseSql}) raw
       GROUP BY packing_number, item_dcode, acc_code
     )
     SELECT * FROM grouped g
     ORDER BY ${orderSql}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  return {
    data: await attachPackingDisplayMeta(rows),
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
}

/** By Box tab — individual boxes in packing area. */
export async function findPackingAreaBoxes(options = {}) {
  const { search, packing_number, item_dcode, acc_code, sort = {}, page = 1, limit = 1000 } = options;
  const values = [];
  let param = 1;
  const pnExpr = sqlBoxPackingNumber("b");
  const conditions = [...PACKING_AREA_WHERE("b")];

  if (packing_number) {
    values.push(String(packing_number).trim());
    conditions.push(`${pnExpr} = $${param++}`);
  }
  if (item_dcode) {
    values.push(String(item_dcode).trim());
    conditions.push(`${BOX_ITEM_SQL} = $${param++}`);
  }
  if (acc_code) {
    values.push(String(acc_code).trim());
    conditions.push(`${BOX_CUST_SQL} = $${param++}`);
  }
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      b.box_no_uid ILIKE $${param} OR ${pnExpr} ILIKE $${param}
    )`);
    param++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const orderSql =
    sort.by === "packing_number"
      ? packingNumberSortExpr(`(${pnExpr})`, sortOrder)
      : resolveBoxOrder(BOX_SORT[sort.by] || "b.box_no_uid", sortOrder);
  const { safePage, safeLimit, offset } = paginate(page, limit);

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count
     FROM ims_box_table b
     LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
     ${where}`,
    values
  );

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;

  let rows = await dbQuery(
    `SELECT
       b.box_uid, b.box_no_uid,
       ${pnExpr} AS packing_number,
       ${BOX_ITEM_SQL} AS item_dcode,
       ${BOX_CUST_SQL} AS acc_code,
       COALESCE(b.qty, 0)::int AS qty,
       COALESCE(b.is_loose, false) AS is_loose,
       b.created_at,
       sa.financial_year AS sa_financial_year
     FROM ims_box_table b
     LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
     ${where}
     ORDER BY ${orderSql}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  rows = await attachPackingDisplayMeta(rows);

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count) / safeLimit) || 0,
  };
}
