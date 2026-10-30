export function equalUidLists(left = [], right = []) {
  const norm = (arr) => [...(arr || [])].map((u) => String(u).trim()).filter(Boolean).sort();
  const a = norm(left);
  const b = norm(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export {
  normalizeBoxNoUidPrefix,
  saTag,
  qcTag,
  parseStickerBoxIndex,
  parseStandardBoxNoUid,
  docNoFromStandardBoxNoUid,
} from "../../../platform/utils/sticker/stickerUidFormat.js";
