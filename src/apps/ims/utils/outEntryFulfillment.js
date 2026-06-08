import dbQuery from "../../../config/db.js";
import {
  findBoxesByNoUids,
  findInHandBoxesByScanCodes,
  findBoxesByScanCodesAny,
  matchBoxRowByScanCode,
} from "../models/box.model.js";
import { findFuidDetailsForOutEntry } from "../models/outEntry.model.js";
import { isBoxAvailableForOutEntryScan, isBoxInHand, isBoxStockAdjustmentOut } from "./boxInventory.js";

function itemKeyFromRow(row) {
  const code = String(row?.item_dcode ?? "").trim();
  return code || (row?.id != null ? `line_${row.id}` : "unknown");
}

/** Per packing: MAX per item line, then SUM across items (matches frontend). */
function aggregatePackingRequirementsFromRows(rows = []) {
  const byPacking = new Map();
  for (const row of rows || []) {
    const pKey = packingKey(row.packing_number);
    const iKey = itemKeyFromRow(row);
    if (!byPacking.has(pKey)) byPacking.set(pKey, new Map());
    const itemMap = byPacking.get(pKey);
    const cur = itemMap.get(iKey) || { box: 0, loose_box: 0 };
    cur.box = Math.max(cur.box, Number(row.box) || 0);
    cur.loose_box = Math.max(cur.loose_box, Number(row.loose_box) || 0);
    itemMap.set(iKey, cur);
  }
  const out = new Map();
  for (const [pKey, itemMap] of byPacking) {
    let box = 0;
    let loose_box = 0;
    for (const v of itemMap.values()) {
      box += v.box;
      loose_box += v.loose_box;
    }
    out.set(pKey, { box, loose_box });
  }
  return out;
}

export async function getForwardingNoteBoxRequirements(fuid) {
  const rows = await dbQuery(
    `
    SELECT fi.id,
           fi.item_dcode::text AS item_dcode,
           TRIM(fi.packing_number::text) AS packing_number,
           COALESCE(fi.box, 0)::int AS box,
           COALESCE(fi.loose_box, 0)::int AS loose_box
    FROM ims_forwarding_note_item_wise fi
    WHERE fi.fuid = $1 AND fi.is_deleted = false
    `,
    [fuid]
  );

  const totals = aggregatePackingRequirementsFromRows(rows);
  const packingNumbers = new Map();
  for (const row of rows || []) {
    const key = packingKey(row.packing_number);
    if (!packingNumbers.has(key)) {
      packingNumbers.set(key, row.packing_number);
    }
  }
  return [...packingNumbers.entries()].map(([key, packing_number]) => {
    const t = totals.get(key) || { box: 0, loose_box: 0 };
    return { packing_number, box: t.box, loose_box: t.loose_box };
  });
}

/** Each item × packing line from forwarding note (for progress UI). */
export async function getForwardingNoteItemLines(fuid) {
  const rows = await dbQuery(
    `
    SELECT fi.id,
           fi.item_dcode::text AS item_dcode,
           TRIM(fi.packing_number::text) AS packing_number,
           COALESCE(fi.box, 0)::int AS box,
           COALESCE(fi.loose_box, 0)::int AS loose_box,
           COALESCE(fi.total_qty, 0)::int AS total_qty
    FROM ims_forwarding_note_item_wise fi
    WHERE fi.fuid = $1 AND fi.is_deleted = false
    ORDER BY fi.item_dcode ASC, fi.id ASC
    `,
    [fuid]
  );
  return rows || [];
}

function packingKey(packing_number) {
  return String(packing_number ?? "").trim() || "N/A";
}

function countScannedByPacking(scannedRows = []) {
  const byPacking = new Map();
  for (const box of scannedRows) {
    const key = packingKey(box.packing_number);
    const cur = byPacking.get(key) || { standard: 0, loose: 0 };
    if (box.is_loose) cur.loose += 1;
    else cur.standard += 1;
    byPacking.set(key, cur);
  }
  return byPacking;
}

