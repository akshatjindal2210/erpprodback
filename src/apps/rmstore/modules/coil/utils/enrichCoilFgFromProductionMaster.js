import { isIssuedToShopFloor } from "../../../lib/utils/saMinusInventory.js";
import { findProductionFgForRmWire } from "../../production/models/productionMaster.model.js";

function productionFgContext(row) {
  if (!row) return false;
  if (row.reassign === true) return true;
  if (isIssuedToShopFloor(row)) return true;
  return String(row.status || "").toLowerCase() === "consumed";
}

/** Coil Finder: FG only after issue / consume / reassign — else clear. */
export async function enrichFinderCoilFg(row) {
  if (!productionFgContext(row)) return { fg_item_code: null, fg_item_desc: null };
  return enrichCoilFgFromProductionMaster(row);
}

async function enrichCoilFgFromProductionMaster(row) {
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
