import { fetchImsDataRaw } from "../../../lib/services/ims.service.js";
import { toImsIrPublicUploadPath } from "../../../lib/middleware/upload.js";
import { formatIstDateTime } from "../../gate-entry/utils/imsBillDateFilter.js";
import { buildInvReceivingClearFilter, buildInvReceivingErpPayload, buildInvReceivingListFilter, buildInvReceivingUpdateFilter, parseReceiverefnoFromIms } from "../utils/buildInvReceivingUploadFilter.js";

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

const canMode = (req, mode) => String(req.user?.type || "").toLowerCase() === "super_admin" || Boolean(req.permission?.[MODE_PERM[mode]]);

function parseTruthyFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

/** Pending `type:""` · Register `type:"register"` + optional `data` billdt range. */
export async function listInvoiceReceiving(req, res) {
  try {
    const type = req.body?.type == null ? "" : String(req.body.type);
    const from_date = req.body?.from_date ?? req.body?.fromDate ?? null;
    const to_date = req.body?.to_date ?? req.body?.toDate ?? null;
    const filter = buildInvReceivingListFilter(type, from_date, to_date);
    const json = await fetchImsDataRaw("invreceiving", filter);
    if (!json?.success) {
      return res.status(502).json({ success: false, message: json?.message || "Failed to load invoice receiving.", data: [] });
    }
    return res.json({
      success: true,
      message: json.message,
      data: (Array.isArray(json.records) ? json.records : []).map(mapRow),
    });
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

    const existingPath = String(req.body?.receivingfile || req.body?.file_path || "").trim();
    if (!req.file && !existingPath) {
      return res.status(400).json({ success: false, message: "One PDF or image attachment is required." });
    }

    const file_path = req.file ? toImsIrPublicUploadPath(req.file) : existingPath;
    if (!file_path) return res.status(500).json({ success: false, message: "Failed to resolve attachment path." });

    const wantApproved = parseTruthyFlag(req.body?.approved);

    const touchUpload = Boolean(req.file) || mode === "add";
    const filter = buildInvReceivingUpdateFilter(req, {
      prnbillno: req.body?.prnbillno,
      billdt: req.body?.billdt,
      file_path,
      approved: wantApproved,
      remarks: req.body?.remarks,
      touchUpload,
    });

    const erp_payload = buildInvReceivingErpPayload(filter);
    console.log("[invoice-receiving] IMS payload:\n", JSON.stringify(erp_payload, null, 2));

    const erp = await fetchImsDataRaw("invreceiving", filter);
    if (!erp?.success) {
      return res.status(502).json({
        success: false,
        message: erp?.message || "IMS upload failed.",
        data: { erp_payload, file_path, erp },
      });
    }

    return res.json({
      success: true,
      message: erp?.message || "Uploaded to IMS.",
      data: { mode, erp_payload, erp, ...filter },
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
    const erp_payload = buildInvReceivingErpPayload(filter);
    console.log("[invoice-receiving] clear payload:\n", JSON.stringify(erp_payload, null, 2));

    const erp = await fetchImsDataRaw("invreceiving", filter);
    if (!erp?.success) {
      return res.status(502).json({
        success: false,
        message: erp?.message || "IMS clear receiving failed.",
        data: { erp_payload, erp },
      });
    }

    return res.json({
      success: true,
      message: erp?.message || "Receiving cleared on IMS.",
      data: { erp_payload, erp, ...filter },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || "Failed to clear invoice receiving." });
  }
}

export { MODULE };
