/**
 * Idempotent backfill for ims_dailyprod rows missing sticker column data.
 * Derives values from linked boxes + packing standard when columns are empty.
 */
import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { canonicalCode, getImsMapsSafe } from "../erp-api/imsLookup.js";
import { buildPartyRateAccNameMap, resolvePackingCustomerName } from "./packingEntryCustomers.js";
import { invalidateDailyProdGeneratedCache } from "./dailyProdList.js";

function isMissingAccName(name) {
  if (name == null || String(name).trim() === "") return true;
  return /^Customer \d+$/i.test(String(name).trim());
}

function resolveAccName(row, ledgerMap, partyRateMap) {
  if (!isMissingAccName(row.acc_name)) return String(row.acc_name).trim();
  const itemDcode = row.item_dcode ?? row.itemdcode ?? null;
  return resolvePackingCustomerName(row.acc_code, { ledgerMap, partyRateMap, itemDcode });
}

export async function backfillDailyprodStickerColumns() {
  const rows = await dbQuery(
    `SELECT
       dp.doc_no,
       dp.doc_dt::text AS doc_dt,
       dp.job_card_no,
       dp.acc_code,
       dp.acc_name,
       dp.item_dcode,
       dp.item_code,
       dp.item_desc,
       dp.total_qty,
       dp.packing_standard_id,
       dp.qty_per_box,
       dp.full_boxes_count,
       dp.loose_box_qty,
       dp.total_stickers,
       dp.category_id,
       dp.category_name,
       dp.unit,
       ps.qty AS ps_qty,
       ps.unit AS ps_unit,
       ps.type AS ps_category_id,
       cat.name AS ps_category_name,
       bx.total_stickers AS bx_total_stickers,
       bx.full_boxes_count AS bx_full_boxes_count,
       bx.qty_per_box AS bx_qty_per_box,
       bx.loose_box_qty AS bx_loose_box_qty
     FROM ${T.DAILYPROD} dp
     LEFT JOIN ${T.PACKING_STANDARD} ps
       ON ps.standard_id = dp.packing_standard_id AND ps.is_deleted = false
     LEFT JOIN ${T.CATEGORY} cat ON cat.id = ps.type
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*)::int AS total_stickers,
         COUNT(*) FILTER (WHERE NOT COALESCE(b.is_loose, false))::int AS full_boxes_count,
         MAX(b.qty) FILTER (WHERE NOT COALESCE(b.is_loose, false)) AS qty_per_box,
         MAX(b.qty) FILTER (WHERE COALESCE(b.is_loose, false)) AS loose_box_qty
       FROM ${T.BOX_TABLE} b
       WHERE b.is_deleted = false
         AND trim(b.packing_number::text) = trim(dp.doc_no::text)
         AND (b.sa_entry_type IS NULL OR b.sa_entry_type IS DISTINCT FROM 'stock_out')
     ) bx ON true
     WHERE dp.sticker_generated = true
       AND (
         trim(COALESCE(dp.acc_name, '')) = ''
         OR dp.acc_name ~ '^Customer [0-9]+$'
         OR dp.item_desc IS NULL OR trim(dp.item_desc) = ''
         OR dp.qty_per_box IS NULL
         OR dp.total_stickers IS NULL
       )`
  );

  if (!rows?.length) return { updated: 0 };

  const [{ itemMap, ledgerMap }, partyRateMap] = await Promise.all([
    getImsMapsSafe(),
    buildPartyRateAccNameMap(),
  ]);

  let updated = 0;
  for (const row of rows) {
    const acc_name = resolveAccName(row, ledgerMap, partyRateMap);
    const itemDcode = canonicalCode(row.item_dcode);
    const itemDetail = itemDcode ? itemMap.get(itemDcode) : null;
    const item_code = row.item_code ?? itemDetail?.item_code ?? null;
    const item_desc = row.item_desc ?? itemDetail?.item_desc ?? null;
    const qty_per_box = row.qty_per_box ?? row.bx_qty_per_box ?? row.ps_qty ?? null;
    const full_boxes_count = row.full_boxes_count ?? row.bx_full_boxes_count ?? null;
    const loose_box_qty = row.loose_box_qty ?? row.bx_loose_box_qty ?? null;
    const total_stickers = row.total_stickers ?? row.bx_total_stickers ?? null;
    const category_id = row.category_id ?? row.ps_category_id ?? null;
    const category_name = row.category_name ?? row.ps_category_name ?? null;
    const unit = row.unit ?? row.ps_unit ?? "PCS";

    await dbQuery(
      `UPDATE ${T.DAILYPROD}
       SET acc_name = COALESCE(NULLIF(trim($2::text), ''), acc_name),
           item_code = COALESCE($3::text, item_code),
           item_desc = COALESCE($4::text, item_desc),
           qty_per_box = COALESCE($5::numeric, qty_per_box),
           full_boxes_count = COALESCE($6::integer, full_boxes_count),
           loose_box_qty = COALESCE($7::numeric, loose_box_qty),
           total_stickers = COALESCE($8::integer, total_stickers),
           category_id = COALESCE($9::integer, category_id),
           category_name = COALESCE($10::text, category_name),
           unit = COALESCE(NULLIF(trim($11::text), ''), unit),
           doc_dt = COALESCE(
             CASE WHEN trim(COALESCE(doc_dt::text, '')) <> '' THEN doc_dt ELSE NULL END,
             CASE WHEN $12::text IS NOT NULL AND trim($12::text) <> '' THEN $12::date ELSE NULL END
           ),
           job_card_no = COALESCE(NULLIF(trim(job_card_no), ''), NULLIF(trim($13::text), '')),
           total_qty = COALESCE(total_qty, NULLIF(trim($14::text), '')::numeric)
       WHERE doc_no = $1::integer`,
      [
        row.doc_no,
        acc_name ?? "",
        item_code,
        item_desc,
        qty_per_box,
        full_boxes_count,
        loose_box_qty,
        total_stickers,
        category_id,
        category_name,
        unit,
        row.doc_dt,
        row.job_card_no,
        row.total_qty != null ? String(row.total_qty) : null,
      ]
    );
    updated += 1;
  }

  if (updated > 0) invalidateDailyProdGeneratedCache();
  return { updated };
}
