import { findProductionFgForRmWire } from "../../production/models/productionMaster.model.js";

/** Fill FG item from Item RM Master when job-card join has no FG (typical rack / stored coils). */
export async function enrichCoilFgFromProductionMaster(row) {
  if (!row) return {};
  if (String(row.fg_item_code || "").trim()) return {};

  const fg = await findProductionFgForRmWire({
    item_code: row.item_code,
    item_dcode: row.item_dcode,
  });
  if (!fg?.fg_item_code) return {};

  return {
    fg_item_code: fg.fg_item_code,
    fg_item_desc: fg.fg_item_desc ?? null,
  };
}
