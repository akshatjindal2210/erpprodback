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
  if (parts.length >= 5 && /^[A-Za-z]{1,8}$/.test(parts[0]) && /^\d{2,4}$/.test(parts[1])) return 2;
  if (parts.length >= 4 && /^\d{2,4}$/.test(parts[0])) return 1;
  return 0;
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
