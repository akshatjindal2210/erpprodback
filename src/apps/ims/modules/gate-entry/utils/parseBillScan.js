/**
 * Gate Entry bill scan parser (server-side).
 * Accepts plain bill no, JSON QR, GST e-invoice SignedQR JWT, or base64 JSON.
 * Frontend must send the raw scan string; decoding happens here.
 */

function decodeBase64UrlToString(part) {
  const cleaned = String(part || "").replace(/\s+/g, "");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function decodeBase64UrlJson(part) {
  return JSON.parse(decodeBase64UrlToString(part));
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

function looksLikeBase64Blob(text) {
  const s = String(text || "").replace(/\s+/g, "");
  if (!s || s.length < 16) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return false;
  // Must look encoded (mix of letters), not a short plain bill.
  if (!/[A-Za-z]/.test(s)) return false;
  return true;
}

function tryDecodeBase64Json(text) {
  if (!looksLikeBase64Blob(text)) return null;
  try {
    const decoded = decodeBase64UrlToString(text);
    const trimmed = decoded.trim();
    if (!trimmed) return null;

    // Decoded text may itself be JSON, or another base64 layer, or a JWT.
    const asJson = tryParseJson(trimmed);
    if (asJson && typeof asJson === "object") return asJson;

    if (trimmed.includes(".") && /^eyJ/i.test(trimmed.replace(/\s+/g, ""))) {
      return { __jwt_raw: trimmed.replace(/\s+/g, "") };
    }

    if (looksLikeBase64Blob(trimmed) && trimmed !== String(text || "").replace(/\s+/g, "")) {
      const nested = tryDecodeBase64Json(trimmed);
      if (nested) return nested;
    }

    return null;
  } catch {
    return null;
  }
}

const DOC_KEYS = [
  "DocNo",
  "docNo",
  "doc_no",
  "billno",
  "bill_no",
  "BillNo",
  "Doc_No",
  "invoice_no",
  "InvoiceNo",
  "Irn",
  "irn",
];
const DT_KEYS = ["DocDt", "docDt", "doc_dt", "billdt", "bill_dt", "BillDt"];

function pickField(obj = {}, keys = []) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function unwrapInvoicePayload(dataObject) {
  if (!dataObject || typeof dataObject !== "object") return null;
  if (dataObject.__jwt_raw) return null;

  let inside = dataObject.data ?? dataObject.Data ?? dataObject;
  if (typeof inside === "string") {
    const asJson = tryParseJson(inside);
    if (asJson && typeof asJson === "object") {
      inside = asJson;
    } else {
      const asB64 = tryDecodeBase64Json(inside);
      if (asB64 && !asB64.__jwt_raw) inside = asB64;
    }
  }

  const payload = inside && typeof inside === "object" ? inside : dataObject;
  // Common GST / e-invoice nests
  const candidates = [
    payload,
    payload?.DocDtls,
    payload?.docDtls,
    payload?.Invoice,
    payload?.invoice,
    dataObject,
  ].filter((o) => o && typeof o === "object");

  let docNumber = "";
  let bill_dt = null;
  for (const obj of candidates) {
    docNumber =
      pickField(obj, DOC_KEYS.filter((k) => k !== "Irn" && k !== "irn")) || docNumber;
    bill_dt = bill_dt || pickField(obj, DT_KEYS) || null;
    if (docNumber) break;
  }
  if (!docNumber) return null;

  return {
    docNumber,
    bill_dt,
    payload,
  };
}

function extractJwtCandidate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const compact = s.replace(/\s+/g, "");
  const m = compact.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (m?.[0]) return m[0];
  // Only treat as JWT candidate when at least header.payload separator exists.
  if (/^eyJ[A-Za-z0-9_-]+\./i.test(compact)) return compact;
  return "";
}

function parseJwtSignedQr(raw) {
  const jwt = extractJwtCandidate(raw);
  if (!jwt) return null;

  const parts = jwt.split(".");
  // Pure base64 often starts with "eyJ" (JSON `{...}`) but has no dots — not a JWT.
  if (parts.length < 3 || !/^eyJ/i.test(parts[0])) {
    if (parts.length === 2 && /^eyJ/i.test(parts[0])) {
      throw new Error("Incomplete e-invoice QR. Scan the full QR and try again.");
    }
    return null;
  }

  const header = parts[0];
  const payloadPart = parts[1];
  const signature = parts[2];
  if (!header || !payloadPart || signature.length < 8) {
    throw new Error("Incomplete e-invoice QR. Scan the full QR and try again.");
  }

  try {
    const dataObject = decodeBase64UrlJson(payloadPart);
    const unwrapped = unwrapInvoicePayload(dataObject);
    if (!unwrapped?.docNumber) {
      throw new Error("Document number not found in e-invoice QR.");
    }
    return {
      docNumber: unwrapped.docNumber,
      bill_dt: unwrapped.bill_dt,
      payload: unwrapped.payload || {},
      source: "einvoice_jwt",
    };
  } catch (err) {
    if (/Document number|Incomplete e-invoice/i.test(String(err?.message || ""))) throw err;
    throw new Error("Invalid e-invoice QR. Scan the full QR from the tax invoice.");
  }
}

function parseBase64Bill(raw) {
  const decoded = tryDecodeBase64Json(raw);
  if (!decoded) return null;

  // Base64 wrapper around a JWT string
  if (decoded.__jwt_raw) {
    return parseJwtSignedQr(decoded.__jwt_raw);
  }

  const unwrapped = unwrapInvoicePayload(decoded);
  if (!unwrapped?.docNumber) return null;
  return {
    docNumber: unwrapped.docNumber,
    bill_dt: unwrapped.bill_dt,
    payload: unwrapped.payload,
    source: "base64_json",
  };
}

/**
 * @param {string} text Raw scanner / paste / camera payload
 * @returns {{ docNumber: string, bill_dt: string|null, payload: object|null, source: string }}
 */
export function parseBillScanPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Bill number or QR data is required.");
  const compact = raw.replace(/\s+/g, "");

  // 1) GST SignedQR JWT only when it has JWT separators (header.payload…)
  if (compact.includes(".") && /^eyJ/i.test(compact)) {
    const jwtParsed = parseJwtSignedQr(raw);
    if (jwtParsed) return jwtParsed;
  }

  // 2) Raw JSON QR
  if (raw.trim().startsWith("{") && raw.trim().endsWith("}")) {
    const obj = tryParseJson(raw);
    if (obj) {
      const unwrapped = unwrapInvoicePayload(obj);
      if (unwrapped?.docNumber) {
        return {
          docNumber: unwrapped.docNumber,
          bill_dt: unwrapped.bill_dt,
          payload: unwrapped.payload,
          source: "json",
        };
      }
    }
  }

  // 3) Phone / normal QR often returns a single base64 blob (may start with eyJ).
  const b64Parsed = parseBase64Bill(compact);
  if (b64Parsed) return b64Parsed;

  // Encoded QR that failed to unwrap — never treat the whole blob as a bill number.
  if (looksLikeBase64Blob(compact) && compact.length >= 48) {
    throw new Error(
      "Could not read document number from bill QR. Scan the full QR again, or type the bill number."
    );
  }

  // 4) Plain bill number
  return { docNumber: raw.trim(), bill_dt: null, payload: null, source: "plain" };
}
