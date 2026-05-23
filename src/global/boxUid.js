export const BOX_NO_UID_PREFIX_FALLBACK = "2026";

export function normalizeBoxNoUidPrefix(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!/^[A-Za-z0-9]{1,8}$/.test(s)) return "";
  return s;
}

export function formatStandardBoxNoUid(docNo, totalBoxes, boxIndex, prefix = "") {
  const doc = String(docNo ?? "").trim();
  const tb = parseInt(String(totalBoxes), 10);
  const bi = parseInt(String(boxIndex), 10);
  if (!doc || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  const core = `${doc}_${tb}_${bi}`;
  const pfx = normalizeBoxNoUidPrefix(prefix);
  return pfx ? `${pfx}_${core}` : core;
}

function isYearLikePrefix(seg) {
  return /^\d{2,4}$/.test(String(seg ?? "").trim());
}

export function parseStandardBoxNoUid(boxNoUid, configuredPrefix = "") {
  const parts = String(boxNoUid ?? "")
    .trim()
    .split("_")
    .filter(Boolean);
  if (parts.length < 3) return null;

  const cfg = normalizeBoxNoUidPrefix(configuredPrefix);
  let offset = 0;

  if (cfg && parts[0] === cfg) {
    offset = 1;
  } else if (parts.length >= 4 && isYearLikePrefix(parts[0])) {
    offset = 1;
  }

  if (parts.length - offset < 3) return null;

  const docNo = parts[offset];
  const totalBoxes = parseInt(parts[offset + 1], 10);
  const boxIndex = parseInt(parts[offset + 2], 10);
  if (!docNo || !Number.isFinite(totalBoxes) || !Number.isFinite(boxIndex)) return null;

  return {
    prefix: offset > 0 ? parts[0] : "",
    docNo,
    totalBoxes,
    boxIndex,
  };
}

export function docNoFromStandardBoxNoUid(boxNoUid, configuredPrefix = "") {
  const parsed = parseStandardBoxNoUid(boxNoUid, configuredPrefix);
  if (parsed?.docNo) return parsed.docNo;

  const uid = String(boxNoUid ?? "").trim();
  if (!uid) return null;

  const saMatch = uid.match(/^(?:\d{2,4}_)?([^_]+)_SA/i);
  if (saMatch?.[1]) return saMatch[1];

  const standardMatch = uid.match(/^(?:\d{2,4}_)?(\d+)_\d+_\d+$/);
  if (standardMatch?.[1]) return standardMatch[1];

  return null;
}
