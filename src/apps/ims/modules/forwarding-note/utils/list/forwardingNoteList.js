/**
 * Forwarding Note — list/detail enrich for API responses.
 *
 * Live invfnote merge unchanged.
 * When both live + DB bill exist, winner = BILL_SOURCE_PREFER ("db" | "live").
 * Summary billno = unique item bills joined "1, 2, 3".
 */

import { enrichRowsWithIMS } from "../../../../lib/utils/erp-api/lookup/imsLookup.js";
import { buildCompositeKey, mergeRowsWithExternalData } from "../../../../lib/utils/erp-api/lookup/externalDataMerge.js";
import { resolvePackingStickerMetaForPrint } from "../../../box/utils/stickers/stickerPrintMeta.js";
import dbQuery from "../../../../../../config/db/db.js";

/**
 * Default bill dropdown match mode (used when caller does not pass a mode).
 *   "acc" | "acc_item" | "acc_item_packing" | "acc_item_packing_qty"
 *
 * Runtime: super_admin → acc_item · other users → acc_item_packing
 * (see resolveBillDropdownMatchForUser).
 */
export const BILL_DROPDOWN_MATCH = "acc_item";

export const BILL_SOURCE_PREFER = "db";     // When live invfnote + DB saved bill both exist, which one to show. Change this only: "db" | "live"

/** Super admin uses broader match; normal users match packing too. */
export function resolveBillDropdownMatchForUser(user = {}) {
  const type = String(user?.type ?? user?.role ?? "").trim().toLowerCase();
  if (type === "super_admin") return "acc_item";
  return "acc_item_packing";
}

/** Build a match key from a forwarding-note row / request item. */
export function buildBillDropdownMatchKey(row = {}, matchMode = BILL_DROPDOWN_MATCH) {
  const acc = row?.acc_code;
  const item = row?.item_dcode ?? row?.itemdcode;
  const packing = row?.packing_number ?? row?.packing;
  const qty = row?.total_qty ?? row?.qty;

  if (matchMode === "acc") {
    return buildCompositeKey([acc]);
  }
  if (matchMode === "acc_item") {
    return buildCompositeKey([acc, item]);
  }
  if (matchMode === "acc_item_packing") {
    return buildCompositeKey([acc, item, packing]);
  }
  if (matchMode === "acc_item_packing_qty") {
    return buildCompositeKey([acc, item, packing, qty]);
  }
  return null;
}

export function invfnoteBillDropdownMatchKey(rec = {}, matchMode = BILL_DROPDOWN_MATCH) {
  // uid example: 2003-17831-37010-9600 · muid example: 2003-17831-37010
  const raw = String(rec?.uid ?? "").trim() || String(rec?.muid ?? "").trim();
  if (!raw) return "";

  const parts = raw.split("-").filter(Boolean);

  if (matchMode === "acc") {
    if (parts.length < 1) return "";
    return parts[0];
  }
  if (matchMode === "acc_item") {
    if (parts.length < 2) return "";
    return parts[0] + "-" + parts[1];
  }
  if (matchMode === "acc_item_packing") {
    if (parts.length < 3) return "";
    return parts[0] + "-" + parts[1] + "-" + parts[2];
  }
  if (matchMode === "acc_item_packing_qty") {
    if (parts.length < 4) return "";
    return parts[0] + "-" + parts[1] + "-" + parts[2] + "-" + parts[3];
  }
  return "";
}

/** IMS invfnote status — only green bills are selectable on FN item-wise. */
export function isGreenInvfnoteRecord(rec = {}) {
  return String(rec?.status ?? "").trim().toLowerCase() === "green";
}

export function normalizeInvfnoteBillNo(rec = {}) {
  return String(rec?.prnbillno ?? rec?.PrnBillNo ?? rec?.bill_no ?? rec?.billno ?? rec?.DocNo ?? "").trim();
}

