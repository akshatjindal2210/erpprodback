/**
 * ERP vs DB stock comparison report — merges in-hand DB stock with IMS erpfg.
 */

import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { sqlErpStockDbRows } from "./erpStockDbSql.js";
import { fetchAllErpFgStock, buildErpFgStockByItemMap, invalidateErpFgStockCache } from "../erp-api/erpFgStock.js";
import { canonicalCode, getImsMapsSafe } from "../erp-api/imsLookup.js";

const REPORT_CACHE_MS = Math.max(60_000, Number(process.env.ERP_STOCK_REPORT_CACHE_MS) || 120_000);
const DB_STOCK_CACHE_MS = Math.max(30_000, Number(process.env.ERP_STOCK_DB_CACHE_MS) || 60_000);

let reportCache = null;
let reportCacheAt = 0;
let dbStockCache = null;
let dbStockCacheAt = 0;

/** @param {{ all?: boolean }} opts — `all` also clears IMS erpfg cache (slow path). */
export function invalidateErpStockReportCache({ all = false } = {}) {
  reportCache = null;
  reportCacheAt = 0;
  dbStockCache = null;
  dbStockCacheAt = 0;
  if (all) invalidateErpFgStockCache();
}

function toQty(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function rowKey(packing, itemDcode) {
  return `${String(packing ?? "").trim()}::${String(itemDcode ?? "").trim()}`;
}

async function loadDbStockRows({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && dbStockCache && now - dbStockCacheAt < DB_STOCK_CACHE_MS) {
    return dbStockCache;
  }
  const rows = await dbQuery(sqlErpStockDbRows());
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

function mergeDbAndErpRows(dbRows, erpByItem) {
  const merged = new Map();

  for (const db of dbRows) {
    const packing = String(db.packing_number ?? "").trim();
    const itemDcode = String(db.item_dcode ?? "").trim();
    const key = rowKey(packing, itemDcode);
    const erpSummary = erpByItem.get(itemDcode);
    const erpStock = toQty(erpSummary?.byPacking?.[packing] ?? 0);
    const dbStock = toQty(db.db_stock);

    merged.set(key, {
      packing_number: packing,
      item_dcode: itemDcode,
      item_code: db.item_code ?? itemDcode,
      item_desc: db.item_desc ?? null,
      doc_dt: erpSummary?.docDtByPacking?.[packing] ?? db.doc_dt ?? null,
      erp_stock: erpStock,
      db_stock: dbStock,
      stock_diff: dbStock - erpStock,
      mismatch: mismatchKind(dbStock, erpStock),
    });
  }

  for (const [itemDcode, summary] of erpByItem.entries()) {
    const byPacking = summary.byPacking || {};
    const docDtByPacking = summary.docDtByPacking || {};
    for (const packing of Object.keys(byPacking)) {
      const key = rowKey(packing, itemDcode);
      if (merged.has(key)) continue;
      const erpStock = toQty(byPacking[packing]);
      merged.set(key, {
        packing_number: packing,
        item_dcode: itemDcode,
        item_code: itemDcode,
        item_desc: null,
        doc_dt: docDtByPacking[packing] ?? null,
        erp_stock: erpStock,
        db_stock: 0,
        stock_diff: 0 - erpStock,
        mismatch: mismatchKind(0, erpStock),
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

  const rows = await buildMergedRows({ refresh, refreshErp });
  reportCache = { rows };
  reportCacheAt = Date.now();

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
    reportCache = { rows };
  }

  return paginateRows(rows, page, limit);
}
