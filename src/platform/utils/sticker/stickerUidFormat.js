/**
 * ★ Sticker UID — change ONLY THIS FILE ★
 * Peer: frontend/src/platform/utils/global/stickerUidFormat.js
 *
 * code + year → FG_26 / RM_26
 * ims: FG_26_40276_10_1 | SA | QCH
 * rmstore: RM_26_1001_3_10_1 | SA
 */

export const STICKER_BY_APP = {
  ims: { code: "FG", SA: "SA", QCH: "QCH" },
  rmstore: { code: "RM", SA: "SA" },
  task: { code: "" },
};

export function normalizeBoxNoUidPrefix(raw) {
  const s = String(raw ?? "").trim();
  if (/^[A-Za-z0-9]{1,8}$/.test(s)) return s;
  if (/^[A-Za-z]{1,8}_\d{2,4}$/.test(s)) return s;
  return "";
}

/** "26" → "fg_26" / "rm_26" */
export function resolveStickerPrefix(app, year = "") {
  const y = String(year ?? "").trim();
  if (!y) return "";
  const c = STICKER_BY_APP[app]?.code;
  if (!c) return normalizeBoxNoUidPrefix(y);
  if (y.includes("_")) return normalizeBoxNoUidPrefix(y) || y;
  return c + "_" + y;
}

function join(prefix, core) {
  const p = normalizeBoxNoUidPrefix(prefix) || String(prefix ?? "").trim();
  return p ? p + "_" + core : core;
}

