/**
 * ERP vs DB stock comparison report — merges in-hand DB stock with IMS erpfg.
 * DB rows come pre-aggregated from SQL (packing + doc_dt + job_card + item).
 */

import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { fetchAllErpFgStock, buildErpFgStockByItemMap, invalidateErpFgStockCache } from "../../../../lib/utils/erp-api/stock/erpFgStock.js";
import { canonicalCode, getImsMapsSafe } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";

/** In-hand stock grouped by packing + date + job + item. Customer names joined (display only). */
const ERP_STOCK_DB_SQL = `
WITH in_hand AS (
  SELECT NULLIF(TRIM(b.packing_number::text), '') AS packing_number,
         COALESCE(b.qty, 0)::bigint AS qty,
         NULLIF(TRIM(b.override_cust::text), '') AS override_cust,
         sa.item_dcode AS sa_item_dcode,
         NULLIF(TRIM(sa.item_code::text), '') AS sa_item_code,
         NULLIF(TRIM(sa.item_desc::text), '') AS sa_item_desc,
         to_char(sa.doc_dt::date, 'YYYY-MM-DD') AS sa_doc_dt,
         NULLIF(TRIM(sa.job_card_no::text), '') AS sa_job_card,
         NULLIF(TRIM(sa.acc_name::text), '') AS sa_acc_name
  FROM ims_box_table b
  LEFT JOIN ims_stock_adjustment sa
    ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false AND sa.approved = true
  WHERE b.is_deleted = false AND b.out_uid IS NULL
    AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')
    AND COALESCE(b.qty, 0) > 0
    AND NULLIF(TRIM(b.packing_number::text), '') IS NOT NULL
),
pack_keys AS (
  SELECT DISTINCT packing_number, override_cust,
         CASE WHEN packing_number ~ '^[0-9]+$' THEN packing_number::integer END AS pn_int
  FROM in_hand
),
dp_hits AS (
  SELECT p.packing_number, p.override_cust, dp.doc_dt, dp.doc_no, dp.job_card_no,
         dp.item_dcode, dp.item_code, dp.item_desc, dp.acc_code, dp.acc_name
  FROM pack_keys p
  JOIN ims_dailyprod dp ON dp.doc_no = p.pn_int
  WHERE p.pn_int IS NOT NULL
  UNION ALL
  SELECT p.packing_number, p.override_cust, dp.doc_dt, dp.doc_no, dp.job_card_no,
         dp.item_dcode, dp.item_code, dp.item_desc, dp.acc_code, dp.acc_name
  FROM pack_keys p
  JOIN ims_dailyprod dp ON TRIM(dp.doc_no::text) = p.packing_number
  WHERE p.pn_int IS NULL
),
best_dp AS (
  SELECT DISTINCT ON (d.packing_number, d.override_cust)
         d.packing_number, d.override_cust,
         to_char(d.doc_dt::date, 'YYYY-MM-DD') AS doc_dt,
         NULLIF(TRIM(d.job_card_no::text), '') AS job_card_no,
         d.item_dcode::text AS item_dcode,
         NULLIF(TRIM(d.item_code::text), '') AS item_code,
         NULLIF(TRIM(d.item_desc::text), '') AS item_desc,
         NULLIF(TRIM(d.acc_name::text), '') AS acc_name
  FROM dp_hits d
  ORDER BY d.packing_number, d.override_cust,
           (d.override_cust IS NOT NULL AND TRIM(d.acc_code::text) = d.override_cust) DESC,
           (d.doc_dt IS NOT NULL) DESC, d.doc_dt DESC NULLS LAST, d.doc_no DESC
),
box_rows AS (
  SELECT ih.packing_number, ih.qty,
         COALESCE(ih.sa_item_dcode::text, dp.item_dcode, '—') AS item_dcode,
         COALESCE(ih.sa_item_code, dp.item_code) AS item_code,
         COALESCE(ih.sa_item_desc, dp.item_desc) AS item_desc,
         COALESCE(ih.sa_doc_dt, dp.doc_dt) AS doc_dt,
         COALESCE(ih.sa_job_card, dp.job_card_no) AS job_card_no,
         COALESCE(ih.sa_acc_name, dp.acc_name, ih.override_cust) AS customer_name
  FROM in_hand ih
  LEFT JOIN best_dp dp
    ON dp.packing_number = ih.packing_number
   AND dp.override_cust IS NOT DISTINCT FROM ih.override_cust
)
SELECT packing_number,
       TRIM(item_dcode) AS item_dcode,
       TRIM(COALESCE(MAX(NULLIF(TRIM(item_code), '')), TRIM(item_dcode))) AS item_code,
       NULLIF(TRIM(MAX(item_desc)), '') AS item_desc,
       doc_dt,
       job_card_no,
       NULLIF(STRING_AGG(DISTINCT NULLIF(TRIM(customer_name), ''), ', '), '') AS customer_name,
       SUM(qty)::bigint AS db_stock
FROM box_rows
WHERE TRIM(COALESCE(item_dcode, '')) NOT IN ('', '—')
GROUP BY packing_number, TRIM(item_dcode), doc_dt, job_card_no`;

