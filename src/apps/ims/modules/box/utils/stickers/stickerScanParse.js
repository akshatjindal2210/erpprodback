/**
 * Sticker / QR scan parsing — keep aligned with frontend qrScan.js (Inward, Out, Override).
 */

export function normalizeScanInput(rawValue) {
  return String(rawValue ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)[0]
    .trim();
}

function readBoxParamsFromUrl(url) {
  const noParam = url.searchParams.get("box_no_uid");
  const idParam = url.searchParams.get("id");
  let box_no_uid = "";
  let box_uid = "";

  if (noParam != null && String(noParam).trim() !== "") {
    box_no_uid = String(noParam).trim();
  }
  if (idParam != null && String(idParam).trim() !== "") {
    const id = String(idParam).trim();
    if (/^\d+$/.test(id)) box_uid = id;
    else if (!box_no_uid) box_no_uid = id;
  }
  if (!box_uid) {
    const uidParam = url.searchParams.get("box_uid");
    if (uidParam != null && /^\d+$/.test(String(uidParam).trim())) {
      box_uid = String(uidParam).trim();
    }
  }

  return { box_no_uid, box_uid };
}

function parseUrlStickerScan(trimmed) {
  const attempts = [trimmed];
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/[?&](box_no_uid|id|box_uid)=/i.test(trimmed) || trimmed.includes("://")) {
      attempts.push(`https://${trimmed.replace(/^\/+/, "")}`);
    }
  }

  for (const candidate of attempts) {
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      const u = new URL(candidate);
      const { box_no_uid, box_uid } = readBoxParamsFromUrl(u);
      if (box_no_uid || box_uid) {
        return {
          box_no_uid: box_no_uid.trim(),
          box_uid: /^\d+$/.test(String(box_uid).trim()) ? String(box_uid).trim() : "",
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** @returns {{ box_no_uid: string, box_uid: string }} */
export function parseStickerScan(rawValue) {
  const trimmed = normalizeScanInput(rawValue);
  let box_no_uid = "";
  let box_uid = "";

  if (!trimmed) {
    return { box_no_uid: "", box_uid: "" };
  }

  const fromUrl = parseUrlStickerScan(trimmed);
  if (fromUrl) return fromUrl;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.location_id != null && parsed?.box_uid == null && parsed?.box_no_uid == null) {
        return { box_no_uid: "", box_uid: "" };
      }
      if (parsed?.box_no_uid != null && String(parsed.box_no_uid).trim() !== "") {
        box_no_uid = String(parsed.box_no_uid).trim();
      }
      if (parsed?.box_uid != null && String(parsed.box_uid).trim() !== "") {
        box_uid = String(parsed.box_uid).trim();
      }
    } catch {
      /* continue */
    }
  }

  if (!box_no_uid) {
    const noMatch = trimmed.match(/[?&]box_no_uid=([^&#\s]+)/i) || trimmed.match(/\bbox_no_uid\s*[:=-]?\s*([A-Za-z0-9_-]+)\b/i);
    if (noMatch?.[1]) {
      try {
        box_no_uid = decodeURIComponent(noMatch[1].replace(/\+/g, " ")).trim();
      } catch {
        box_no_uid = noMatch[1].trim();
      }
    }
  }
  if (!box_uid) {
    const idMatch = trimmed.match(/[?&]id=(\d+)/i) || trimmed.match(/\bbox_uid\s*[:=-]?\s*(\d+)\b/i);
    if (idMatch?.[1]) box_uid = idMatch[1].trim();
  }

  if (!box_no_uid && !box_uid) {
    const legacy = trimmed.match(/\b(?:box_uid|box_no_uid|uid|box(?:\s*id)?)\s*[:=-]?\s*([A-Za-z0-9_-]+)\b/i);
    if (legacy?.[1]) {
      const val = legacy[1].trim();
      if (/^\d+$/.test(val)) box_uid = val;
      else box_no_uid = val;
    } else if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes("?")) {
      if (/^\d+$/.test(trimmed)) box_uid = trimmed;
      else box_no_uid = trimmed;
    }
  }

  return {
    box_no_uid: box_no_uid.trim(),
    box_uid: /^\d+$/.test(String(box_uid).trim()) ? String(box_uid).trim() : "",
  };
}

/** All DB lookup keys for one raw scan (raw + parsed ids). */
export function expandStickerScanLookupCodes(rawValue) {
  const trimmed = normalizeScanInput(rawValue);
  const parsed = parseStickerScan(trimmed);
  const codes = new Set();
  if (trimmed) codes.add(trimmed);
  if (parsed.box_no_uid) codes.add(parsed.box_no_uid);
  if (parsed.box_uid) codes.add(parsed.box_uid);
  return [...codes];
}

/** Preferred lookup key for batch scan (`box_no_uid` first). */
export function primaryStickerScanCode(rawValue) {
  const { box_no_uid, box_uid } = parseStickerScan(rawValue);
  return box_no_uid || box_uid || normalizeScanInput(rawValue);
}
