import { fetchImsDataRaw } from "../../../lib/services/ims.service.js";
import { toImsIrPublicUploadPath } from "../../../lib/middleware/upload.js";
import { findSavedGateBillSet } from "../../gate-entry/models/gateEntry.model.js";
import { formatIstDateTime } from "../../gate-entry/utils/imsBillDateFilter.js";
import { buildInvReceivingClearFilter, buildInvReceivingListFilter, buildInvReceivingUpdateFilter, isErpNullString, parseExistingPathsFromBody, parseReceiverefnoFromIms } from "../utils/buildInvReceivingUploadFilter.js";

const MODULE = "invoice_receiving";
const MODE_PERM = { add: "can_add", edit: "can_edit", approve: "can_authorize" };

const DATE_KEYS = ["billdt", "uploaded_at", "approved_at"];

const mapRow = (row) => {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  const ref = parseReceiverefnoFromIms(out.receiverefno);
  if (ref && typeof ref === "object") {
    for (const k of ["remarks", "approved", "uploaded_by", "uploaded_at", "approved_by", "approved_at"]) {
      if ((out[k] == null || out[k] === "") && ref[k] != null && ref[k] !== "") out[k] = ref[k];
    }
  }
  for (const k of DATE_KEYS) {
    if (out[k] != null && out[k] !== "") out[k] = formatIstDateTime(out[k]);
  }
  return out;
};

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

/** Pending `type:""` (gate-registered only) · Register `type:"register"` + optional billdt range. */
export async function listInvoiceReceiving(req, res) {
  try {
    const type = req.body?.type == null ? "" : String(req.body.type);
    const from_date = req.body?.from_date ?? req.body?.fromDate ?? null;
    const to_date = req.body?.to_date ?? req.body?.toDate ?? null;
    const gateOnly = type !== "register" || parseTruthyFlag(req.body?.gate_registered_only);
    const filter = buildInvReceivingListFilter(type, from_date, to_date);
    const json = await fetchImsDataRaw("invreceiving", filter);
    if (!json?.success) {
      return res.status(502).json({ success: false, message: json?.message || "Failed to load invoice receiving.", data: [] });
    }
    let rows = (Array.isArray(json.records) ? json.records : []).map(mapRow);
    if (gateOnly) {
      const saved = await findSavedGateBillSet();
      rows = rows.filter((r) => saved.has(String(r?.prnbillno ?? "").trim().toLowerCase()));
    }
    return res.json({ success: true, message: json.message, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to load invoice receiving.", data: [] });
  }
}

/** Add / Edit / Approve → IMS internal API `filter.type: "update"` + `filter.data`. */
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

    const wantApproved = parseTruthyFlag(req.body?.approved);

    const touchUpload = newPaths.length > 0 || mode === "add";
    const filter = buildInvReceivingUpdateFilter(req, {
      prnbillno: req.body?.prnbillno,
      billdt: req.body?.billdt,
      file_paths,
      approved: wantApproved,
      remarks: req.body?.remarks,
      touchUpload,
    });

    const erp = await fetchImsDataRaw("invreceiving", filter);
    if (!erp?.success) {
      return res.status(502).json({
        success: false,
        message: erp?.message || "IMS upload failed.",
        data: { file_paths, erp },
      });
    }

    return res.json({
      success: true,
      message: erp?.message || "Uploaded to IMS.",
      data: { mode, erp },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to update invoice receiving." });
  }
}

/** Register only — clears receiverefno + receivingfile on ERP (returns bill to pending). */
export async function deleteInvoiceReceiving(req, res) {
  try {
    const isSuper = String(req.user?.type || "").toLowerCase() === "super_admin";
    if (!isSuper && !req.permission?.can_delete) {
      return res.status(403).json({ success: false, message: "No access for this action." });
    }

    const prnbillno = String(req.body?.prnbillno ?? "").trim();
    const billdt = req.body?.billdt;
    if (!prnbillno) {
      return res.status(400).json({ success: false, message: "Bill number (prnbillno) is required." });
    }
    if (billdt == null || String(billdt).trim() === "") {
      return res.status(400).json({ success: false, message: "Bill date (billdt) is required." });
    }

    const filter = buildInvReceivingClearFilter({ prnbillno, billdt });
    const erp = await fetchImsDataRaw("invreceiving", filter);
    if (!erp?.success) {
      return res.status(502).json({
        success: false,
        message: erp?.message || "IMS clear receiving failed.",
        data: { erp },
      });
    }

    return res.json({
      success: true,
      message: erp?.message || "Receiving cleared on IMS.",
      data: { erp },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to clear invoice receiving." });
  }
}

export { MODULE };