export function formatStandardBoxNoUid(docNo, totalBoxes, boxIndex, prefix = "") {
  const doc = String(docNo ?? "").trim();
  const tb = parseInt(String(totalBoxes), 10);
  const bi = parseInt(String(boxIndex), 10);
  if (!doc || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  return join(resolveStickerPrefix("ims", prefix), doc + "_" + tb + "_" + bi);
}

export function formatSaBoxNoUid(packingNo, adjId, total, box, prefix = "") {
  const pn = String(packingNo ?? "").trim();
  const tok = adjId === "?" || adjId === "preview" ? "?" : String(adjId);
  const tb = parseInt(String(total), 10);
  const bi = parseInt(String(box), 10);
  if (!pn || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  return join(resolveStickerPrefix("ims", prefix), pn + "_" + STICKER_BY_APP.ims.SA + tok + "_" + tb + "_" + bi);
}

export function formatQcBoxNoUid(packingNo, holdId, subId, total, box, prefix = "") {
  const pn = String(packingNo ?? "").trim();
  const hid = parseInt(String(holdId), 10);
  const sid = parseInt(String(subId), 10);
  const tb = parseInt(String(total), 10);
  const bi = parseInt(String(box), 10);
  if (!pn || !Number.isFinite(hid) || hid < 1 || !Number.isFinite(tb) || tb < 1 || !Number.isFinite(bi) || bi < 1) return "";
  const m = STICKER_BY_APP.ims.QCH;
  const core = Number.isFinite(sid) && sid > 0 ? pn + "_" + m + hid + "_" + sid + "_" + tb + "_" + bi : pn + "_" + m + hid + "_" + tb + "_" + bi;
  return join(resolveStickerPrefix("ims", prefix), core);
}

export function formatCoilNoUid({ prefix, mrn_no, serial_no, total, index }) {
  const p = resolveStickerPrefix("rmstore", prefix) || "0";
  const mrn = String(mrn_no ?? "").trim() || "0";
  const serial = String(serial_no ?? "").trim() || "0";
  return p + "_" + mrn + "_" + serial + "_" + Math.max(1, Number(total) || 1) + "_" + Math.max(1, Number(index) || 1);
}

export function formatStockAdjustmentCoilUid({ prefix, mrn_no, serial_no, adjustment_id, total, index }) {
  const p = resolveStickerPrefix("rmstore", prefix) || "0";
  const mrn = String(mrn_no ?? "").trim() || "0";
  const serial = String(serial_no ?? "").trim() || "0";
  return (
    p +
    "_" +
    mrn +
    "_" +
    serial +
    "_" +
    STICKER_BY_APP.rmstore.SA +
    Math.max(0, Number(adjustment_id) || 0) +
    "_" +
    Math.max(1, Number(total) || 1) +
    "_" +
    Math.max(1, Number(index) || 1)
  );
}

export function saTag(adjId) {
  const id = parseInt(String(adjId), 10);
  return Number.isFinite(id) && id > 0 ? "_" + STICKER_BY_APP.ims.SA + id + "_" : "";
}

export function qcTag(holdId) {
  const id = parseInt(String(holdId), 10);
  return Number.isFinite(id) && id > 0 ? "_" + STICKER_BY_APP.ims.QCH + id + "_" : "";
}

export function parseStickerBoxIndex(boxNoUid) {
  const last = parseInt(String(boxNoUid ?? "").trim().split("_").pop(), 10);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

function prefixOffset(parts) {
  // APP + year (FG_26_… / RM_26_…) — 4+ parts covers MRN uid RM_26_4111_1 and coil RM_26_4111_1_10_1
  if (parts.length >= 4 && /^[A-Za-z]{1,8}$/.test(parts[0]) && /^\d{2,4}$/.test(parts[1])) return 2;
  if (parts.length >= 4 && /^\d{2,4}$/.test(parts[0])) return 1;
  return 0;
}

function stickerUidEndsWithCore(full, core) {
  const a = String(full ?? "").trim().toLowerCase();
  const b = String(core ?? "").trim().toLowerCase();
  if (!a || !b || a === b) return a === b;
  return a.length > b.length && a.endsWith("_" + b);
}

/** Underscore segments for any sticker UID (coil, box, MRN uid, etc.). */
export function splitStickerUidParts(uid) {
  return String(uid ?? "").trim().split("_").filter(Boolean);
}

/**
 * Match/compare key with app+year prefix stripped (same rules as formatCoilNoUid / prefixOffset).
 * RM_26_4111_1_10_1 → 4111_1_10_1 · 4111_1 → 4111_1 · 26_4111_1_10_1 → 4111_1_10_1
 */
export function stickerUidCoreKey(uid) {
  const parts = splitStickerUidParts(uid);
  if (!parts.length) return "";
  return parts.slice(prefixOffset(parts)).join("_").toLowerCase();
}

/**
 * True when two UIDs match:
 * - exact / case-insensitive
 * - same core after stripping APP+year (stickerUidCoreKey)
 * - IMS-style underscore suffix (`4111_1_10_1` ↔ `RM_26_4111_1_10_1`)
 */
export function stickerUidsMatch(a, b) {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  if (left.toLowerCase() === right.toLowerCase()) return true;
  const leftKey = stickerUidCoreKey(left);
  const rightKey = stickerUidCoreKey(right);
  if (leftKey && rightKey && leftKey === rightKey) return true;
  return stickerUidEndsWithCore(left, right) || stickerUidEndsWithCore(right, left);
}

/** Printed sticker UID (uses STICKER_BY_APP codes — do not hardcode FG_/RM_). */
export function looksLikeStickerUid(uid) {
  const raw = String(uid ?? "").trim();
  if (!raw) return false;
  const parts = splitStickerUidParts(raw);
  if (parts.length < 3) return false;
  const codes = new Set(
    Object.values(STICKER_BY_APP)
      .map((app) => String(app?.code || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (codes.has(String(parts[0]).toLowerCase()) && /^\d{2,4}$/.test(parts[1])) return true;
  if (prefixOffset(parts) > 0) return true;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return /^\d+$/.test(last) && /^\d+$/.test(prev);
}

/**
 * SQL predicate matching IMS box_no_uid lookup:
 * exact, case-insensitive, or stored/scan is an underscore-suffix of the other.
 */
export function sqlStickerUidEquals(columnSql, paramSql = "$1") {
  const col = `trim(${columnSql}::text)`;
  const p = `trim(${paramSql}::text)`;
  return `(
    ${col} = ${p}
    OR lower(${col}) = lower(${p})
    OR (length(${col}) > length(${p}) AND right(${col}, length(${p}) + 1) = ('_' || ${p}))
    OR (length(${p}) > length(${col}) AND right(${p}, length(${col}) + 1) = ('_' || ${col}))
  )`;
}

/** Resolve scanned/typed UID to a known coil_no_uid from a list (exact, core, or suffix). */
export function findMatchingCoilNoUid(scanned, coilUids = []) {
  const raw = String(scanned ?? "").trim();
  if (!raw || !Array.isArray(coilUids) || !coilUids.length) return null;
  const exact = coilUids.find((uid) => String(uid ?? "").trim().toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  return coilUids.find((uid) => stickerUidsMatch(uid, raw)) || null;
}

export function parseStandardBoxNoUid(boxNoUid) {
  const parts = String(boxNoUid ?? "").trim().split("_").filter(Boolean);
  if (parts.length < 3) return null;
  const offset = prefixOffset(parts);
  if (parts.length - offset < 3) return null;
  const docNo = parts[offset];
  const totalBoxes = parseInt(parts[offset + 1], 10);
  const boxIndex = parseInt(parts[offset + 2], 10);
  if (!docNo || !Number.isFinite(totalBoxes) || !Number.isFinite(boxIndex)) return null;
  return { prefix: offset ? parts.slice(0, offset).join("_") : "", docNo, totalBoxes, boxIndex };
}

const LEAD = "(?:(?:[A-Za-z]+_)?\\d{2,4}_)?";

export function docNoFromStandardBoxNoUid(boxNoUid) {
  const parsed = parseStandardBoxNoUid(boxNoUid);
  if (parsed?.docNo) return parsed.docNo;
  const uid = String(boxNoUid ?? "").trim();
  if (!uid) return null;
  const sa = STICKER_BY_APP.ims.SA;
  const qch = STICKER_BY_APP.ims.QCH;
  return (
    uid.match(new RegExp("^" + LEAD + "([^_]+)_" + sa, "i"))?.[1] ||
    uid.match(new RegExp("^" + LEAD + "([^_]+)_" + qch + "\\d+_", "i"))?.[1] ||
    uid.match(new RegExp("^" + LEAD + "(\\d+)_\\d+_\\d+$", "i"))?.[1] ||
    null
  );
}

export function parseCoilNoUidMeta(coilNoUid) {
  const parts = String(coilNoUid || "").trim().split("_").filter(Boolean);
  if (parts.length < 2) return { index: null, total: null };
  const index = Number(parts[parts.length - 1]);
  const total = Number(parts[parts.length - 2]);
  return { index: Number.isFinite(index) ? index : null, total: Number.isFinite(total) ? total : null };
}

export function resolveSerialNoForUid({ serial_no, mrn_uid, uid } = {}) {
  const parts = String(mrn_uid || uid || "").trim().split("_").filter(Boolean);
  if (parts.length >= 4 && /^[A-Za-z]{1,8}$/.test(parts[0]) && /^\d{2,4}$/.test(parts[1])) return parts[3];
  if (parts.length >= 3) return parts[2];
  if (serial_no != null && String(serial_no).trim() !== "") return String(serial_no).trim();
  return "0";
}
