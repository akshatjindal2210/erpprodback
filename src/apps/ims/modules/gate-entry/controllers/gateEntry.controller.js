import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { enrichRowsWithIMS, getImsMapsSafe } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { fetchFromIMS } from "../../../lib/services/ims.service.js";
import { approveGate, findFnDispatch, findFnItemIds, findFnItems, findGateByBillNo, findGateByUid, findGateRows, findOutBoxes, findPendingGateRows, findPendingOut, findScannedBoxes, insertGateDraft, replaceScannedBoxes, resolveOutForGate, softDeleteGate, updateGateDraft } from "../models/gateEntry.model.js";

async function withAccName(rows) {
  const { ledgerMap } = await getImsMapsSafe();
  return enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
    maps: { ledgerMap },
  });
}

function packingFromUid(rec = {}) {
  const raw = String(rec?.uid ?? "").trim() || String(rec?.muid ?? "").trim();
  const parts = raw.split("-").filter(Boolean);
  return parts.length >= 3 ? parts[2] : null;
}

function invfnoteBillNo(rec = {}) {
  return String(rec?.billno ?? rec?.prnbillno ?? rec?.bill_no ?? rec?.DocNo ?? "").trim();
}

function mapInvfnote(rec = {}) {
  const uid = String(rec?.uid ?? "").trim() || null;
  return {
    uid,
    muid: String(rec?.muid ?? "").trim() || null,
    billno: invfnoteBillNo(rec),
    acc_name: String(rec?.acc_name ?? "").trim() || null,
    acc_code: rec?.acc_code ?? (uid ? uid.split("-")[0] : null) ?? null,
    boxes: String(rec?.boxes ?? "").trim() || null,
    item_code: String(rec?.item_code ?? rec?.itemdcode ?? "").trim() || null,
    item_desc: String(rec?.item_desc ?? rec?.itemdesc ?? "").trim() || null,
    billdt: String(rec?.billdt ?? "").trim() || null,
    status: String(rec?.status ?? "").trim() || null,
    packing_number: packingFromUid(rec),
  };
}

