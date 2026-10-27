/**
 * Tray scan — aligned with frontend `parseTrayScan` (qrScan.js).
 */
import { normalizeScanInput } from "../../box/utils/stickers/stickerScanParse.js";

const TRAY_CODE_RE = /^(FG|RM)\d+$/i;

/** DB `code` after pad migration (FG001); old QR / laser may still send FG1. */
export function normalizeTrayLookupCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return c;
  const m = /^(FG|RM)(\d+)$/.exec(c);
  if (!m) return c;
  const n = parseInt(m[2], 10);
  if (!Number.isFinite(n)) return c;
  return `${m[1]}${String(n).padStart(3, "0")}`;
}

function queryParam(trimmed, name) {
  const m = trimmed.match(new RegExp(`[?&]${name}=([^&#\\s]+)`, "i"));
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
  } catch {
    return m[1].trim();
  }
}

export function normalizeTrayScanCode(raw) {
  const trimmed = normalizeScanInput(raw);
  if (!trimmed) return "";

  const hasTray = /[?&](?:tray_code|tray)=/i.test(trimmed);
  const isBoxUrl = /[?&]box_no_uid=/i.test(trimmed) || /[?&]fuid=/i.test(trimmed) || /[?&]coil_no_uid=/i.test(trimmed);
  if (hasTray && !isBoxUrl) {
    const id = queryParam(trimmed, "id");
    if (id && /^\d+$/.test(id)) return id;
    const code = queryParam(trimmed, "tray_code") || queryParam(trimmed, "tray");
    if (code) return normalizeTrayLookupCode(code);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const p = JSON.parse(trimmed);
      if (/^\d+$/.test(String(p?.id ?? "").trim())) return String(p.id).trim();
      if (/^\d+$/.test(String(p?.tray_id ?? "").trim())) return String(p.tray_id).trim();
      if (p?.code != null && String(p.code).trim() !== "") return normalizeTrayLookupCode(p.code);
    } catch {
      /* continue */
    }
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("://")) return "";

  const upper = trimmed.toUpperCase();
  if (TRAY_CODE_RE.test(upper)) return normalizeTrayLookupCode(upper);
  if (/^\d+$/.test(trimmed)) return trimmed;
  return "";
}
