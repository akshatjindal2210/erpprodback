import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { fetchImsDataRaw } from "../../../lib/services/ims.service.js";
import { enrichRowsWithIMS, getImsMapsSafe } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { findGateRows, findGateByBillNo, findGateByUid, findNextGateUid, findSavedGateBillSet, insertGateEntry, softDeleteGate, updateGateEntryMeta } from "../models/gateEntry.model.js";
import { parseBillScanPayload } from "../utils/parseBillScan.js";
import { GATE_PENDING_MIN_BILL_DT, parseBillDateHint, resolveGateImsBilldtFilter } from "../utils/imsBillDateFilter.js";

function packingFromUid(rec = {}) {
  const raw = String(rec?.uid ?? "").trim() || String(rec?.muid ?? "").trim();
  const parts = raw.split("-").filter(Boolean);
  return parts.length >= 3 ? parts[2] : null;
}

/** invfnote uid: acc-itemdcode-packing-qty (e.g. 2003-17831-37010-9600) */
function qtyFromInvfnoteUid(rec = {}) {
  const raw = String(rec?.uid ?? "").trim();
  if (!raw) return null;
  const parts = raw.split("-").filter(Boolean);
  if (parts.length < 4) return null;
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : null;
}

function pickInvfnoteQty(rec = {}) {
  // Line / packing qty only — do not use bill-level totalqty on packing rows (breaks item-wise sum).
  const candidates = [
    rec?.qty,
    rec?.QTY,
    rec?.Qty,
    rec?.billqty,
    rec?.bill_qty,
    rec?.itemqty,
    rec?.item_qty,
    rec?.Quantity,
    rec?.quantity,
    rec?.qnty,
  ];
  for (const v of candidates) {
    if (v == null || v === "") continue;
    const n = Number(String(v).replace(/,/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return qtyFromInvfnoteUid(rec);
}

function invfnoteBillNo(rec = {}) {
  return String(rec?.billno ?? rec?.prnbillno ?? rec?.bill_no ?? rec?.DocNo ?? "").trim();
}

function mapInvfnote(rec = {}) {
  const uid = String(rec?.uid ?? "").trim() || null;
  const qty = pickInvfnoteQty(rec);
  return {
    ...rec,
    uid,
    muid: String(rec?.muid ?? "").trim() || null,
    billno: invfnoteBillNo(rec),
    acc_name: String(rec?.acc_name ?? "").trim() || null,
    acc_code: rec?.acc_code ?? (uid ? uid.split("-")[0] : null) ?? null,
    boxes: rec?.boxes != null ? String(rec.boxes).trim() : null,
    item_code: String(rec?.item_code ?? rec?.itemdcode ?? "").trim() || null,
    item_desc: String(rec?.item_desc ?? rec?.itemdesc ?? "").trim() || null,
    qty,
    itsrno: (() => {
      const n = Number(rec?.itsrno ?? rec?.ITSRNO ?? rec?.item_srno);
      return Number.isFinite(n) ? n : null;
    })(),
    billdt: String(rec?.billdt ?? "").trim() || null,
    packing_number: packingFromUid(rec),
  };
}

function mapInvmnote(rec = {}) {
  if (!rec || typeof rec !== "object") return null;
  const { status: _s, ...rest } = rec;
  const uid = String(rest?.uid ?? "").trim() || null;
  return {
    ...rest,
    billno: String(rest?.billno ?? rest?.bill_no ?? rest?.DocNo ?? "").trim() || null,
    bill_no: String(rest?.billno ?? rest?.bill_no ?? rest?.DocNo ?? "").trim() || null,
    billdt: String(rest?.billdt ?? rest?.bill_dt ?? "").trim() || null,
    acc_name: String(rest?.acc_name ?? "").trim() || null,
    acc_code: rest?.acc_code ?? (uid ? uid.split("-")[0] : null) ?? null,
    boxes: rest?.boxes != null ? String(rest.boxes).trim() : null,
    totalqty: rest?.totalqty ?? rest?.total_qty ?? null,
    total_item_count: rest?.total_item_count ?? null,
  };
}

/** Fetch invmnote/invfnote with safe billdt range only (no billno in SQL). */
async function fetchImsBillDataset(requestedData, bill_no, bill_dt_hint) {
  const bill = String(bill_no || "").trim();
  if (!bill) return { records: [], filterMeta: null };

  // 1) FY start → today (IMS-safe example shape)
  const toToday = resolveGateImsBilldtFilter(bill_dt_hint, { useTodayAsEnd: true });
  // 2) Full FY window
  const fullFy = resolveGateImsBilldtFilter(bill_dt_hint, { useTodayAsEnd: false });

  const attempts = [
    { filter: toToday.filter, meta: toToday },
    { filter: fullFy.filter, meta: fullFy },
    { filter: null, meta: { ...toToday, filter: null, source: "no_filter" } },
  ];

  let lastMeta = toToday;
  for (const attempt of attempts) {
    lastMeta = attempt.meta;
    const json = await fetchImsDataRaw(requestedData, attempt.filter);
    if (!json?.success) {
      // Bad filter / IMS SQL error — try next shape (do not treat as empty hit).
      console.warn(
        "[GateEntry] IMS",
        requestedData,
        "filter failed:",
        attempt.filter || "(none)",
        json?.message || "unknown"
      );
      continue;
    }
    const records = Array.isArray(json.records) ? json.records : [];
    return { records, filterMeta: attempt.meta };
  }
  return { records: [], filterMeta: lastMeta };
}

async function loadInvfnoteByBill(bill_no, bill_dt_hint = null) {
  const needle = String(bill_no || "").trim().toLowerCase();
  if (!needle) return [];
  const { records } = await fetchImsBillDataset("invfnote", bill_no, bill_dt_hint);
  let invfnote = (Array.isArray(records) ? records : [])
    .filter((rec) => invfnoteBillNo(rec).toLowerCase() === needle)
    .map(mapInvfnote);
  if (invfnote.some((r) => !r.acc_name && r.acc_code)) {
    const { ledgerMap } = await getImsMapsSafe();
    invfnote = enrichRowsWithIMS(invfnote, {
      accCodeField: "acc_code",
      accNameOut: "acc_name",
      maps: { ledgerMap },
    });
  }
  return invfnote;
}

async function loadInvmnoteByBill(bill_no, bill_dt_hint = null) {
  const needle = String(bill_no || "").trim().toLowerCase();
  if (!needle) return null;
  const { records } = await fetchImsBillDataset("invmnote", bill_no, bill_dt_hint);
  const hit = (Array.isArray(records) ? records : []).find((r) => {
    const b = String(r?.billno ?? r?.bill_no ?? r?.DocNo ?? "").trim().toLowerCase();
    return b === needle;
  });
  if (!hit) return null;
  let mapped = mapInvmnote(hit);
  if (mapped && !mapped.acc_name && mapped.acc_code) {
    const { ledgerMap } = await getImsMapsSafe();
    const enriched = enrichRowsWithIMS([mapped], {
      accCodeField: "acc_code",
      accNameOut: "acc_name",
      maps: { ledgerMap },
    });
    mapped = enriched[0] || mapped;
  }
  return mapped;
}

/** Register list — live bill header fields from IMS invmnote (not stored on gate row). */
async function enrichGateRowsFromIms(rows = []) {
  if (!rows.length) return rows;

  const billKeys = new Set(rows.map((r) => String(r?.bill_no || "").trim().toLowerCase()).filter(Boolean));
  if (!billKeys.size) return rows;

  const metaByBill = new Map();
  const pickListFields = (mapped) => ({
    acc_name: mapped?.acc_name || null,
    boxes: mapped?.boxes ?? null,
    totalqty: mapped?.totalqty ?? mapped?.total_qty ?? null,
    total_item_count: mapped?.total_item_count ?? null,
  });

  const fy = resolveGateImsBilldtFilter(null, { useTodayAsEnd: true });
  let json = await fetchImsDataRaw("invmnote", fy.filter);
  if (!json?.success) {
    json = await fetchImsDataRaw("invmnote", null);
  }
  for (const rec of Array.isArray(json?.records) ? json.records : []) {
    const billno = String(rec?.billno ?? rec?.bill_no ?? rec?.DocNo ?? "").trim().toLowerCase();
    if (!billno || !billKeys.has(billno) || metaByBill.has(billno)) continue;
    metaByBill.set(billno, pickListFields(mapInvmnote(rec)));
  }

  const missing = [...billKeys].filter((k) => !metaByBill.has(k));
  if (missing.length) {
    const byBill = new Map(rows.map((r) => [String(r?.bill_no || "").trim().toLowerCase(), r]));
    await Promise.all(
      missing.map(async (key) => {
        const row = byBill.get(key);
        const invmnote = await loadInvmnoteByBill(row?.bill_no, row?.bill_dt);
        if (invmnote) metaByBill.set(key, pickListFields(invmnote));
      })
    );
  }

  return rows.map((row) => {
    const key = String(row?.bill_no || "").trim().toLowerCase();
    return { ...row, ...(metaByBill.get(key) || pickListFields(null)) };
  });
}

/** Independent open: light DB row + live IMS invmnote / invfnote (no JSON snapshots). */
async function buildOpenPayload(bill_no, bill_dt_hint = null) {
  const bill = String(bill_no || "").trim();
  if (!bill) return null;

  const existing = await findGateByBillNo(bill);
  const invmnote = await loadInvmnoteByBill(bill, bill_dt_hint || existing?.bill_dt);
  const invfnote = await loadInvfnoteByBill(bill, bill_dt_hint || existing?.bill_dt || invmnote?.billdt);

  // Customer once on bill header — fill from item lines if header missing
  if (invmnote && !invmnote.acc_name) {
    const fromLine = invfnote.find((l) => l?.acc_name)?.acc_name;
    if (fromLine) invmnote.acc_name = fromLine;
  }

  if (existing) {
    return {
      already_saved: true,
      gate: existing,
      bill_no: existing.bill_no,
      bill_dt: existing.bill_dt || invmnote?.billdt || invfnote[0]?.billdt || null,
      transporter_name: existing.transporter_name,
      vehicle_number: existing.vehicle_number,
      remarks: existing.remarks,
      invmnote,
      invfnote,
    };
  }

  return {
    already_saved: false,
    bill_no: bill,
    bill_dt: invmnote?.billdt || invfnote[0]?.billdt || bill_dt_hint || null,
    transporter_name: String(invmnote?.transporter_name ?? invmnote?.transporter ?? invmnote?.transport ?? "").trim() || null,
    vehicle_number: String(invmnote?.vehicle_number ?? invmnote?.vehicleno ?? invmnote?.vehicle_no ?? "").trim() || null,
    remarks: "",
    next_uid: await findNextGateUid(),
    invmnote,
    invfnote,
  };
}

export async function listPendingGateEntries(_req, res) {
  try {
    const fy = resolveGateImsBilldtFilter(null, {
      useTodayAsEnd: true,
      minFrom: GATE_PENDING_MIN_BILL_DT,
    });
    let json = await fetchImsDataRaw("invmnote", fy.filter);
    let usedFilter = fy.filter;
    if (!json?.success) {
      console.warn("[GateEntry] pending invmnote filter failed, retry without filter:", json?.message);
      json = await fetchImsDataRaw("invmnote", null);
      usedFilter = null;
    }
    const records = Array.isArray(json?.records) ? json.records : [];
    const saved = await findSavedGateBillSet();
    const pendingMin = new Date(GATE_PENDING_MIN_BILL_DT);
    pendingMin.setHours(0, 0, 0, 0);
    const rows = [];
    for (const rec of records) {
      const billno = String(rec?.billno ?? rec?.bill_no ?? rec?.DocNo ?? "").trim();
      if (!billno) continue;
      if (saved.has(billno.toLowerCase())) continue;
      const billdtRaw = String(rec?.billdt ?? rec?.bill_dt ?? "").trim();
      const billDate = parseBillDateHint(billdtRaw);
      if (billDate && billDate < pendingMin) continue;
      if (!billDate && usedFilter == null) continue;
      const { status: _s, ...api } = rec;
      rows.push({
        ...api,
        billno,
        bill_no: billno,
        billdt: billdtRaw || null,
        bill_dt: billdtRaw || null,
        acc_name: String(api.acc_name ?? "").trim() || null,
        boxes: api.boxes != null ? String(api.boxes).trim() : null,
        totalqty: api.totalqty ?? api.total_qty ?? null,
        total_item_count: api.total_item_count ?? null,
      });
    }
    rows.sort((a, b) => String(b.billdt || "").localeCompare(String(a.billdt || "")));
    res.json({
      success: true,
      data: rows,
      total: rows.length,
      meta: { imsFilter: usedFilter, financialYear: fy.label, pendingFrom: "26Aug2026" },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending bills." });
  }
}

export async function listGateEntries(req, res) {
  try {
    const filters = req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : req.body || {};
    const from_date = filters.from_date || filters.fromDate || null;
    const to_date = filters.to_date || filters.toDate || null;
    const type = filters.type || filters.typeFilter || null;
    const rows = await findGateRows({from_date, to_date, type, permission: req.permission});
    const data = await enrichGateRowsFromIms(rows || []);
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load gate entries." });
  }
}

export async function openGateBill(req, res) {
  try {
    // Prefer raw QR / base64 when present — decode only on backend.
    const rawScan = String(req.body?.qrData ?? "").trim();
    let bill_no = String(req.body?.bill_no ?? "").trim();
    let bill_dt = String(req.body?.bill_dt ?? "").trim() || null;
    let parseSource = bill_no ? "plain" : null;
    let imsFilterMeta = null;

    if (rawScan) {
      try {
        const parsed = parseBillScanPayload(rawScan);
        bill_no = String(parsed?.docNumber || "").trim();
        bill_dt = parsed?.bill_dt || bill_dt;
        parseSource = parsed?.source || "qr";
        if (!bill_no) {
          return res.status(400).json({
            success: false,
            message: "Document number not found in bill QR. Scan the full QR or type the bill number.",
          });
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: e?.message || "Invalid bill QR / scan data.",
        });
      }
    }

    if (!bill_no) {
      return res.status(400).json({ success: false, message: "Bill number or QR data is required." });
    }

    imsFilterMeta = resolveGateImsBilldtFilter(bill_dt, { useTodayAsEnd: false });
    const data = await buildOpenPayload(bill_no, bill_dt);
    if (!data) {
      return res.status(404).json({ success: false, message: "Bill not found." });
    }

    const imsMissing = !data.already_saved && !data.invmnote && !(data.invfnote || []).length;
    if (imsMissing) {
      return res.status(404).json({
        success: false,
        message: `Bill "${bill_no}" not found in IMS for FY ${imsFilterMeta.label}. Scan a valid bill QR or type the correct bill number.`,
        meta: {
          parseSource,
          imsFilter: imsFilterMeta.filter,
          financialYear: imsFilterMeta.label,
        },
      });
    }

    if (bill_dt && !data.bill_dt) data.bill_dt = bill_dt;
    data.ims_missing = false;

    res.json({
      success: true,
      data,
      meta: {
        parseSource,
        imsFilter: imsFilterMeta.filter,
        financialYear: imsFilterMeta.label,
        imsMissing: false,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "Failed to open bill." });
  }
}

/** Save — independent of Forwarding Note. */
export async function saveGateEntry(req, res) {
  try {
    const user = auditUserName(req);
    const bill_no = String(req.body?.bill_no ?? "").trim();
    if (!bill_no) {
      return res.status(400).json({ success: false, message: "Bill number is required." });
    }

    const existing = await findGateByBillNo(bill_no);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This bill is already saved.",
        data: existing,
      });
    }

    const bill_dt = String(req.body?.bill_dt ?? "").trim() || null;
    const remarks = String(req.body?.remarks ?? "").trim() || null;
    const transporter_name = String(req.body?.transporter_name ?? "").trim() || null;
    const vehicle_number = String(req.body?.vehicle_number ?? "").trim() || null;

    // Resolve bill date from IMS if not provided — do not store invmnote/invfnote snapshots.
    let resolvedBillDt = bill_dt;
    if (!resolvedBillDt) {
      const invmnote = await loadInvmnoteByBill(bill_no, bill_dt);
      resolvedBillDt = invmnote?.billdt || null;
    }

    const gate = await insertGateEntry({
      bill_no,
      bill_dt: resolvedBillDt,
      remarks,
      transporter_name,
      vehicle_number,
      created_by: user,
    });

    res.json({ success: true, message: "Gate entry saved successfully.", data: gate });
  } catch (err) {
    const msg = String(err?.message || "");
    if (/unique|duplicate|idx_gate_entry_bill/i.test(msg)) {
      return res.status(409).json({ success: false, message: "This bill is already saved." });
    }
    res.status(500).json({ success: false, message: err.message || "Failed to save gate entry." });
  }
}

export async function getGateDetails(req, res) {
  try {
    const uid = req.body?.uid != null ? Number(req.body.uid) : null;
    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required." });
    }
    const gate = await findGateByUid(uid);
    if (!gate) {
      return res.status(404).json({ success: false, message: "Gate entry not found." });
    }
    const bill_no = String(gate.bill_no || "").trim();
    const invmnote = await loadInvmnoteByBill(bill_no, gate.bill_dt);
    const invfnote = await loadInvfnoteByBill(bill_no, gate.bill_dt || invmnote?.billdt);
    res.json({
      success: true,
      data: {
        already_saved: true,
        gate,
        bill_no,
        bill_dt: gate.bill_dt || invmnote?.billdt || invfnote[0]?.billdt || null,
        transporter_name: gate.transporter_name,
        vehicle_number: gate.vehicle_number,
        remarks: gate.remarks,
        invmnote,
        invfnote,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load details." });
  }
}

export async function updateGateEntry(req, res) {
  try {
    const uid = req.body?.uid != null ? Number(req.body.uid) : null;
    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required." });
    }
    const existing = await findGateByUid(uid);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Gate entry not found." });
    }
    const remarks = String(req.body?.remarks ?? "").trim() || null;
    const transporter_name = String(req.body?.transporter_name ?? "").trim() || null;
    const vehicle_number = String(req.body?.vehicle_number ?? "").trim() || null;
    const gate = await updateGateEntryMeta(uid, {
      remarks,
      transporter_name,
      vehicle_number,
      updated_by: auditUserName(req),
    });
    res.json({ success: true, message: "Gate entry updated successfully.", data: gate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to update gate entry." });
  }
}

export async function deleteGateEntry(req, res) {
  try {
    const uid = req.body?.uid != null ? Number(req.body.uid) : null;
    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required." });
    }
    const row = await softDeleteGate(uid, auditUserName(req));
    if (!row) {
      return res.status(404).json({ success: false, message: "Gate entry not found." });
    }
    res.json({ success: true, message: "Gate entry deleted.", data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to delete gate entry." });
  }
}