async function loadInvfnoteByBill(bill_no) {
  const needle = String(bill_no || "").trim().toLowerCase();
  if (!needle) return [];
  const recordsRaw = await fetchFromIMS("invfnote");
  const records = Array.isArray(recordsRaw) ? recordsRaw : [];
  let invfnote = records.filter((rec) => invfnoteBillNo(rec).toLowerCase() === needle).map(mapInvfnote);
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

function decodeEInvoiceQr(text) {
  const parts = String(text || "").trim().split(".");
  if (parts.length !== 3) throw new Error("Invalid e-invoice QR. Scan the full JWT string.");
  const dataObject = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const inside =
    typeof dataObject?.data === "string" ? JSON.parse(dataObject.data) : dataObject?.data;
  const docNumber = String(inside?.DocNo ?? inside?.docNo ?? "").trim();
  if (!docNumber) throw new Error("Document number not found in QR payload.");
  return { docNumber, payload: inside || {} };
}

async function buildDetails({ uid, out_uid, bill_no, packing_numbers = [], invfnote: invfnoteIn } = {}) {
  let gate = null;
  if (uid != null && uid !== "") {
    gate = await findGateByUid(Number(uid));
    if (!gate) return null;
  } else if (bill_no) {
    gate = await findGateByBillNo(bill_no);
  }

  const resolved = await resolveOutForGate({
    uid: gate?.uid,
    out_uid,
    bill_no: gate?.bill_no || bill_no,
    packing_numbers,
  });

  const outUid =
    out_uid != null && out_uid !== ""
      ? Number(out_uid)
      : resolved?.out_uid != null
        ? Number(resolved.out_uid)
        : null;
  const fuid = resolved?.fuid != null ? Number(resolved.fuid) : null;
  if (!outUid && !gate) return null;

  const boxes = outUid ? await findOutBoxes(outUid) : [];
  const scanned = gate?.uid ? await findScannedBoxes(gate.uid) : [];
  const scannedSet = new Set(scanned);
  const required = boxes.map((b) => String(b.box_no_uid).trim()).filter(Boolean);

  const billNo = gate?.bill_no || bill_no || null;
  let invfnote = Array.isArray(invfnoteIn) ? invfnoteIn : [];
  if (!invfnote.length && billNo) {
    try {
      invfnote = await loadInvfnoteByBill(billNo);
    } catch {
      invfnote = [];
    }
  }

  let dispatch = fuid ? await findFnDispatch(fuid) : null;
  if (dispatch?.acc_code && !dispatch.acc_name) {
    const [enriched] = await withAccName([dispatch]);
    dispatch = enriched || dispatch;
  }

  const live = invfnote[0] || null;

  return {
    gate: {
      uid: gate?.uid || null,
      bill_no: billNo,
      bill_dt: gate?.bill_dt || live?.billdt || null,
      remarks: gate?.remarks || null,
      scan_complete: gate?.scan_complete ?? false,
      approved: gate?.approved ?? false,
      out_uid: outUid,
      fuid,
    },
    dispatch: dispatch
      ? {
          vehicle_number: dispatch.vehicle_number || null,
          transporter_name: dispatch.transporter_name || null,
          po_number: dispatch.po_number || null,
          acc_code: dispatch.acc_code || null,
          acc_name: dispatch.acc_name || live?.acc_name || null,
          total_items: dispatch.total_items ?? null,
        }
      : {
          vehicle_number: null,
          transporter_name: null,
          po_number: null,
          acc_code: live?.acc_code || null,
          acc_name: live?.acc_name || null,
          total_items: null,
        },
    invfnote,
    items: fuid ? await findFnItems(fuid) : [],
    boxes: boxes.map((b) => {
      const id = String(b.box_no_uid).trim();
      return { ...b, box_no_uid: id, is_scanned: scannedSet.has(id) };
    }),
    scanned_boxes: scanned,
    boxes_required: required.length,
    boxes_scanned: scanned.length,
    all_scanned: required.length > 0 && required.every((id) => scannedSet.has(id)),
  };
}

export async function listPendingGateEntries(_req, res) {
  try {
    const rows = await findPendingGateRows();
    res.json({ success: true, data: await withAccName(rows), total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending list." });
  }
}

export async function listGateEntries(_req, res) {
  try {
    const rows = await findGateRows();
    res.json({ success: true, data: await withAccName(rows), total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load gate entries." });
  }
}

export async function getGateDetails(req, res) {
  try {
    const details = await buildDetails({
      uid: req.body?.uid,
      out_uid: req.body?.out_uid,
      bill_no: req.body?.bill_no,
    });
    if (!details) {
      return res.status(404).json({ success: false, message: "Gate entry or store-out not found." });
    }
    res.json({ success: true, data: details });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load details." });
  }
}

export async function saveGateEntry(req, res) {
  try {
    const user = auditUserName(req);
    const bill_no = req.body?.bill_no != null ? String(req.body.bill_no).trim() || null : null;
    const bill_dt = req.body?.bill_dt != null ? String(req.body.bill_dt).trim() || null : null;
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() || null : null;
    const wantComplete = Boolean(req.body?.complete);
    const packing_numbers = Array.isArray(req.body?.packing_numbers) ? req.body.packing_numbers : [];
    const scanned_boxes = Array.isArray(req.body?.scanned_boxes) ? req.body.scanned_boxes : [];

    if (!bill_no) {
      return res.status(400).json({ success: false, message: "Bill number is required." });
    }

    let uid = req.body?.uid != null && req.body?.uid !== "" ? Number(req.body.uid) : null;
    let gate = uid ? await findGateByUid(uid) : await findGateByBillNo(bill_no);

    const pending = await findPendingOut({
      out_uid: req.body?.out_uid,
      bill_no,
      packing_numbers,
    });
    if (!pending?.out_uid) {
      return res.status(400).json({
        success: false,
        message: "No pending store-out found for this bill.",
      });
    }

    if (!gate) {
      gate = await insertGateDraft({ bill_no, bill_dt, remarks, created_by: user });
    }
    uid = gate.uid;

    if (gate.approved) {
      return res.status(400).json({ success: false, message: "This gate entry is already approved." });
    }

    const boxes = await findOutBoxes(pending.out_uid);
    const required = new Set(boxes.map((b) => String(b.box_no_uid).trim()).filter(Boolean));
    if (!required.size) {
      return res.status(400).json({
        success: false,
        message: "No boxes are linked to this store-out.",
      });
    }

    const scanned = [...new Set(scanned_boxes.map((u) => String(u).trim()).filter(Boolean))];
    const invalid = scanned.filter((id) => !required.has(id));
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        message: `Box not on this store-out: ${invalid.slice(0, 3).join(", ")}`,
      });
    }

    await replaceScannedBoxes(uid, scanned);
    const allScanned = [...required].every((id) => scanned.includes(id));
    if (wantComplete && !allScanned) {
      return res.status(400).json({
        success: false,
        message: `Scan all boxes first (${scanned.length}/${required.size}).`,
      });
    }

    await updateGateDraft(uid, {
      bill_no,
      bill_dt: bill_dt || gate.bill_dt,
      remarks: remarks != null ? remarks : gate.remarks,
      scan_complete: allScanned,
      updated_by: user,
    });

    const details = await buildDetails({
      uid,
      out_uid: pending.out_uid,
      bill_no,
      packing_numbers,
    });

    res.json({
      success: true,
      message: allScanned ? "All boxes scanned." : "Draft saved.",
      data: details,
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "A gate entry already exists for this bill.",
      });
    }
    res.status(500).json({ success: false, message: err.message || "Failed to save gate entry." });
  }
}

export async function approveGateEntry(req, res) {
  try {
    const uid = Number(req.body?.uid);
    if (!Number.isFinite(uid)) {
      return res.status(400).json({ success: false, message: "Gate uid is required." });
    }

    const gate = await findGateByUid(uid);
    if (!gate) {
      return res.status(404).json({ success: false, message: "Gate entry not found." });
    }
    if (gate.approved) {
      return res.status(400).json({ success: false, message: "This gate entry is already approved." });
    }

    const resolved = await resolveOutForGate({ uid, bill_no: gate.bill_no });
    if (!resolved?.out_uid || !resolved?.fuid) {
      return res.status(400).json({
        success: false,
        message: "Could not resolve store-out. Scan at least one box first.",
      });
    }

    const boxes = await findOutBoxes(resolved.out_uid);
    const scanned = await findScannedBoxes(uid);
    const required = boxes.map((b) => String(b.box_no_uid).trim()).filter(Boolean);
    const set = new Set(scanned);
    if (!required.length || !required.every((id) => set.has(id))) {
      return res.status(400).json({
        success: false,
        message: `Scan all boxes first (${scanned.length}/${required.length}).`,
      });
    }

    const bill_no = String(gate.bill_no || "").trim();
    if (!bill_no) {
      return res.status(400).json({ success: false, message: "Bill number is missing on this gate entry." });
    }

    const user = auditUserName(req);
    const row = await approveGate(uid, user);
    if (!row) {
      return res.status(400).json({ success: false, message: "Could not approve gate entry." });
    }

    const itemIds = await findFnItemIds(resolved.fuid);
    if (itemIds.length) {
      await assignForwardingNoteItemBills({
        itemIds,
        bill_no,
        bill_dt: row.bill_dt,
        userName: user,
      });
    }

    res.json({
      success: true,
      message: "Gate entry approved. Bill saved on forwarding note items.",
      data: { ...row, out_uid: resolved.out_uid, fuid: resolved.fuid },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to approve gate entry." });
  }
}

export async function deleteGateEntry(req, res) {
  try {
    const uid = Number(req.body?.uid);
    if (!Number.isFinite(uid)) {
      return res.status(400).json({ success: false, message: "Gate uid is required." });
    }
    const row = await softDeleteGate(uid, auditUserName(req));
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Gate entry not found or already approved.",
      });
    }
    res.json({ success: true, message: "Gate entry deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to delete gate entry." });
  }
}

