/**
 * TEMPORARY — legacy ims_stock_adjustment rows (add + minus).
 * Fills doc_dt + job_card_no from IMS packing on server start when rows are missing.
 *
 * Runs automatically on startup if pending rows exist (fast COUNT skip when done).
 * Disable: BACKFILL_SA_PACKING_META=0
 * Tune: BACKFILL_SA_PACKING_META_LIMIT, BACKFILL_SA_PACKING_META_ROUNDS
 *
 * Remove this file + hook in stock_adjustment.table.js when no legacy gaps remain.
 * New rows: stockAdjustmentDocDt.js on approve.
 */

import dbQuery, { withTransaction } from "../../../../config/db.js";
import { updateAdjustmentsTx, findFinancialYearForPacking } from "../../models/stockAdjustment.model.js";
import { fetchSaPackingMetaFromIms } from "./stockAdjustmentImsPacking.js";
import { resolveStockAdjustmentPackingMeta } from "./stockAdjustmentPacking.js";
import { mergeAdjustmentPackingMeta, packingMetaToSaDbFields } from "./stockAdjustmentPackingSnapshot.js";

const META_CACHE = new Map();
const META_CACHE_TTL_MS = 10 * 60_000;

function cacheKey(pn, fy, itemDcode, accCode) {
  return [String(pn).trim(), String(fy).trim(), itemDcode ?? "", accCode ?? ""].join("|");
}

async function fetchImsPackingMeta(packingNumber, financialYear, { itemDcode, accCode } = {}) {
  const pn = String(packingNumber ?? "").trim();
  const fy = String(financialYear ?? "").trim();
  if (!pn || !fy) return null;

  const key = cacheKey(pn, fy, itemDcode, accCode);
  const hit = META_CACHE.get(key);
  if (hit && Date.now() - hit.at < META_CACHE_TTL_MS) return hit.data;

  const data = await fetchSaPackingMetaFromIms(pn, fy, { itemDcode, accCode });
  if (data) META_CACHE.set(key, { at: Date.now(), data });
  return data;
}

async function loadRowsNeedingBackfill(limit) {
  const cap = Math.min(5000, Math.max(1, Number(limit) || 500));
  return dbQuery(
    `SELECT
       adjustment_id,
       entry_type,
       item_dcode,
       acc_code,
       TRIM(packing_number::text) AS packing_number,
       NULLIF(TRIM(financial_year::text), '') AS financial_year,
       doc_dt,
       job_card_no,
       item_code,
       item_desc,
       acc_name
     FROM ims_stock_adjustment
     WHERE is_deleted = false
       AND approved = true
       AND entry_type IN ('add', 'minus')
       AND NULLIF(TRIM(packing_number::text), '') IS NOT NULL
       AND (
         doc_dt IS NULL
         OR NULLIF(TRIM(job_card_no::text), '') IS NULL
         OR NULLIF(TRIM(item_code::text), '') IS NULL
         OR NULLIF(TRIM(item_desc::text), '') IS NULL
         OR NULLIF(TRIM(acc_name::text), '') IS NULL
       )
     ORDER BY approved_at DESC NULLS LAST
     LIMIT $1`,
    [cap]
  );
}

function buildUpdateFields(row, meta) {
  const fields = packingMetaToSaDbFields(meta, { existing: row });
  if (!Object.keys(fields).length) return null;
  return { ...fields, updated_at: new Date() };
}

/** Backfill approved add/minus rows from IMS packing. */
export async function backfillStockAdjustmentPackingMetaFromIms({ limit = 500 } = {}) {
  const rows = await loadRowsNeedingBackfill(limit);
  if (!rows.length) return { updated: 0, skipped: 0, checked: 0 };

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    let fy = row.financial_year;
    if (!fy) {
      fy = await findFinancialYearForPacking(row.packing_number);
    }
    if (!fy) {
      skipped++;
      continue;
    }

    const meta = await fetchImsPackingMeta(row.packing_number, fy, {
      itemDcode: row.item_dcode,
      accCode: row.acc_code,
    });
    let merged = meta;
    if (!merged?.item_code || !merged?.item_desc || !merged?.acc_name) {
      const local = await resolveStockAdjustmentPackingMeta(row.packing_number, {
        adjustment_id: row.adjustment_id,
        item_dcode: row.item_dcode,
        financial_year: fy,
      });
      merged = mergeAdjustmentPackingMeta(meta, local);
    }
    if (!merged) {
      skipped++;
      continue;
    }

    const fields = buildUpdateFields(row, merged);
    if (!fields) {
      skipped++;
      continue;
    }

    await withTransaction(async (client) => {
      await updateAdjustmentsTx(client, fields, { adjustment_id: row.adjustment_id });
    });
    updated++;
  }

  return { updated, skipped, checked: rows.length };
}

async function countRowsNeedingBackfill() {
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS c
     FROM ims_stock_adjustment
     WHERE is_deleted = false
       AND approved = true
       AND entry_type IN ('add', 'minus')
       AND NULLIF(TRIM(packing_number::text), '') IS NOT NULL
       AND (
         doc_dt IS NULL
         OR NULLIF(TRIM(job_card_no::text), '') IS NULL
         OR NULLIF(TRIM(item_code::text), '') IS NULL
         OR NULLIF(TRIM(item_desc::text), '') IS NULL
         OR NULLIF(TRIM(acc_name::text), '') IS NULL
       )`
  );
  return Number(row?.c) || 0;
}

/** Auto on server start — only when legacy rows still missing doc_dt / job_card_no. */
export async function runStockAdjustmentPackingMetaBackfillOnStartup() {
  if (process.env.BACKFILL_SA_PACKING_META === "0") return;

  const pending = await countRowsNeedingBackfill();
  if (pending === 0) return;

  const batchSize = Number(process.env.BACKFILL_SA_PACKING_META_LIMIT) || 200;
  const maxRounds = Number(process.env.BACKFILL_SA_PACKING_META_ROUNDS) || 50;
  let totalUpdated = 0;
  let totalSkipped = 0;

  console.log(`SA packing meta backfill: ${pending} row(s) pending — starting…`);

  for (let round = 1; round <= maxRounds; round++) {
    const { updated, skipped, checked } = await backfillStockAdjustmentPackingMetaFromIms({
      limit: batchSize,
    });
    totalUpdated += updated;
    totalSkipped += skipped;
    if (checked === 0 || updated === 0) break;
    if (round < maxRounds) {
      console.log(`SA packing meta backfill round ${round}: +${updated} (${skipped} skipped)`);
    }
  }

  const remaining = await countRowsNeedingBackfill();
  if (totalUpdated > 0) {
    console.log(
      `✅ SA packing meta backfill: ${totalUpdated} updated, ${remaining} still pending (${totalSkipped} skipped)`
    );
  } else {
    console.log(`SA packing meta backfill: no rows updated (${totalSkipped} skipped, ${remaining} pending)`);
  }
}