const REPORT_CACHE_MS = Math.max(60_000, Number(process.env.ERP_STOCK_REPORT_CACHE_MS) || 120_000);
const DB_STOCK_CACHE_MS = Math.max(30_000, Number(process.env.ERP_STOCK_DB_CACHE_MS) || 60_000);

let reportCache = null;
let reportCacheAt = 0;
let dbStockCache = null;
let dbStockCacheAt = 0;
let inflightReport = null;
let inflightReportKey = "";
let reportGen = 0;

/** @param {{ all?: boolean }} opts — `all` also clears IMS erpfg cache (slow path). */
export function invalidateErpStockReportCache({ all = false } = {}) {
  reportGen += 1;
  reportCache = null;
  reportCacheAt = 0;
  dbStockCache = null;
  dbStockCacheAt = 0;
  inflightReport = null;
  inflightReportKey = "";
  if (all) invalidateErpFgStockCache();
}

function toQty(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function norm(v) {
  const s = String(v ?? "").trim();
  return s && s !== "—" ? s : "";
}

/** Identity: packing + doc_dt + job_card + item (no customer — stock is not split by customer). */
function rowKey({ packing, itemDcode, docDt, jobCard }) {
  return [packing, docDt, jobCard, itemDcode].map(norm).join("::");
}

/** Comma-join distinct customer labels on the same report row. */
function joinCustomerNames(a, b) {
  const names = new Set();
  for (const raw of [a, b]) {
    if (!raw) continue;
    for (const part of String(raw).split(",")) {
      const t = part.trim();
      if (t) names.add(t);
    }
  }
  return names.size ? [...names].sort().join(", ") : null;
}

/** Resolve numeric acc codes to ledger names (SQL already returns names when available). */
function resolveCustomerNames(raw, ledgerMap) {
  if (!raw || !ledgerMap?.get) return raw ?? null;
  const names = new Set();
  for (const part of String(raw).split(",")) {
    const t = part.trim();
    if (!t) continue;
    const code = canonicalCode(t);
    names.add(/^\d+$/.test(t) && code && ledgerMap.get(code) ? ledgerMap.get(code) : t);
  }
  return names.size ? [...names].sort().join(", ") : null;
}

function erpMatchScore(row, erpDocDt, erpJob) {
  let score = 0;
  if (erpDocDt && norm(row.doc_dt) === erpDocDt) score += 2;
  if (erpJob && norm(row.job_card_no) === erpJob) score += 1;
  return score;
}

async function loadDbStockRows({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && dbStockCache && now - dbStockCacheAt < DB_STOCK_CACHE_MS) {
    return dbStockCache;
  }
  const rows = await dbQuery(ERP_STOCK_DB_SQL);
  dbStockCache = rows || [];
  dbStockCacheAt = now;
  return dbStockCache;
}

function mismatchKind(dbStock, erpStock) {
  const db = toQty(dbStock);
  const erp = toQty(erpStock);
  if (db === erp) return null;
  if (db > erp) return "red";
  if (erp > db) return "yellow";
  return null;
}

function looksLikeDcodeOnly(value, dcode) {
  const v = String(value ?? "").trim();
  const d = String(dcode ?? "").trim();
  if (!v) return true;
  if (d && v === d) return true;
  return /^\d+$/.test(v);
}

function collectDcodelistNeedingLookup(rows = []) {
  const set = new Set();
  for (const row of rows) {
    if (!looksLikeDcodeOnly(row?.item_code, row?.item_dcode)) continue;
    const d = canonicalCode(row?.item_dcode);
    if (d) set.add(d);
  }
  return [...set];
}

async function loadItemMasterLookup(dcodelist = [], preloadedItemMap = null) {
  const needed = [...new Set(dcodelist.map((d) => canonicalCode(d)).filter(Boolean))];
  const map = new Map();
  if (!needed.length) return map;

  const itemMap = preloadedItemMap ?? (await getImsMapsSafe()).itemMap;
  for (const dcode of needed) {
    const meta = itemMap.get(dcode);
    if (meta?.item_code) map.set(dcode, meta);
  }

  const missingIds = needed
    .filter((d) => !map.has(d) || looksLikeDcodeOnly(map.get(d)?.item_code, d))
    .map((d) => Number(d))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (missingIds.length) {
    const rows = await dbQuery(
      `SELECT DISTINCT ON (item_dcode)
          item_dcode,
          NULLIF(TRIM(item_code::text), '') AS item_code,
          NULLIF(TRIM(item_desc::text), '') AS item_desc
       FROM ${T.DAILYPROD}
       WHERE item_dcode = ANY($1::int[])
         AND NULLIF(TRIM(item_code::text), '') IS NOT NULL
       ORDER BY item_dcode, doc_dt DESC NULLS LAST, doc_no DESC`,
      [missingIds]
    );
    for (const row of rows || []) {
      const key = canonicalCode(row.item_dcode);
      if (!key) continue;
      const existing = map.get(key);
      if (existing?.item_code && !looksLikeDcodeOnly(existing.item_code, key)) continue;
      map.set(key, {
        item_code: row.item_code,
        item_desc: row.item_desc ?? existing?.item_desc ?? null,
      });
    }
  }

  return map;
}

function resolveItemFields(itemDcode, rawCode, rawDesc, lookup) {
  const dcode = canonicalCode(itemDcode) || String(itemDcode ?? "").trim();
  const master = lookup.get(dcode);
  let item_code = String(rawCode ?? "").trim();
  if (looksLikeDcodeOnly(item_code, dcode)) {
    item_code = master?.item_code || item_code || dcode;
  }
  const item_desc = rawDesc ?? master?.item_desc ?? null;
  return { item_code, item_desc };
}

function enrichRowsWithItemMaster(rows, lookup) {
  if (!lookup?.size) return rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!looksLikeDcodeOnly(row.item_code, row.item_dcode) && row.item_desc) continue;
    const { item_code, item_desc } = resolveItemFields(
      row.item_dcode,
      row.item_code,
      row.item_desc,
      lookup
    );
    if (item_code !== row.item_code || item_desc !== row.item_desc) {
      rows[i] = { ...row, item_code, item_desc };
    }
  }
  return rows;
}

