import dbQuery from "../../../../config/db.js";
import { getImsMapsSafe } from "./imsLookup.js";

const BOX_GROUP_SQL = `
  SELECT
    b.packing_number,
    COALESCE(MAX(sa.item_dcode::text), MAX(dp.item_dcode::text), '-') AS item_dcode,
    SUM(b.qty)::int AS q
  FROM ims_box_table b
  LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
  LEFT JOIN ims_dailyprod dp ON dp.doc_no::text = b.packing_number
  WHERE b.box_no_uid = ANY($1::text[]) AND b.is_deleted = false
  GROUP BY b.packing_number
  ORDER BY b.packing_number
`;

export function aggregateMetadataRows(rows = [], { includePackingNumbers = false } = {}) {
  if (!rows.length) {
    return {
      packing_numbers: includePackingNumbers ? null : undefined,
      item_codes: null,
      qtys: null,
      total_qty: 0,
    };
  }

  const result = {
    item_codes: rows.map((r) => r.item_dcode).join(" | "),
    qtys: rows.map((r) => String(r.q)).join(" | "),
    total_qty: rows.reduce((sum, r) => sum + Number(r.q || 0), 0),
  };

  if (includePackingNumbers) {
    result.packing_numbers = rows.map((r) => r.packing_number).join(" | ");
  }

  return result;
}

export async function computeEntryListMetadataFromBoxUids(boxNoUids, opts = {}) {
  const uids = [...new Set((boxNoUids || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return aggregateMetadataRows([], opts);

  const rows = await dbQuery(BOX_GROUP_SQL, [uids]);
  return aggregateMetadataRows(rows, opts);
}

export async function computeInwardListMetadata(in_uid) {
  const rows = await dbQuery(
    `SELECT box_no_uid FROM ims_box_table WHERE in_uid = $1 AND is_deleted = false`,
    [in_uid]
  );
  return computeEntryListMetadataFromBoxUids(rows.map((r) => r.box_no_uid));
}

export async function computeOutEntryListMetadata(out_uid) {
  const rows = await dbQuery(
    `SELECT DISTINCT box_no_uid FROM (
       SELECT b.box_no_uid::text AS box_no_uid
       FROM ims_box_table b
       WHERE b.out_uid = $1 AND b.is_deleted = false
       UNION
       SELECT d.box_no_uid
       FROM ims_out_entry_scanned_box d
       WHERE d.out_uid = $1
     ) u`,
    [out_uid]
  );
  return computeEntryListMetadataFromBoxUids(rows.map((r) => r.box_no_uid), { includePackingNumbers: true });
}

/** Map item_dcode snapshot values to alphanumeric item codes for storage. */
export async function resolveMetadataItemCodes(meta = {}) {
  if (!meta?.item_codes) return meta;

  const { itemMap } = await getImsMapsSafe();
  const item_codes = meta.item_codes
    .split(" | ")
    .map((c) => {
      const trimmed = c.trim();
      return itemMap.get(trimmed)?.item_code || trimmed;
    })
    .join(" | ");

  return { ...meta, item_codes };
}

export async function snapshotMetadataFromBoxUids(boxNoUids, opts = {}) {
  const raw = await computeEntryListMetadataFromBoxUids(boxNoUids, opts);
  return resolveMetadataItemCodes(raw);
}

export async function snapshotInwardMetadata(in_uid) {
  const raw = await computeInwardListMetadata(in_uid);
  return resolveMetadataItemCodes(raw);
}

export async function snapshotOutEntryMetadata(out_uid) {
  const raw = await computeOutEntryListMetadata(out_uid);
  return resolveMetadataItemCodes(raw);
}