function buildFulfillmentMessage(issues = []) {
  if (!issues.length) {
    return "Scan all required standard and loose boxes before approving this out entry.";
  }
  const first = issues[0];
  const pn = first.packing_number ?? "N/A";
  const parts = [];
  if (first.required_standard !== first.scanned_standard) {
    parts.push(`standard boxes ${first.scanned_standard}/${first.required_standard}`);
  }
  if (first.required_loose !== first.scanned_loose) {
    parts.push(`loose boxes ${first.scanned_loose}/${first.required_loose}`);
  }
  const detail = parts.length ? parts.join(", ") : "incomplete scans";
  const more = issues.length > 1 ? ` (+${issues.length - 1} more packing${issues.length > 2 ? "s" : ""})` : "";
  return `Forwarding note incomplete for packing #${pn} (${detail})${more}. Complete every item's packings.`;
}

function buildItemLineProgress(itemLines = [], packingProgress = []) {
  const byPacking = new Map(packingProgress.map((p) => [packingKey(p.packing_number), p]));
  return (itemLines || []).map((line) => {
    const progress = byPacking.get(packingKey(line.packing_number));
    const lineRequired = (Number(line.box) || 0) + (Number(line.loose_box) || 0);
    return {
      item_dcode: line.item_dcode,
      packing_number: line.packing_number,
      box: line.box,
      loose_box: line.loose_box,
      line_required_total: lineRequired,
      packing_scanned_total: progress?.scanned_total ?? 0,
      packing_required_total: progress?.required_total ?? 0,
      packing_complete: Boolean(progress?.complete),
    };
  });
}

export function validateFulfillmentAgainstRequirements(requirements = [], scannedRows = []) {
  const scannedByPacking = countScannedByPacking(scannedRows);
  const totalRequired = (requirements || []).reduce(
    (sum, r) => sum + (Number(r.box) || 0) + (Number(r.loose_box) || 0),
    0
  );

  if (!requirements.length || totalRequired === 0) {
    return {
      ok: false,
      message: "Forwarding note has no box requirements to fulfill for exit approval.",
    };
  }

  const issues = [];
  for (const req of requirements) {
    const key = packingKey(req.packing_number);
    const scanned = scannedByPacking.get(key) || { standard: 0, loose: 0 };
    const reqStd = Number(req.box) || 0;
    const reqLoose = Number(req.loose_box) || 0;
    if (scanned.standard !== reqStd || scanned.loose !== reqLoose) {
      issues.push({
        packing_number: req.packing_number,
        required_standard: reqStd,
        scanned_standard: scanned.standard,
        required_loose: reqLoose,
        scanned_loose: scanned.loose,
      });
    }
  }

  if (issues.length) {
    return { ok: false, message: buildFulfillmentMessage(issues), issues };
  }
  return { ok: true };
}

export function outEntryOtherScanRejectMessage(box) {
  if (!box || box.is_deleted) return "Box not found or was removed.";
  if (isBoxStockAdjustmentOut(box)) {
    return "This box was removed via stock adjustment and cannot be used.";
  }
  if (!isBoxInHand(box)) return "Box is not in stock — it may already be outward.";
  const hasLocation = box.location_id != null && String(box.location_id).trim() !== "";
  const hasInward = box.in_uid != null && String(box.in_uid).trim() !== "";
  if (!hasLocation && !hasInward) return "Box is already in packing area.";
  return null;
}

export function isBoxEligibleForOutEntryOther(box) {
  return outEntryOtherScanRejectMessage(box) == null;
}

export function outEntryInventoryOutScanRejectMessage(box) {
  if (!box || box.is_deleted) return "Box not found or was removed.";
  if (isBoxStockAdjustmentOut(box)) {
    return "This box was removed via stock adjustment and cannot be used.";
  }
  if (!isBoxInHand(box)) return "Box is not in stock.";
  return null;
}

export function isBoxEligibleForOutEntryInventoryOut(box) {
  return outEntryInventoryOutScanRejectMessage(box) == null;
}

