import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { buildImsBilldtRangeFilter, formatIstDateTime, formatIstDateYmd, parseBillDateHint } from "../../gate-entry/utils/imsBillDateFilter.js";

/**
 * ERP field `receiverefno` is one string column — store JSON text inside it.
 * App code uses a plain object; call this once before IMS update.
 */
export function receiverefnoToImsString(meta) {
  if (meta == null) return JSON.stringify({});
  if (typeof meta === "string") {
    const s = meta.trim();
    if (!s) return JSON.stringify({});
    try {
      JSON.parse(s);
      return s;
    } catch {
      return JSON.stringify({ remarks: s });
    }
  }
  return JSON.stringify(meta);
}

/** List/register row → object for UI (safe if ERP already returns object). */
export function parseReceiverefnoFromIms(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { remarks: String(raw).trim() };
  }
}

/**
 * IMS internal API — filter.type "update":
 * filter.data.billdt, prnbillno, receiverefno (JSON string), receivingfile (path).
 */
export function buildInvReceivingUpdateFilter(req, opts = {}) {
  const { prnbillno, billdt, file_path, approved = false, remarks = "", touchUpload = true } = opts;

  const user = auditUserName(req) || "system";
  const now = formatIstDateTime(new Date());
  const wantApproved = !!approved;

  const uploaded_by = touchUpload
    ? user
    : String(req.body?.uploaded_by ?? "").trim() || user;
  const uploaded_at = touchUpload
    ? now
    : (() => {
        const raw = req.body?.uploaded_at;
        if (raw == null || String(raw).trim() === "") return now;
        return formatIstDateTime(raw);
      })();

  const billdtOut = formatIstDateYmd(billdt ?? req.body?.billdt);

  const receiverefnoMeta = {
    remarks: String(remarks ?? req.body?.remarks ?? "").trim(),
    approved: wantApproved,
    approved_by: wantApproved ? user : "",
    approved_at: wantApproved ? now : "",
    uploaded_by,
    uploaded_at,
  };

  return {
    type: "update",
    data: {
      billdt: billdtOut,
      prnbillno: String(prnbillno ?? req.body?.prnbillno ?? "").trim(),
      receiverefno: receiverefnoToImsString(receiverefnoMeta),
      receivingfile: String(file_path || "").trim(),
    },
  };
}

/** Clear receiving on ERP — bill returns to pending (no attachment / ref). */
export function buildInvReceivingClearFilter({ prnbillno, billdt }) {
  const billdtOut = formatIstDateYmd(billdt);
  return {
    type: "update",
    data: {
      billdt: billdtOut,
      prnbillno: String(prnbillno ?? "").trim(),
      receiverefno: null,
      receivingfile: null,
    },
  };
}

/**
 * IMS list — pending `{ type: "" }` · register `{ type: "register", data: "billdt >= '…' and …" }`.
 */
export function buildInvReceivingListFilter(type, fromInput, toInput) {
  const t = type == null ? "" : String(type);
  if (t !== "register") return { type: t };
  const filter = { type: "register" };
  const from = parseBillDateHint(fromInput);
  const to = parseBillDateHint(toInput);
  if (from && to) {
    let a = from;
    let b = to;
    if (a > b) [a, b] = [b, a];
    filter.data = buildImsBilldtRangeFilter(a, b);
  }
  return filter;
}

export function buildInvReceivingErpPayload(filter) {
  return {
    requestedData: "invreceiving",
    filter,
  };
}

/** @deprecated use buildInvReceivingUpdateFilter */
export const buildInvReceivingUploadFilter = buildInvReceivingUpdateFilter;
