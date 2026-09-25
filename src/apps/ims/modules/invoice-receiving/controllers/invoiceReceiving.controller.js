import { fetchImsDataRaw } from "../../../lib/services/ims.service.js";
import { toImsIrPublicUploadPath } from "../../../lib/middleware/upload.js";
import { clearGateInvoiceReceiving, findMatchedOutGateRows, findUnmatchedOutGateRows, saveGateInvoiceReceiving } from "../../gate-entry/models/gateEntry.model.js";
import { formatIstDateTime, resolveGateImsBilldtFilter } from "../../gate-entry/utils/imsBillDateFilter.js";
import { buildGateReceivingPayload, isErpNullString, parseExistingPathsFromBody, parseReceivingMeta } from "../utils/buildInvReceivingUploadFilter.js";

const MODULE = "invoice_receiving";
const MODE_PERM = { add: "can_add", edit: "can_edit", approve: "can_authorize" };

const DATE_KEYS = ["billdt", "uploaded_at", "approved_at"];

/** Map gate row → Invoice Receiving list/drawer shape (no ERP). */
function mapGateToIrRow(gate, accName = null) {
  if (!gate || typeof gate !== "object") return gate;
  const meta = parseReceivingMeta(gate.receiving_meta);
  const out = {
    gate_uid: gate.uid,
    prnbillno: String(gate.bill_no ?? "").trim() || null,
    billdt: gate.bill_dt ?? null,
    acc_name: accName || meta?.acc_name || null,
    transport: gate.transporter_name || meta?.transport || null,
    vehicleno: gate.vehicle_number || meta?.vehicleno || null,
    remarks: gate.remarks ?? null,
    receivingfile: gate.receiving_file ?? null,
    receiverefno: gate.receiving_meta ?? null,
  };

  if (meta && typeof meta === "object") {
    for (const k of ["remarks", "approved", "uploaded_by", "uploaded_at", "approved_by", "approved_at"]) {
      if ((out[k] == null || out[k] === "") && meta[k] != null && meta[k] !== "") out[k] = meta[k];
    }
  }

  for (const k of DATE_KEYS) {
    if (out[k] != null && out[k] !== "") out[k] = formatIstDateTime(out[k]);
  }
  return out;
}

const canMode = (req, mode) => {
  if (String(req.user?.type || "").toLowerCase() === "super_admin") return true;
  const p = req.permission || {};
  if (mode === "approve") return Boolean(p.can_authorize);
  if (mode === "add" || mode === "edit") return Boolean(p.can_add || p.can_edit || p.can_authorize);
  return Boolean(p[MODE_PERM[mode]]);
};

function parseTruthyFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

/** Customer name from invmnote (display only — same as Gate Entry register). */
async function accNameByBillKeys(billKeys) {
  const map = new Map();
  if (!billKeys?.size) return map;

  const fy = resolveGateImsBilldtFilter(null, { useTodayAsEnd: true });
  let json = await fetchImsDataRaw("invmnote", fy.filter);
  if (!json?.success) json = await fetchImsDataRaw("invmnote", null);

  for (const rec of Array.isArray(json?.records) ? json.records : []) {
    const billno = String(rec?.billno ?? rec?.bill_no ?? rec?.DocNo ?? "")
      .trim()
      .toLowerCase();
    if (!billno || !billKeys.has(billno) || map.has(billno)) continue;
    const acc = String(rec?.acc_name ?? "").trim();
    if (acc) map.set(billno, acc);
  }
  return map;
}

async function mapGatesToIrRows(gates) {
  const list = gates || [];
  const billKeys = new Set(list.map((g) => String(g?.bill_no ?? "").trim().toLowerCase()).filter(Boolean));
  const accByBill = await accNameByBillKeys(billKeys);
  return list.map((g) => {
    const key = String(g?.bill_no ?? "")
      .trim()
      .toLowerCase();
    return mapGateToIrRow(g, accByBill.get(key) || null);
  });
}