export async function getOutEntryOtherScanSummary({ scanned_boxes = [] }) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  const count = uids.length;
  return {
    scan_complete: count > 0,
    boxes_required: 0,
    boxes_scanned: count,
    packing_count: 0,
    item_count: 0,
    item_line_count: 0,
    packing_progress: [],
    item_progress: [],
    fulfillment: count
      ? { ok: true }
      : { ok: false, message: "Scan at least one box from store before submitting." },
  };
}

export async function findScannedBoxUidsForOutEntry(out_uid) {
  if (!out_uid) return [];
  const [entry] = await dbQuery(
    `SELECT approved, entry_type FROM ims_out_entry WHERE out_uid = $1 AND is_deleted = false LIMIT 1`,
    [out_uid]
  );
  if (entry?.entry_type === "other" || entry?.entry_type === "packing_area") {
    const draft = await dbQuery(
      `SELECT box_no_uid::text AS box_no_uid
       FROM ims_out_entry_scanned_box
       WHERE out_uid = $1
       ORDER BY box_no_uid ASC`,
      [out_uid]
    );
    return (draft || []).map((r) => String(r.box_no_uid).trim()).filter(Boolean);
  }
  if (entry?.approved) {
    const rows = await dbQuery(
      `SELECT box_no_uid::text AS box_no_uid
       FROM ims_box_table
       WHERE out_uid = $1 AND is_deleted = false`,
      [out_uid]
    );
    return (rows || []).map((r) => String(r.box_no_uid).trim()).filter(Boolean);
  }
  const draft = await dbQuery(
    `SELECT box_no_uid::text AS box_no_uid
     FROM ims_out_entry_scanned_box
     WHERE out_uid = $1
     ORDER BY box_no_uid ASC`,
    [out_uid]
  );
  return (draft || []).map((r) => String(r.box_no_uid).trim()).filter(Boolean);
}

export async function assertOutEntryFulfillmentComplete({ fuid, scanned_boxes = [] }) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  const requirements = await getForwardingNoteBoxRequirements(fuid);
  const totalRequired = requirements.reduce(
    (sum, r) => sum + (Number(r.box) || 0) + (Number(r.loose_box) || 0),
    0
  );

  if (!requirements.length || totalRequired === 0) {
    return {
      ok: false,
      message: "Forwarding note has no box requirements to fulfill for exit approval.",
    };
  }

  if (!uids.length) {
    return {
      ok: false,
      message: "Scan all required boxes before approving this out entry.",
    };
  }

  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return { ok: false, message: "Some scanned boxes were not found or are deleted." };
  }

  const reqPackings = new Set(requirements.map((r) => packingKey(r.packing_number)));
  const wrongPacking = rows.find((b) => !reqPackings.has(packingKey(b.packing_number)));
  if (wrongPacking) {
    return {
      ok: false,
      message: `Box ${wrongPacking.box_no_uid} is not part of this forwarding note.`,
    };
  }

  return validateFulfillmentAgainstRequirements(requirements, rows);
}

