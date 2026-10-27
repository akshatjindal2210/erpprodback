/**
 * Tray scan — aligned with frontend `parseTrayScan` (qrScan.js).
 */
import { normalizeScanInput } from "../../box/utils/stickers/stickerScanParse.js";

const TRAY_CODE_RE = /^(FG|RM)\d+$/i;

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
    if (code) return code.toUpperCase();
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const p = JSON.parse(trimmed);
      if (/^\d+$/.test(String(p?.id ?? "").trim())) return String(p.id).trim();
      if (/^\d+$/.test(String(p?.tray_id ?? "").trim())) return String(p.tray_id).trim();
      if (p?.code != null && String(p.code).trim() !== "") return String(p.code).trim().toUpperCase();
    } catch {
      /* continue */
    }
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("://")) return "";

  const upper = trimmed.toUpperCase();
  if (TRAY_CODE_RE.test(upper)) return upper;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return "";
}