/**
 * Fully local on Gate Entry — no invreceiving / internal API.
 * Pending = unmatched OUT · Register = matched OUT with receiving_file.
 */
export async function listInvoiceReceiving(req, res) {
  try {
    const type = req.body?.type == null ? "" : String(req.body.type);
    const from_date = req.body?.from_date ?? req.body?.fromDate ?? null;
    const to_date = req.body?.to_date ?? req.body?.toDate ?? null;
    const isRegister = type === "register";

    if (!isRegister) {
      const gates = await findUnmatchedOutGateRows();
      const rows = await mapGatesToIrRows(gates);
      return res.json({ success: true, message: "Gate Out pending for invoice receiving.", data: rows });
    }

    // Register / pending-merge: gate_registered_only is always true locally (data is gate-only).
    const gates = await findMatchedOutGateRows({ from_date, to_date });
    const rows = await mapGatesToIrRows(gates);
    return res.json({ success: true, message: "Gate Out invoice receiving register.", data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to load invoice receiving.", data: [] });
  }
}

/** Add / Edit / Approve — save attachment + meta on Gate Entry only. */
export async function updateInvoiceReceiving(req, res) {
  try {
    const modeRaw = String(req.body?.mode || "add").toLowerCase();
    const mode = MODE_PERM[modeRaw] ? modeRaw : "add";
    if (!canMode(req, mode)) return res.status(403).json({ success: false, message: "No access for this action." });

    const uploaded = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    const newPaths = uploaded.map((f) => toImsIrPublicUploadPath(f)).filter(Boolean);
    const existingPaths = parseExistingPathsFromBody(req.body).filter((p) => !isErpNullString(p));
    const file_paths = [...existingPaths, ...newPaths];

    if (file_paths.length === 0) {
      return res.status(400).json({ success: false, message: "At least one PDF or image attachment is required." });
    }

    const prnbillno = String(req.body?.prnbillno ?? "").trim();
    if (!prnbillno) {
      return res.status(400).json({ success: false, message: "Bill number (prnbillno) is required." });
    }

    const wantApproved = parseTruthyFlag(req.body?.approved);
    const touchUpload = newPaths.length > 0 || mode === "add";
    const payload = buildGateReceivingPayload(req, {
      file_paths,
      approved: wantApproved,
      remarks: req.body?.remarks,
      touchUpload,
    });

    const gate = await saveGateInvoiceReceiving(prnbillno, {
      receiving_file: payload.receiving_file,
      receiving_meta: payload.receiving_meta,
    });

    if (!gate) {
      return res.status(404).json({
        success: false,
        message: "Gate Out entry not found for this bill. Save Gate Entry first.",
      });
    }

    return res.json({
      success: true,
      message: "Invoice receiving saved on Gate Entry.",
      data: { mode, row: mapGateToIrRow(gate) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to update invoice receiving." });
  }
}

/** Clear receiving on Gate Entry — bill returns to Pending. */
export async function deleteInvoiceReceiving(req, res) {
  try {
    const isSuper = String(req.user?.type || "").toLowerCase() === "super_admin";
    if (!isSuper && !req.permission?.can_delete) {
      return res.status(403).json({ success: false, message: "No access for this action." });
    }

    const prnbillno = String(req.body?.prnbillno ?? "").trim();
    if (!prnbillno) {
      return res.status(400).json({ success: false, message: "Bill number (prnbillno) is required." });
    }

    const gate = await clearGateInvoiceReceiving(prnbillno);
    if (!gate) {
      return res.status(404).json({
        success: false,
        message: "Gate Out entry not found for this bill.",
      });
    }

    return res.json({
      success: true,
      message: "Invoice receiving cleared on Gate Entry.",
      data: { row: mapGateToIrRow(gate) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to clear invoice receiving." });
  }
}

export { MODULE };
