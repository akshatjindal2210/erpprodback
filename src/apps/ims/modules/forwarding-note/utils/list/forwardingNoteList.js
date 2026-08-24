/**
 * Forwarding Note — list/detail enrich for API responses.
 *
 * Summary list: IMS customer name on acc_code
 * Item list:    IMS customer + item code/desc
 * Detail:       enrich master + grouped item breakdowns
 * Bill print:   fill missing packing doc_dt (dailyprod + IMS)
 */

import { enrichRowsWithIMS } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";
import { buildCompositeKey, mergeRowsWithExternalData } from "../../../../lib/utils/erp-api/lookup/externalDataMerge.js";
import { resolvePackingStickerMetaForPrint } from "../../../box/utils/stickers/stickerPrintMeta.js";
import dbQuery from "../../../../../../config/db/db.js";

function buildForwardingInvfnoteRowKey(row = {}) {
  return buildCompositeKey([
    row?.acc_code,
    row?.item_dcode ?? row?.itemdcode,
    row?.packing_number ?? row?.packing,
    row?.total_qty ?? row?.qty,
  ]);
}

function shouldMergeForwardingInvfnote(row = {}) {
  return row?.out_entry_complete === true && row?.out_entry_approved === true;
}

async function mergeForwardingInvfnoteFields(rows = []) {
  return mergeRowsWithExternalData(rows, {
    requestedData: "invfnote",
    shouldMergeRow: (row) =>
      row?.out_entry_complete === undefined && row?.out_entry_approved === undefined
        ? true
        : shouldMergeForwardingInvfnote(row),
    buildRowKey: buildForwardingInvfnoteRowKey,
  });
}

async function mergeForwardingSummaryInvfnoteByParent(rows = []) {
  const baseRows = rows.map((row) => ({...row, uid: null, billno: null, billdt: null, status: null}));
  if (!baseRows.length) return baseRows;

  const eligibleFuidSet = new Set(baseRows.filter((row) => shouldMergeForwardingInvfnote(row)).map((row) => Number(row?.fuid)).filter((n) => Number.isFinite(n) && n > 0));
  const eligibleFuids = [...eligibleFuidSet];
  if (!eligibleFuids.length) return baseRows;

  const itemRows = await dbQuery(
    `SELECT DISTINCT fi.fuid, fnm.acc_code, fi.item_dcode, fi.packing_number, fi.total_qty
     FROM ims_forwarding_note_item_wise fi
     INNER JOIN ims_forwarding_note_master fnm ON fnm.fuid = fi.fuid AND fnm.is_deleted = false
     WHERE fi.is_deleted = false AND fi.fuid = ANY($1::int[])`,
    [eligibleFuids]
  );
  if (!Array.isArray(itemRows) || !itemRows.length) return baseRows;

  const mergedItems = await mergeForwardingInvfnoteFields(itemRows);
  const byFuid = new Map();
  
  for (const row of mergedItems) {
    const fuid = Number(row?.fuid);
    if (!Number.isFinite(fuid) || fuid <= 0) continue;
    const hasExternal = String(row?.billno ?? "").trim() || String(row?.billdt ?? "").trim() || String(row?.status ?? "").trim();
    if (!hasExternal || byFuid.has(fuid)) continue;
    byFuid.set(fuid, {
      uid: row?.uid ?? null,
      billno: row?.billno ?? null,
      billdt: row?.billdt ?? null,
      status: row?.status ?? null,
    });
  }

  return baseRows.map((row) => {
    const fuid = Number(row?.fuid);
    const patch = Number.isFinite(fuid) ? byFuid.get(fuid) : null;
    return patch ? { ...row, ...patch } : row;
  });
}

export async function enrichForwardingSummaryRows(rows = []) {
  const enriched = await enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
  });
  return mergeForwardingSummaryInvfnoteByParent(enriched);
}

export async function enrichForwardingItemRows(rows = []) {
  const enriched = await enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
    itemCodeField: "item_dcode",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
  });
  return mergeForwardingInvfnoteFields(enriched);
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