/** Persisted on ims_out_entry — same rules as approve validation. */
export async function getOutEntryScanSummary({ fuid, scanned_boxes = [] }) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  const [requirements, itemLines] = await Promise.all([
    getForwardingNoteBoxRequirements(fuid),
    getForwardingNoteItemLines(fuid),
  ]);
  const totalRequired = requirements.reduce(
    (sum, r) => sum + (Number(r.box) || 0) + (Number(r.loose_box) || 0),
    0
  );
  const itemCount = new Set((itemLines || []).map((l) => String(l.item_dcode ?? "").trim()).filter(Boolean)).size;

  const buildPackingProgress = (scannedByPacking) =>
    (requirements || []).map((req) => {
      const key = packingKey(req.packing_number);
      const counts = scannedByPacking.get(key) || { standard: 0, loose: 0 };
      const reqStd = Number(req.box) || 0;
      const reqLoose = Number(req.loose_box) || 0;
      const required_total = reqStd + reqLoose;
      const scanned_total = counts.standard + counts.loose;
      return {
        packing_number: req.packing_number,
        required_standard: reqStd,
        required_loose: reqLoose,
        scanned_standard: counts.standard,
        scanned_loose: counts.loose,
        required_total,
        scanned_total,
        complete: required_total > 0 && counts.standard === reqStd && counts.loose === reqLoose,
      };
    });

  if (!uids.length) {
    const packing_progress = buildPackingProgress(new Map());
    return {
      scan_complete: false,
      boxes_required: totalRequired,
      boxes_scanned: 0,
      packing_count: requirements.length,
      item_count: itemCount,
      item_line_count: itemLines.length,
      packing_progress,
      item_progress: buildItemLineProgress(itemLines, packing_progress),
      fulfillment: {
        ok: false,
        message: "Scan all required boxes for every item and packing before completing this out entry.",
      },
    };
  }

  const fulfillment = await assertOutEntryFulfillmentComplete({ fuid, scanned_boxes: uids });
  const rows = await findBoxesByNoUids(uids);
  const scannedByPacking = countScannedByPacking(rows || []);
  const packing_progress = buildPackingProgress(scannedByPacking);

  return {
    scan_complete: Boolean(fulfillment.ok),
    boxes_required: totalRequired,
    boxes_scanned: rows?.length ?? 0,
    packing_count: requirements.length,
    item_count: itemCount,
    item_line_count: itemLines.length,
    packing_progress,
    item_progress: buildItemLineProgress(itemLines, packing_progress),
    fulfillment,
  };
}

function buildOutEntryScanIndexFromItems(items = []) {
  const index = new Map();
  for (const item of items || []) {
    const packing_number = item.packing_number;
    for (const loc of item.locations || []) {
      for (const box of loc.boxes || []) {
        const uid = box?.box_no_uid;
        if (!uid) continue;
        const entry = { box, canonicalBoxId: String(uid).trim(), packing_number: box.packing_number ?? packing_number };
        index.set(String(uid).trim().toLowerCase(), entry);
        if (box.box_uid != null && String(box.box_uid).trim() !== "") {
          index.set(String(box.box_uid).trim().toLowerCase(), entry);
        }
      }
    }
  }
  return index;
}

/**
 * Batch resolve + validate out-entry scans (one round-trip for many boxes).
 * @returns {Promise<{ results: Array<{ id, found, box_no_uid, allowed, message, duplicate? }> }>}
 */
