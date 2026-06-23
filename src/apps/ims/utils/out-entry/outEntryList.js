/**
 * Store Out list — enrich rows for API responses.
 *
 * List: map aggregated item_dcode → item_code (cached item map)
 * Detail: IMS customer / item names on forwarding note + line items
 */

import { enrichRowsWithIMS, getImsMapsSafe } from "../erp-api/imsLookup.js";

export async function enrichOutEntryListRows(rows = []) {
  if (!rows?.length) return rows || [];
  const { itemMap } = await getImsMapsSafe();
  return rows.map((row) => {
    if (!row.item_codes) return row;
    const codes = row.item_codes.split(" | ").map((c) => {
      const trimmed = c.trim();
      const mapped = itemMap.get(trimmed);
      return mapped?.item_code || trimmed;
    });
    return { ...row, item_codes: codes.join(" | ") };
  });
}

export async function enrichOutEntryItems(rows = []) {
  const enriched = await enrichRowsWithIMS(rows, {
    itemCodeField: "item_dcode",
    itemCodeOut: "item_code",
    itemDescOut: "itemdesc",
  });
  return (enriched || []).map((row) => ({
    ...row,
    item_desc: row.item_desc ?? row.itemdesc ?? null,
  }));
}

export async function enrichOutEntryNote(note) {
  if (!note) return note;
  const [enriched] = await enrichRowsWithIMS([note], {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
  });
  return enriched || note;
}