/** Bill dropdown rows: all matching bills; green flag marks what can be saved. */
export function buildInvfnoteBillOptions(records = [], { keySet, matchMode, search = "" } = {}) {
  const keys = keySet instanceof Set ? keySet : new Set(keySet || []);
  if (!keys.size) return [];

  const needle = String(search ?? "").trim().toLowerCase();
  const byKey = new Map();

  for (const rec of records || []) {
    const matchKey = invfnoteBillDropdownMatchKey(rec, matchMode);
    if (!matchKey || !keys.has(matchKey)) continue;

    const billNo = normalizeInvfnoteBillNo(rec);
    if (!billNo) continue;

    const dedupeKey = `${billNo}::${matchKey}`;
    if (needle && !billNo.toLowerCase().includes(needle) && !matchKey.toLowerCase().includes(needle)) {
      continue;
    }

    const status = String(rec?.status ?? "").trim() || null;
    const green = isGreenInvfnoteRecord(rec);
    const billdt = String(rec?.billdt ?? "").trim() || null;

    const prev = byKey.get(dedupeKey);
    if (!prev) {
      byKey.set(dedupeKey, {
        id: dedupeKey,
        bill_no: billNo,
        billno: billNo,
        billdt,
        uid: String(rec?.uid ?? "").trim() || null,
        muid: String(rec?.muid ?? "").trim() || null,
        match_key: matchKey,
        status,
        is_green: green,
      });
      continue;
    }

    if (green) prev.is_green = true;
    if (!prev.status && status) prev.status = status;
    if (!prev.billdt && billdt) prev.billdt = billdt;
    if (!prev.uid && rec?.uid) prev.uid = String(rec.uid).trim();
  }

  const rows = [...byKey.values()].map((row) => ({
    ...row,
    selectable: row.is_green === true,
  }));

  rows.sort((a, b) => {
    if (a.is_green !== b.is_green) return a.is_green ? -1 : 1;
    return String(a.bill_no).localeCompare(String(b.bill_no), undefined, { sensitivity: "base" });
  });
  return rows;
}