export async function resolveOutEntryBatchScan({fuid, forOutUid = null, items = [], session_scanned = []}) {
  const fuidNum = Number(fuid);
  if (!Number.isFinite(fuidNum) || fuidNum <= 0) {
    throw Object.assign(new Error("fuid is required"), { statusCode: 400 });
  }

  const scopedOut = forOutUid != null && String(forOutUid).trim() !== "" && Number.isFinite(Number(forOutUid)) ? Number(forOutUid) : null;

  const [fuidItems, requirements] = await Promise.all([
    findFuidDetailsForOutEntry(fuidNum, scopedOut),
    getForwardingNoteBoxRequirements(fuidNum),
  ]);

  const scanIndex = buildOutEntryScanIndexFromItems(fuidItems);
  const reqByPacking = new Map(requirements.map((r) => [packingKey(r.packing_number), r]));
  const confirmed = new Set((session_scanned || []).map((u) => String(u).trim()).filter(Boolean));
  const runningByPacking = new Map();

  if (confirmed.size) {
    const sessionRows = await findBoxesByNoUids([...confirmed]);
    for (const [key, counts] of countScannedByPacking(sessionRows)) {
      runningByPacking.set(key, { ...counts });
    }
  }

  const normalizedItems = (items || []).map((item, index) => ({
    id: item?.id != null ? String(item.id) : String(index),
    code: item?.code != null ? String(item.code).trim() : "",
  }));

  const hits = normalizedItems.map((item) => ({
    ...item,
    hit: item.code ? scanIndex.get(item.code.toLowerCase()) : null,
  }));

  const canonicalIds = [
    ...new Set(hits.filter((row) => row.hit?.canonicalBoxId).map((row) => row.hit.canonicalBoxId)),
  ];
  const dbRows = canonicalIds.length ? await findBoxesByNoUids(canonicalIds) : [];
  const dbMap = new Map(dbRows.map((row) => [String(row.box_no_uid).trim(), row]));

  const results = [];

  for (const { id, code, hit } of hits) {
    if (!code) {
      results.push({
        id,
        found: false,
        box_no_uid: null,
        allowed: false,
        message: "Invalid box scan",
      });
      continue;
    }

    if (!hit) {
      results.push({
        id,
        found: false,
        box_no_uid: null,
        allowed: false,
        message: `Box "${code}" is not in this forwarding note.`,
      });
      continue;
    }

    const canonical = hit.canonicalBoxId;
    if (confirmed.has(canonical)) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        duplicate: true,
        message: `Already scanned: ${canonical}`,
      });
      continue;
    }

    const dbRow = dbMap.get(canonical);
    if (!dbRow) {
      results.push({
        id,
        found: false,
        box_no_uid: canonical,
        allowed: false,
        message: "Box not found or deleted.",
      });
      continue;
    }

    if (!isBoxAvailableForOutEntryScan(dbRow, { forOutUid: scopedOut })) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: "Box is not available for outward.",
      });
      continue;
    }

    const pk = packingKey(hit.packing_number);
    const req = reqByPacking.get(pk) || { box: 0, loose_box: 0 };
    const running = runningByPacking.get(pk) || { standard: 0, loose: 0 };
    const isLoose = dbRow.is_loose === true || dbRow.is_loose === 1 || dbRow.is_loose === "true";
    const limit = isLoose ? Number(req.loose_box) || 0 : Number(req.box) || 0;
    const already = isLoose ? running.loose : running.standard;

    if (already >= limit) {
      const typeLabel = isLoose ? "loose boxes" : "standard boxes";
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: `Limit reached for packing #${hit.packing_number}: only ${limit} ${typeLabel} required.`,
      });
      continue;
    }

    if (isLoose) running.loose += 1;
    else running.standard += 1;
    runningByPacking.set(pk, running);
    confirmed.add(canonical);

    results.push({
      id,
      found: true,
      box_no_uid: canonical,
      allowed: true,
      message: null,
      packing_number: hit.packing_number,
    });
  }

  return { results };
}

/**
 * Batch resolve out-entry "other" scans — any in-store box (location or inward link).
 */
export async function resolveOutEntryOtherBatchScan({
  forOutUid = null,
  items = [],
  session_scanned = [],
}) {
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" && Number.isFinite(Number(forOutUid))
      ? Number(forOutUid)
      : null;

  const normalizedItems = (items || []).map((item, index) => ({
    id: item?.id != null ? String(item.id) : String(index),
    code: item?.code != null ? String(item.code).trim() : "",
  }));

  const codes = normalizedItems.map((item) => item.code).filter(Boolean);
  const [inHandRows, anyRows] = await Promise.all([
    findInHandBoxesByScanCodes(codes),
    findBoxesByScanCodesAny(codes),
  ]);

  const confirmed = new Set((session_scanned || []).map((u) => String(u).trim()).filter(Boolean));
  const results = [];

  for (const { id, code } of normalizedItems) {
    if (!code) {
      results.push({
        id,
        found: false,
        box_no_uid: null,
        allowed: false,
        message: "Invalid box scan",
      });
      continue;
    }

    const inHand = matchBoxRowByScanCode(inHandRows, code);
    const anyRow = matchBoxRowByScanCode(anyRows, code);
    const canonical = inHand?.box_no_uid != null ? String(inHand.box_no_uid).trim() : null;

    if (!canonical) {
      const reject =
        outEntryOtherScanRejectMessage(anyRow) ||
        (anyRow ? "Box is not available for this out entry." : "Box not found.");
      results.push({
        id,
        found: Boolean(anyRow),
        box_no_uid: anyRow?.box_no_uid != null ? String(anyRow.box_no_uid).trim() : null,
        allowed: false,
        message: reject,
      });
      continue;
    }

    if (confirmed.has(canonical)) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        duplicate: true,
        message: `Already scanned: ${canonical}`,
      });
      continue;
    }

    const dbRows = await findBoxesByNoUids([canonical]);
    const dbRow = dbRows?.[0];
    const eligibility = outEntryOtherScanRejectMessage(dbRow);
    if (eligibility) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: eligibility,
      });
      continue;
    }

    if (!isBoxAvailableForOutEntryScan(dbRow, { forOutUid: scopedOut })) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: "Box is not available for outward.",
      });
      continue;
    }

    confirmed.add(canonical);
    results.push({
      id,
      found: true,
      box_no_uid: canonical,
      allowed: true,
      message: null,
      packing_number: dbRow?.packing_number ?? inHand?.packing_number ?? null,
      qty: Number(dbRow?.qty ?? inHand?.qty) || 0,
      is_loose: dbRow?.is_loose === true || dbRow?.is_loose === 1,
    });
  }

  return { results };
}

