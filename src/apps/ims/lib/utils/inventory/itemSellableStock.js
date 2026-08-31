/**
 * Sellable in-hand qty for an item (itemdcode) — sum of box qty in inventory.
 */
import dbQuery from "../../../../../config/db/db.js";
import { sqlBoxSellable } from "../../../modules/box/utils/inventory/boxInventorySql.js";

const BOX_ITEM_DCODE = `COALESCE(
  CASE WHEN b.sa_id IS NOT NULL THEN sa.item_dcode::text END,
  dp.item_dcode::text
)`;

const SELLABLE = sqlBoxSellable("b");

export async function getItemSellableQty(itemdcode) {
  const code = String(itemdcode ?? "").trim();
  if (!code) return 0;

  const [row] = await dbQuery(
    `SELECT COALESCE(SUM(b.qty), 0)::bigint AS available_qty
     FROM ims_box_table b
     LEFT JOIN ims_stock_adjustment sa
       ON sa.adjustment_id = b.sa_id
      AND sa.is_deleted = false
      AND sa.approved = true
     LEFT JOIN ims_dailyprod dp
       ON b.sa_id IS NULL
      AND trim(b.packing_number::text) = trim(dp.doc_no::text)
     WHERE b.is_deleted = false
       AND (${SELLABLE})
       AND TRIM(COALESCE(${BOX_ITEM_DCODE}, '')) = $1`,
    [code]
  );

  return Number(row?.available_qty) || 0;
}

/** Resolve requested sticker qty from body (total_qty or packing_config breakdown). */
export function resolveStickerRequestedQty({ total_qty, packing_config } = {}) {
  const direct = Number(total_qty);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const pc = packing_config || {};
  const full = Number(pc.full_boxes_count) || 0;
  const perBox = Number(pc.qty_per_box) || 0;
  const loose = Number(pc.loose_box_qty) || 0;
  const fromConfig = full * perBox + loose;
  return Number.isFinite(fromConfig) && fromConfig > 0 ? fromConfig : 0;
}
