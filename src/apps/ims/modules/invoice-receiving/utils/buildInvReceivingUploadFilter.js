import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { formatIstDateTime } from "../../gate-entry/utils/imsBillDateFilter.js";

/** Invoice receiving upload folder (change here only if path changes). */
export const IR_RECEIVING_UPLOAD_PREFIX = "uploads/ims/invoice-receiving/";

/** Read: full path as-is; filename-only → prepend invoice-receiving folder. */
export function expandIrUploadPath(ref) {
  const s = String(ref ?? "").trim().replace(/\\/g, "/");
  if (isErpNullString(s)) return "";
  if (s.startsWith("uploads/")) return s;
  return `${IR_RECEIVING_UPLOAD_PREFIX}${s.replace(/^\/+/, "")}`;
}

/** Store on gate: our folder → filename only; other `uploads/…` paths kept. */
export function compactIrFileRef(ref) {
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
        Object.keys(o)
          .sort((a, b) => Number(a) - Number(b))
          .forEach((k) => push(o[k]));
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

/** Expanded attachment paths from gate/ERP `receivingfile` raw value. */
export function parseReceivingFilePaths(raw) {
  return parseReceivingFileRaw(raw);
}

/** Gate `receiving_file` — compact JSON object `{"0":"a.png","1":"b.jpg"}`. */
export function serializeReceivingFile(paths) {
  const clean = (Array.isArray(paths) ? paths : []).map((p) => String(p).trim()).filter((p) => !isErpNullString(p));
  if (!clean.length) return "";
  const obj = {};
  clean.forEach((p, i) => {
    obj[String(i)] = compactIrFileRef(p);
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

export function receivingMetaToString(meta) {
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

/** Gate `receiving_meta` JSON → object for UI. */
export function parseReceivingMeta(raw) {
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

/** @deprecated alias — FE/BE used ERP name; same as parseReceivingMeta */
export function parseReceiverefnoFromIms(raw) {
  return parseReceivingMeta(raw);
}

/**
 * Build local gate payload for invoice receiving save (no ERP / invreceiving).
 */
export function buildGateReceivingPayload(req, opts = {}) {
  const { file_paths = [], approved = false, remarks = "", touchUpload = true } = opts;
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

  const receiving_meta = {
    remarks: String(remarks ?? req.body?.remarks ?? "").trim(),
    approved: wantApproved,
    approved_by: wantApproved ? user : "",
    approved_at: wantApproved ? now : "",
    uploaded_by,
    uploaded_at,
  };

  return {
    receiving_file: serializeReceivingFile(paths),
    receiving_meta: receivingMetaToString(receiving_meta),
  };
}
