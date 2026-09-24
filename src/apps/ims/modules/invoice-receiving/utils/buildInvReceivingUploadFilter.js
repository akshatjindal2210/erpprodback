import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { MODULE_DATES } from "../../../../../config/moduleDates.config.js";
import { buildImsBilldtRangeFilter, formatIstDateTime, formatIstDateYmd, indianFinancialYearBounds, parseBillDateHint } from "../../gate-entry/utils/imsBillDateFilter.js";
/** Invoice receiving upload folder (change here only if path changes). */
export const IR_RECEIVING_UPLOAD_PREFIX = "uploads/ims/invoice-receiving/";

/** Read: full path as-is; filename-only → prepend invoice-receiving folder. */
export function expandIrUploadPath(ref) {
  const s = String(ref ?? "").trim().replace(/\\/g, "/");
  if (isErpNullString(s)) return "";
  if (s.startsWith("uploads/")) return s;
  return `${IR_RECEIVING_UPLOAD_PREFIX}${s.replace(/^\/+/, "")}`;
}

/** Write ERP: our folder → filename only; any other `uploads/…` or bare name unchanged logic. */
export function compactIrFileRefForErp(ref) {
  const s = String(ref ?? "").trim().replace(/\\/g, "/");
  if (isErpNullString(s)) return "";
  if (s.startsWith(IR_RECEIVING_UPLOAD_PREFIX)) return s.slice(IR_RECEIVING_UPLOAD_PREFIX.length);
  if (s.startsWith("uploads/")) return s;
  return s;
}

export function isErpNullString(value) {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || s.toLowerCase() === "null";
}

function parseReceivingFileRaw(raw) {
  const out = [];
  if (isErpNullString(raw)) return out;
  const s = String(raw).trim();
  const push = (p) => {
    const full = expandIrUploadPath(p);
    if (full) out.push(full);
  };
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        Object.keys(o).sort((a, b) => Number(a) - Number(b)).forEach((k) => push(o[k]));
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        arr.forEach((p) => push(p));
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  if (s.includes("|")) {
    s.split("|")
      .map((p) => p.trim())
      .forEach((p) => push(p));
    return out;
  }
  push(s);
  return out;
}

/** ERP `receivingfile` — compact JSON object `{"0":"a.png","1":"b.jpg"}`. */
export function serializeReceivingFileForErp(paths) {
  const clean = (Array.isArray(paths) ? paths : []).map((p) => String(p).trim()).filter((p) => !isErpNullString(p));
  if (!clean.length) return "";
  const obj = {};
  clean.forEach((p, i) => {
    obj[String(i)] = compactIrFileRefForErp(p);
  });
  return JSON.stringify(obj);
}

export function parseExistingPathsFromBody(body) {
  const raw = body?.existing_paths;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter((p) => !isErpNullString(p));
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).filter((p) => !isErpNullString(p));
    } catch {
      /* fall through */
    }
  }
  return parseReceivingFileRaw(s);
}

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
  if (isErpNullString(raw)) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    const s = String(raw).trim();
    return s ? { remarks: s } : null;
  }
}

/**
 * IMS internal API — filter.type "update":
 * filter.data.billdt, prnbillno, receiverefno (audit JSON), receivingfile (path or JSON array string).
 */
export function buildInvReceivingUpdateFilter(req, opts = {}) {
  const { prnbillno, billdt, file_paths = [], approved = false, remarks = "", touchUpload = true } = opts;
  const paths = (Array.isArray(file_paths) ? file_paths : []).map((p) => String(p).trim()).filter((p) => !isErpNullString(p));

  const user = auditUserName(req) || "system";
  const now = formatIstDateTime(new Date());
  const wantApproved = !!approved;

  const uploaded_by = touchUpload ? user : String(req.body?.uploaded_by ?? "").trim() || user;
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
    uploaded_at
  };

  return {
    type: "update",
    data: {
      billdt: billdtOut,
      prnbillno: String(prnbillno ?? req.body?.prnbillno ?? "").trim(),
      receiverefno: receiverefnoToImsString(receiverefnoMeta),
      receivingfile: serializeReceivingFileForErp(paths),
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
      receiverefno: "",
      receivingfile: "",
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let from = parseBillDateHint(fromInput);
  let to = parseBillDateHint(toInput);

  if (!from && !to) {
    const fixedFromYmd = String(MODULE_DATES.ims.invoiceReceiving.pendingMergeFrom ?? "").trim();
    if (fixedFromYmd) {
      from = parseBillDateHint(fixedFromYmd);
      to = today;
    } else {
      const fy = indianFinancialYearBounds(today);
      from = fy.from;
      to = today > fy.to ? fy.to : today;
    }
  } else if (from && !to) {
    to = today;
  } else if (!from && to) {
    from = indianFinancialYearBounds(to).from;
  }

  if (from && to) {
    let a = from;
    let b = to;
    if (a > b) [a, b] = [b, a];
    filter.data = buildImsBilldtRangeFilter(a, b);
  }
  return filter;
}