/** Batch resolve inventory-out scans — in-hand boxes linked via out_uid on approve. */
export async function resolveOutEntryInventoryOutBatchScan({
  forOutUid = null,
  items = [],
  session_scanned = [],
}) {
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" && Number.isFinite(Number(forOutUid))
      ? Number(forOutUid)
      : null;

  const normalizedItems = (items || []).map((item, index) => ({
    id: item?.id != null ? String(item.id) : String(index),
    code: item?.code != null ? String(item.code).trim() : "",
  }));

  const codes = normalizedItems.map((item) => item.code).filter(Boolean);
  const [inHandRows, anyRows] = await Promise.all([
    findInHandBoxesByScanCodes(codes),
    findBoxesByScanCodesAny(codes),
  ]);

  const confirmed = new Set((session_scanned || []).map((u) => String(u).trim()).filter(Boolean));
  const results = [];

  for (const { id, code } of normalizedItems) {
    if (!code) {
      results.push({
        id,
        found: false,
        box_no_uid: null,
        allowed: false,
        message: "Invalid box scan",
      });
      continue;
    }

    const inHand = matchBoxRowByScanCode(inHandRows, code);
    const anyRow = matchBoxRowByScanCode(anyRows, code);
    const canonical = inHand?.box_no_uid != null ? String(inHand.box_no_uid).trim() : null;

    if (!canonical) {
      const reject =
        outEntryInventoryOutScanRejectMessage(anyRow) ||
        (anyRow ? "Box is not available for inventory out." : "Box not found.");
      results.push({
        id,
        found: Boolean(anyRow),
        box_no_uid: anyRow?.box_no_uid != null ? String(anyRow.box_no_uid).trim() : null,
        allowed: false,
        message: reject,
      });
      continue;
    }

    if (confirmed.has(canonical)) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        duplicate: true,
        message: `Already scanned: ${canonical}`,
      });
      continue;
    }

    const dbRows = await findBoxesByNoUids([canonical]);
    const dbRow = dbRows?.[0];
    const eligibility = outEntryInventoryOutScanRejectMessage(dbRow);
    if (eligibility) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: eligibility,
      });
      continue;
    }

    if (!isBoxAvailableForOutEntryScan(dbRow, { forOutUid: scopedOut })) {
      results.push({
        id,
        found: true,
        box_no_uid: canonical,
        allowed: false,
        message: "Box is not available for inventory out.",
      });
      continue;
    }

    confirmed.add(canonical);
    results.push({
      id,
      found: true,
      box_no_uid: canonical,
      allowed: true,
      message: null,
      packing_number: dbRow?.packing_number ?? inHand?.packing_number ?? null,
      qty: Number(dbRow?.qty ?? inHand?.qty) || 0,
      is_loose: dbRow?.is_loose === true || dbRow?.is_loose === 1,
    });
  }

  return { results };
}
