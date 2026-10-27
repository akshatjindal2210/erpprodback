import { getAppConfigValue, APP_CONFIG_KEYS } from "../../../configuration/models/appConfig.model.js";

/** Append query params to `box_qr_public_base_url`, or return plainFallback. */
export async function withPublicBase(params, plainFallback = "") {
  const plain = String(plainFallback ?? "").trim();
  try {
    let base = String((await getAppConfigValue(APP_CONFIG_KEYS.BOX_QR_PUBLIC_BASE_URL)) ?? "").trim();
    if (!base || !/^https?:\/\//i.test(base)) return plain;

    base = base.replace(/[?&]+$/, "").replace(/\/+$/, "");
    new URL(base);

    const search = new URLSearchParams();
    for (const [key, raw] of Object.entries(params || {})) {
      const val = raw != null ? String(raw).trim() : "";
      if (val) search.set(key, val);
    }
    if (![...search.keys()].length) return plain;

    const url = `${base}${base.includes("?") ? "&" : "?"}${search.toString()}`;
    new URL(url);
    return url;
  } catch {
    return plain;
  }
}

/** IMS sticker → `?box_no_uid=…&id=…` */
export async function resolveStickerQrPayload(sticker = {}) {
  const boxNoUid = String(sticker?.box_no_uid || "").trim();
  const uidNum = Number(sticker?.box_uid);
  const boxUid = Number.isFinite(uidNum) && uidNum > 0 ? String(uidNum) : "";
  const plain = boxNoUid || boxUid;
  if (!plain) return "";
  return withPublicBase(
    {
      ...(boxNoUid ? { box_no_uid: boxNoUid } : {}),
      ...(boxUid ? { id: boxUid } : {}),
    },
    plain
  );
}

/** Forwarding note → `?fuid=…` */
export async function resolveForwardingNoteQrPayload(note = {}) {
  const fuid = String(note?.fuid ?? "").trim();
  if (!fuid) return "";
  return withPublicBase({ fuid }, fuid);
}

/** RM coil sticker → `?coil_no_uid=…` */
export async function resolveRmCoilQrPayload(row = {}) {
  const uid = String(row?.coil_no_uid || row?.box_no_uid || row?.coil_uid || "").trim();
  if (!uid) return "";
  return withPublicBase({ coil_no_uid: uid }, uid);
}

/** RM QC sticker → `?qc=…` (uid). Legacy plain form was `QC|{uid}`. */
export async function resolveRmQcQrPayload(row = {}) {
  const uid = String(row?.coil_no_uid || row?.box_no_uid || row?.coil_uid || "").trim();
  if (!uid) return "";
  return withPublicBase({ qc: uid }, `QC|${uid}`);
}

/** Engineering machine → `?machine_no=…` (public URL) or plain machine number. */
export async function resolveMachineQrPayload(row = {}) {
  const number = String(row?.number || row?.machine_no || "").trim();
  if (!number) return "";
  return withPublicBase({ machine_no: number }, number);
}

/** IMS tray label → `?tray_code=…&id=…` (public URL) or plain tray code / id. */
export async function resolveTrayQrPayload(row = {}) {
  const code = String(row?.code || row?.tray_code || "").trim().toUpperCase();
  const idNum = Number(row?.id ?? row?.tray_id);
  const id = Number.isFinite(idNum) && idNum > 0 ? String(idNum) : "";
  const plain = code || id;
  if (!plain) return "";
  return withPublicBase(
    {
      ...(code ? { tray_code: code } : {}),
      ...(id ? { id } : {}),
    },
    code || id
  );
}
