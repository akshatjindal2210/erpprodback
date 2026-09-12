/**
 * QC Hold list — enrich DB rows for API responses.
 *
 * Step 1: Item map (cached) + balance fields from hold_data JSON
 * Step 2: IMS party / item display fields (light enrichRowsWithIMS)
 */

import { enrichRowsWithIMS, getImsMapsSafe } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";
import { findBoxByUidOrNoUid } from "../../../box/models/box.model.js";
import { attachQcHoldBalances, parseBoxUidList } from "../stock/qcHoldBalances.js";
import { flattenHoldRow } from "./qcHoldData.js";
import dbQuery from "../../../../../../config/db/db.js";

async function fetchJobCardsByPacking(rows = []) {
  const packings = [...new Set((rows || []).map((r) => String(r?.packing_number || "").trim()).filter(Boolean))];
  if (!packings.length) return new Map();

  const data = await dbQuery(
    `SELECT
       TRIM(x.pn::text) AS packing_number,
       MIN(NULLIF(TRIM(dp.job_card_no::text), '')) AS job_card_no
     FROM unnest($1::text[]) AS x(pn)
     LEFT JOIN ims_dailyprod dp
       ON NULLIF(TRIM(dp.doc_no::text), '') = NULLIF(TRIM(x.pn::text), '')
     GROUP BY TRIM(x.pn::text)`,
    [packings]
  );

  const map = new Map();
  for (const row of data || []) {
    const pn = String(row?.packing_number || "").trim();
    if (!pn) continue;
    const jc = row?.job_card_no != null ? String(row.job_card_no).trim() : "";
    map.set(pn, jc ? [jc] : []);
  }

  const missing = packings.filter((pn) => !(map.get(pn) || []).length);
  if (missing.length) {
    const saRows = await dbQuery(
      `SELECT
         TRIM(x.pn::text) AS packing_number,
         NULLIF(TRIM(sa.job_card_no::text), '') AS job_card_no
       FROM unnest($1::text[]) AS x(pn)
       LEFT JOIN LATERAL (
         SELECT sa2.job_card_no
         FROM ims_stock_adjustment sa2
         WHERE sa2.is_deleted = false
           AND NULLIF(TRIM(sa2.packing_number::text), '') = NULLIF(TRIM(x.pn::text), '')
           AND NULLIF(TRIM(sa2.job_card_no::text), '') IS NOT NULL
         ORDER BY sa2.approved_at DESC NULLS LAST, sa2.updated_at DESC NULLS LAST, sa2.created_at DESC NULLS LAST
         LIMIT 1
       ) sa ON true`,
      [missing]
    );
    for (const row of saRows || []) {
      const pn = String(row?.packing_number || "").trim();
      const jc = row?.job_card_no != null ? String(row.job_card_no).trim() : "";
      if (pn && jc) map.set(pn, [jc]);
    }
  }
  return map;
}

export async function enrichQcHoldListRows(rows = []) {
  const { itemMap } = await getImsMapsSafe();
  const jobCardsByPacking = await fetchJobCardsByPacking(rows);

  const base = rows.map((row) => {
    const itemDcode = row.item_dcode != null ? String(row.item_dcode) : "";
    const item = itemDcode ? itemMap.get(itemDcode) : null;
    const withBalances = attachQcHoldBalances(row);
    const packingNo = String(row?.packing_number || "").trim();
    const jcList = jobCardsByPacking.get(packingNo) || [];
    const jcPrimary = jcList[0] || null;
    return {
      ...withBalances,
      item_code: item?.item_code ?? row.item_code ?? null,
      item_desc: item?.item_desc ?? row.item_desc ?? null,
      job_card_no: jcPrimary,
      job_card_nos: jcList,
      job_card_text: jcPrimary || null,
    };
  });

  return enrichRowsWithIMS(base);
}

/** Resolve scanned box UIDs on a single hold row (detail view). */
export async function enrichHoldScannedBoxes(row) {
  const uids = parseBoxUidList(flattenHoldRow(row).scanned_box_uids);
  if (!uids.length) return [];

  const boxes = [];
  for (const uid of uids) {
    const box = await findBoxByUidOrNoUid(uid);
    boxes.push({
      box_no_uid: box?.box_no_uid ?? uid,
      box_uid: box?.box_uid ?? null,
      packing_number: box?.packing_number ?? row.packing_number ?? null,
      qty: Number(box?.qty) || 0,
      location_no: box?.location_no ?? null,
    });
  }
  return boxes;
}
