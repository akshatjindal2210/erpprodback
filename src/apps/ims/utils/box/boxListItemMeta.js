/**
 * Resolve item code / description for box list rows when dailyprod join is empty (legacy stickers).
 */
import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { fetchFromIMS } from "../../services/ims.service.js";
import { buildImsDocFilterMany, findImsPackByDocNo, imsPackToDisplayMeta } from "../erp-api/imsPackRow.js";
import { canonicalCode } from "../erp-api/imsLookup.js";

function trimPn(v) {
  if (v == null) return "";
  return String(v).trim();
}

function rowMissingItem(row) {
  const code = row?.item_code ?? row?.item_name;
  const desc = row?.itemdesc ?? row?.item_desc;
  const hasCode = code != null && String(code).trim() !== "";
  const hasDesc = desc != null && String(desc).trim() !== "";
  return !hasCode && !hasDesc;
}

/** Batch local dailyprod + IMS pack for packing numbers missing item display fields. */
export async function loadPackingItemMetaMap(packingNumbers = [], itemMap = null) {
  const nums = [...new Set(packingNumbers.map(trimPn).filter(Boolean))];
  const map = new Map();
  if (!nums.length) return map;

  const localRows = await dbQuery(
    `SELECT trim(dp.doc_no::text) AS packing_number,
            dp.item_dcode,
            dp.item_code,
            dp.item_desc
     FROM ${T.DAILYPROD} dp
     WHERE trim(dp.doc_no::text) = ANY($1::text[])`,
    [nums]
  );

  for (const r of localRows || []) {
    const pn = trimPn(r.packing_number);
    if (!pn) continue;
    map.set(pn, {
      item_dcode: r.item_dcode ?? null,
      item_code: r.item_code ?? null,
      item_desc: r.item_desc ?? null,
    });
  }

  const needIms = nums.filter((pn) => {
    const m = map.get(pn);
    return !m?.item_code && !m?.item_dcode;
  });

  if (!needIms.length) return map;

  try {
    const filter = buildImsDocFilterMany(needIms);
    if (!filter) return map;
    const records = await fetchFromIMS("pack", filter);
    for (const pn of needIms) {
      const packRow = findImsPackByDocNo(records, pn);
      const meta = imsPackToDisplayMeta(packRow);
      if (!meta) continue;
      const itemDcode = meta.item_dcode ?? meta.itemdcode ?? null;
      const itemFromMap = itemMap && itemDcode ? itemMap.get(canonicalCode(itemDcode)) : null;
      map.set(pn, {
        item_dcode: itemDcode,
        item_code: meta.item_code ?? itemFromMap?.item_code ?? null,
        item_desc: meta.item_desc ?? itemFromMap?.item_desc ?? null,
      });
    }
  } catch (err) {
    console.error("[loadPackingItemMetaMap] IMS fetch failed:", err.message);
  }

  return map;
}

/** Fill item_code / description on box rows still empty after dailyprod + itemMap enrichment. */
export async function fillMissingBoxItemFields(rows = [], itemMap = null) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  const needPn = [
    ...new Set(
      rows
        .filter(rowMissingItem)
        .map((r) => trimPn(r.packing_number))
        .filter(Boolean)
    ),
  ];
  if (!needPn.length) return rows;

  const metaMap = await loadPackingItemMetaMap(needPn, itemMap);

  return rows.map((row) => {
    if (!rowMissingItem(row)) return row;
    const meta = metaMap.get(trimPn(row.packing_number));
    if (!meta) return row;

    const itemDcode = meta.item_dcode ?? row.prod_item_dcode ?? row.sa_item_dcode ?? null;
    const fromMap = itemMap && itemDcode ? itemMap.get(canonicalCode(itemDcode)) : null;

    return {
      ...row,
      item_dcode: itemDcode ?? row.item_dcode ?? null,
      itemdcode: itemDcode ?? row.itemdcode ?? null,
      item_code: meta.item_code ?? fromMap?.item_code ?? row.item_code ?? null,
      itemdesc: meta.item_desc ?? fromMap?.item_desc ?? row.itemdesc ?? null,
      item_desc: meta.item_desc ?? fromMap?.item_desc ?? row.item_desc ?? null,
      item_name: meta.item_code ?? fromMap?.item_code ?? row.item_name ?? null,
    };
  });
}