function paginateRows(rows, page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  return {
    data: rows.slice(offset, offset + safeLimit),
    total: rows.length,
    page: safePage,
    limit: safeLimit,
  };
}

function packingItemKey(packing, itemDcode) {
  return `${packing}::${itemDcode}`;
}

function mergeDbAndErpRows(dbRows, erpByItem) {
  const merged = new Map();
  const byPackingItem = new Map();

  const indexRow = (key, row) => {
    const idx = packingItemKey(row.packing_number, row.item_dcode);
    const list = byPackingItem.get(idx);
    if (list) list.push([key, row]);
    else byPackingItem.set(idx, [[key, row]]);
  };

  for (const db of dbRows) {
    const packing = norm(db.packing_number);
    const itemDcode = norm(db.item_dcode);
    const docDt = norm(db.doc_dt) || null;
    const jobCard = norm(db.job_card_no) || null;
    const key = rowKey({ packing, itemDcode, docDt, jobCard });
    const dbStock = toQty(db.db_stock);
    const existing = merged.get(key);
    if (existing) {
      existing.db_stock += dbStock;
      existing.customer_name = joinCustomerNames(existing.customer_name, db.customer_name);
      existing.stock_diff = existing.db_stock - toQty(existing.erp_stock);
      existing.mismatch = mismatchKind(existing.db_stock, existing.erp_stock);
      if (!existing.item_desc && db.item_desc) existing.item_desc = db.item_desc;
      continue;
    }
    const row = {
      packing_number: packing,
      item_dcode: itemDcode,
      item_code: db.item_code ?? itemDcode,
      item_desc: db.item_desc ?? null,
      doc_dt: docDt,
      job_card_no: jobCard,
      customer_name: db.customer_name ?? null,
      erp_stock: 0,
      db_stock: dbStock,
      stock_diff: dbStock,
      mismatch: mismatchKind(dbStock, 0),
    };
    merged.set(key, row);
    indexRow(key, row);
  }

  // ERP FG is packing+item level — assign qty once to the best-matching DB row
  // (doc_dt / job_card), so footer totals don't double-count.
  for (const [itemDcode, summary] of erpByItem.entries()) {
    const byPacking = summary.byPacking || {};
    for (const packing of Object.keys(byPacking)) {
      const erpStock = toQty(byPacking[packing]);
      const erpDocDt = norm(summary.docDtByPacking?.[packing]) || null;
      const erpJob = norm(summary.jobCardByPacking?.[packing]) || null;
      const candidates = byPackingItem.get(packingItemKey(packing, itemDcode)) || [];

      if (!candidates.length) {
        const key = rowKey({
          packing,
          itemDcode,
          docDt: erpDocDt,
          jobCard: erpJob,
        });
        merged.set(key, {
          packing_number: packing,
          item_dcode: itemDcode,
          item_code: itemDcode,
          item_desc: null,
          doc_dt: erpDocDt,
          job_card_no: erpJob,
          erp_stock: erpStock,
          db_stock: 0,
          stock_diff: 0 - erpStock,
          mismatch: mismatchKind(0, erpStock),
        });
        continue;
      }

      let bestKey = candidates[0][0];
      let best = candidates[0][1];
      let bestScore = erpMatchScore(best, erpDocDt, erpJob);
      let bestQty = toQty(best.db_stock);
      for (let i = 1; i < candidates.length; i++) {
        const [key, row] = candidates[i];
        const score = erpMatchScore(row, erpDocDt, erpJob);
        const qty = toQty(row.db_stock);
        if (score > bestScore || (score === bestScore && qty > bestQty)) {
          bestKey = key;
          best = row;
          bestScore = score;
          bestQty = qty;
        }
      }

      merged.set(bestKey, {
        ...best,
        erp_stock: erpStock,
        stock_diff: toQty(best.db_stock) - erpStock,
        mismatch: mismatchKind(best.db_stock, erpStock),
      });
    }
  }

  return [...merged.values()];
}