export async function scanGateBill(req, res) {
  try {
    const raw = String(req.body?.qrData ?? req.body?.bill_no ?? "").trim();
    if (!raw) {
      return res.status(400).json({ success: false, message: "Bill number or QR data is required." });
    }

    let docNumber = raw;
    let qrPayload = null;
    if (raw.split(".").length === 3) {
      const decoded = decodeEInvoiceQr(raw);
      docNumber = decoded.docNumber;
      qrPayload = decoded.payload;
    }

    const invfnote = await loadInvfnoteByBill(docNumber);
    const packings = invfnote.map((r) => r.packing_number).filter(Boolean);
    let pending = await findPendingOut({ bill_no: docNumber });
    if (!pending && packings.length) {
      pending = await findPendingOut({ packing_numbers: packings });
    }

    const existing = await findGateByBillNo(docNumber);
    let details = null;
    if (pending?.out_uid || existing?.uid) {
      details = await buildDetails({
        uid: existing?.uid || pending?.uid,
        out_uid: pending?.out_uid,
        bill_no: docNumber,
        packing_numbers: packings,
        invfnote,
      });
      if (details?.gate) {
        details.gate.bill_no = details.gate.bill_no || docNumber;
        details.gate.bill_dt = details.gate.bill_dt || invfnote[0]?.billdt || null;
      }
    }

    res.json({
      success: true,
      data: {
        docNumber,
        qrPayload,
        bill_dt: invfnote[0]?.billdt || null,
        matchCount: invfnote.length,
        invfnote,
        pendingOut: pending
          ? {
              out_uid: pending.out_uid,
              fuid: pending.fuid,
              uid: existing?.uid || pending.uid || null,
              bill_no: docNumber,
              bill_dt:
                existing?.bill_dt || pending.gate_bill_dt || invfnote[0]?.billdt || null,
              scan_complete: existing?.scan_complete ?? pending.scan_complete ?? null,
              approved: existing?.approved ?? pending.approved ?? null,
            }
          : null,
        details,
      },
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err?.message || "Failed to process bill scan.",
    });
  }
}
