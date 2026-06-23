/**
 * Forwarding Note — list/detail enrich for API responses.
 *
 * Summary list: IMS customer name on acc_code
 * Item list:    IMS customer + item code/desc
 * Detail:       enrich master + grouped item breakdowns
 * Bill print:   fill missing packing doc_dt (dailyprod + IMS)
 */

import { enrichRowsWithIMS } from "../erp-api/imsLookup.js";
import { resolvePackingStickerMetaForPrint } from "../box/stickerPrintMeta.js";

export async function enrichForwardingSummaryRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
  });
}

export async function enrichForwardingItemRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
    itemCodeField: "item_dcode",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
  });
}

export async function enrichForwardingNoteDetail(data) {
  if (!data) return data;
  const [summary] = await enrichForwardingSummaryRows([data]);
  const accCode = data.acc_code;

  const enrichedGroups = [];
  for (const grp of data.items || []) {
    const rowsToEnrich = [
      { ...grp, acc_code: accCode },
      ...(grp.breakdowns || []).map((b) => ({ ...b, acc_code: accCode })),
    ];
    const enriched = await enrichForwardingItemRows(rowsToEnrich);
    const [enrichedGrp, ...enrichedBreakdowns] = enriched;

    enrichedGroups.push({
      ...enrichedGrp,
      itemdesc: enrichedGrp.itemdesc ?? enrichedGrp.item_desc ?? null,
      breakdowns: enrichedBreakdowns.map((row) => ({
        ...row,
        itemdesc: row.itemdesc ?? row.item_desc ?? null,
      })),
    });
  }

  return {
    ...(summary || data),
    items: enrichedGroups,
  };
}

/** Bill print only — fill missing packing doc_dt. */
export async function enrichBillPackingDates(note) {
  if (!note?.items?.length) return note;

  const pending = new Map();
  for (const grp of note.items) {
    for (const line of grp.breakdowns || []) {
      if (line.doc_dt != null && String(line.doc_dt).trim() !== "") continue;
      const pn = String(line.packing_number ?? "").trim();
      if (!pn) continue;
      if (!pending.has(pn)) pending.set(pn, []);
      pending.get(pn).push(line);
    }
  }

  await Promise.all(
    [...pending.entries()].map(async ([pn, lines]) => {
      try {
        const meta = await resolvePackingStickerMetaForPrint(pn);
        const dt = meta?.doc_dt;
        if (dt == null || String(dt).trim() === "") return;
        for (const line of lines) line.doc_dt = dt;
      } catch {
        /* ignore lookup errors */
      }
    })
  );

  return note;
}

/** Limits client-supplied print header overrides (size / abuse). */
export function sanitizePrintCompanyInfo(raw) {
  if (!raw || typeof raw !== "object") return {};
  const limits = { name: 200, address: 800, gstin: 32, phone: 160 };
  const out = {};
  for (const key of Object.keys(limits)) {
    if (typeof raw[key] !== "string") continue;
    const t = raw[key].trim();
    if (t) out[key] = t.slice(0, limits[key]);
  }
  return out;
}