async function buildMergedRows({ refresh = false, refreshErp = false } = {}) {
  const lookupPromise = getImsMapsSafe();

  const [dbRows, ims, imsMaps] = await Promise.all([
    loadDbStockRows({ refresh }),
    fetchAllErpFgStock({ refresh: refreshErp }),
    lookupPromise,
  ]);

  const erpByItem = buildErpFgStockByItemMap(ims?.records);
  let rows = mergeDbAndErpRows(dbRows, erpByItem);

  const lookupDcodelist = collectDcodelistNeedingLookup(rows);
  if (lookupDcodelist.length) {
    const itemLookup = await loadItemMasterLookup(lookupDcodelist, imsMaps?.itemMap);
    rows = enrichRowsWithItemMaster(rows, itemLookup);
  }

  const ledgerMap = imsMaps?.ledgerMap;
  if (ledgerMap?.get) {
    for (let i = 0; i < rows.length; i++) {
      const name = resolveCustomerNames(rows[i].customer_name, ledgerMap);
      if (name !== rows[i].customer_name) rows[i] = { ...rows[i], customer_name: name };
    }
  }
  return rows;
}

export async function findErpStockComparisonReport(options = {}) {
  const {
    page = 1,
    limit = 10000,
    sortBy = "packing_number",
    order = "DESC",
    refresh = false,
    refreshErp = false,
  } = options;

  const now = Date.now();
  if (!refresh && !refreshErp && reportCache?.rows && now - reportCacheAt < REPORT_CACHE_MS) {
    return paginateRows(reportCache.rows, page, limit);
  }

  if (refresh || refreshErp) {
    invalidateErpStockReportCache({ all: refreshErp });
  }

  const inflightKey = `${Boolean(refresh)}:${Boolean(refreshErp)}`;
  const gen = reportGen;
  if (!inflightReport || inflightReportKey !== inflightKey) {
    inflightReportKey = inflightKey;
    inflightReport = buildMergedRows({ refresh, refreshErp }).finally(() => {
      if (inflightReportKey === inflightKey) {
        inflightReport = null;
        inflightReportKey = "";
      }
    });
  }
  const rows = await inflightReport;
  if (gen === reportGen) {
    reportCache = { rows };
    reportCacheAt = Date.now();
  }

  const sortDir = String(order).toUpperCase() === "ASC" ? 1 : -1;
  if (options.sortOnServer) {
    const sortKey = String(sortBy || "packing_number");
    rows.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (sortKey === "doc_dt") {
        av = av ? new Date(av).getTime() : 0;
        bv = bv ? new Date(bv).getTime() : 0;
      } else if (sortKey === "erp_stock" || sortKey === "db_stock" || sortKey === "stock_diff") {
        av = toQty(av);
        bv = toQty(bv);
      } else {
        av = String(av ?? "");
        bv = String(bv ?? "");
      }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    if (gen === reportGen) reportCache = { rows };
  }

  return paginateRows(rows, page, limit);
}