export function invfnoteHasGreenBillForItems(records, billno, items = [], matchMode = BILL_DROPDOWN_MATCH) {
  const billNeedle = String(billno ?? "").trim().toLowerCase();
  if (!billNeedle) return false;

  const keys = [];
  for (const item of items || []) {
    const key = buildBillDropdownMatchKey(item, matchMode);
    if (!key) return false;
    keys.push(key);
  }
  if (!keys.length) return false;

  for (const key of keys) {
    let matched = false;
    for (const rec of records || []) {
      if (!isGreenInvfnoteRecord(rec)) continue;
      if (normalizeInvfnoteBillNo(rec).toLowerCase() !== billNeedle) continue;
      if (invfnoteBillDropdownMatchKey(rec, matchMode) === key) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function buildForwardingInvfnoteRowKey(row = {}) {
  return buildCompositeKey([
    row?.acc_code,
    row?.item_dcode ?? row?.itemdcode,
    row?.packing_number ?? row?.packing,
    row?.total_qty ?? row?.qty,
  ]);
}

function shouldMergeForwardingInvfnote(row = {}) {
  // Show live IMS bills as soon as FN exists — out-entry complete/approved not required.
  void row;
  return true;
  // return row?.out_entry_complete === true && row?.out_entry_approved === true;
}

/** Pick bill by BILL_SOURCE_PREFER when both exist. Sets bill_source: db | live. */
function resolveBillFromLiveAndDb(row = {}) {
  const live = String(row?.billno ?? "").trim();
  const saved = String(row?.line_bill_no ?? row?.bill_no ?? "").trim();
  const savedDt = String(row?.line_bill_dt ?? row?.bill_dt ?? "").trim() || null;
  const preferDb = BILL_SOURCE_PREFER !== "live";

  if (preferDb) {
    if (saved) return { ...row, billno: saved, billdt: savedDt, bill_source: "db" };
    if (live) return { ...row, bill_source: "live" };
    return row;
  }

  if (live) return { ...row, bill_source: "live" };
  if (saved) return { ...row, billno: saved, billdt: savedDt, bill_source: "db" };
  return row;
}

async function mergeForwardingInvfnoteFields(rows = []) {
  const merged = await mergeRowsWithExternalData(rows, {
    requestedData: "invfnote",
    shouldMergeRow: (row) =>
      row?.out_entry_complete === undefined && row?.out_entry_approved === undefined
        ? true
        : shouldMergeForwardingInvfnote(row),
    buildRowKey: buildForwardingInvfnoteRowKey,
  });
  return merged.map(resolveBillFromLiveAndDb);
}

async function mergeForwardingSummaryInvfnoteByParent(rows = []) {
  const baseRows = rows.map((row) => ({ ...row, uid: null, billno: null, billdt: null, status: null, bill_source: null }));
  if (!baseRows.length) return baseRows;

  const eligibleFuidSet = new Set(
    baseRows.filter((row) => shouldMergeForwardingInvfnote(row)).map((row) => Number(row?.fuid)).filter((n) => Number.isFinite(n) && n > 0)
  );
  const eligibleFuids = [...eligibleFuidSet];
  if (!eligibleFuids.length) return baseRows;

  const itemRows = await dbQuery(
    `SELECT fi.fuid, fnm.acc_code, fi.item_dcode, fi.packing_number, fi.total_qty,
            fi.bill_no AS line_bill_no, fi.bill_dt AS line_bill_dt,
            fi.bill_updated_by AS line_bill_updated_by,
            fi.bill_updated_at AS line_bill_updated_at
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
    const bill = String(row?.billno ?? "").trim();
    if (!bill) continue;

    let entry = byFuid.get(fuid);
    if (!entry) {
      entry = { bills: [], billdts: [], maker: null, at: null, atMs: 0, uid: null, status: null, bill_source: null };
      byFuid.set(fuid, entry);
    }
    if (!entry.bills.includes(bill)) entry.bills.push(bill);

    const dt = String(row?.billdt ?? "").trim();
    if (dt && !entry.billdts.includes(dt)) entry.billdts.push(dt);

    const maker = String(row?.line_bill_updated_by ?? row?.bill_updated_by ?? "").trim() || null;
    const atRaw = row?.line_bill_updated_at ?? row?.bill_updated_at ?? null;
    const atMs = atRaw ? new Date(atRaw).getTime() : 0;
    if (Number.isFinite(atMs) && atMs >= entry.atMs) {
      entry.atMs = atMs;
      entry.at = atRaw;
      if (maker) entry.maker = maker;
    } else if (!entry.maker && maker) {
      entry.maker = maker;
    }

    if (!entry.uid && row?.uid) entry.uid = row.uid;
    if (!entry.status && row?.status) entry.status = row.status;
    // Summary color follows same prefer flag when lines mix live + db
    if (BILL_SOURCE_PREFER === "live") {
      if (row?.bill_source === "live") entry.bill_source = "live";
      else if (entry.bill_source !== "live" && row?.bill_source === "db") entry.bill_source = "db";
    } else if (row?.bill_source === "db") {
      entry.bill_source = "db";
    } else if (entry.bill_source !== "db" && row?.bill_source === "live") {
      entry.bill_source = "live";
    }
  }

  return baseRows.map((row) => {
    const fuid = Number(row?.fuid);
    const entry = Number.isFinite(fuid) ? byFuid.get(fuid) : null;
    if (!entry?.bills?.length) return row;
    return {
      ...row,
      uid: entry.uid,
      billno: entry.bills.join(", "),
      billdt: entry.billdts.join(", ") || null,
      bill_made_by: entry.maker,
      bill_updated_by: entry.maker,
      bill_updated_at: entry.at,
      status: entry.status,
      bill_source: entry.bill_source,
    };
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
  const withBills = await mergeForwardingInvfnoteFields(enriched);
  return withBills;
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
    bill_no: summary?.billno ?? data.bill_no ?? null,
    billdt: summary?.billdt ?? data.billdt ?? null,
    bill_made_by: summary?.bill_made_by ?? summary?.bill_updated_by ?? null,
    bill_updated_by: summary?.bill_updated_by ?? summary?.bill_made_by ?? null,
    bill_updated_at: summary?.bill_updated_at ?? null,
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
