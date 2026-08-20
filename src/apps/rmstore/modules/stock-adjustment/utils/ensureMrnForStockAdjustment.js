import { findMrnByUid, insertMrn, syncMrnHeatFromLot } from "../../mrn/models/mrn.model.js";
import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { mapErpMrnRecord } from "../../mrn/controllers/mrn.controller.js";

function serialFromUid(uid) {
  const parts = String(uid || "").trim().split("_");
  const tail = parts[parts.length - 1];
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

function resolveAdjustmentLotNo(adjustment) {
  return (
    (adjustment?.it_lot_no != null && String(adjustment.it_lot_no).trim()) ||
    (adjustment?.heat_no != null && String(adjustment.heat_no).trim()) ||
    null
  );
}

function buildMrnPayloadFromAdjustment(adjustment, userName) {
  const uid = String(adjustment?.mrn_uid || "").trim();
  if (!uid) return null;

  const serialRaw = adjustment?.serial_no ?? serialFromUid(uid);
  const lotNo = resolveAdjustmentLotNo(adjustment);

  return {
    uid,
    mrn_no: adjustment?.mrn_no ?? null,
    serial_no: serialRaw ?? null,
    mrn_dt: adjustment?.mrn_dt ?? null,
    bill_no: adjustment?.bill_no ?? null,
    bill_dt: adjustment?.bill_dt ?? null,
    acc_code: adjustment?.acc_code ?? null,
    acc_name: adjustment?.acc_name ?? null,
    item_dcode: adjustment?.item_dcode ?? null,
    item_code: adjustment?.item_code ?? null,
    item_desc: adjustment?.item_desc ?? null,
    heat_no: lotNo,
    it_recp_qty: adjustment?.qty ?? null,
    it_lot_no: lotNo,
    it_unit: adjustment?.unit || "KG",
    system_generate_user: userName ?? null,
    system_generate_date: new Date(),
    sticker_generated: false,
  };
}

async function fetchErpMrnByUid(uid) {
  const erpRecords = await fetchFromIMS("mrn_rm");
  return (erpRecords || []).map(mapErpMrnRecord).find((r) => String(r.uid) === String(uid)) ?? null;
}

/**
 * Stock Adjustment Add coils FK to rmstore_mrn(uid). ERP-only MRNs may not exist locally yet —
 * create a stub row from the adjustment (or ERP) before inserting coils.
 */
export async function ensureMrnForStockAdjustment(adjustment, userName) {
  const uid = String(adjustment?.mrn_uid || "").trim();
  if (!uid) {
    const err = new Error("An Add adjustment requires an MRN UID before approval.");
    err.statusCode = 400;
    throw err;
  }

  const existing = await findMrnByUid(uid);
  if (existing) {
    const heat = resolveAdjustmentLotNo(adjustment) ?? existing.heat_no ?? existing.it_lot_no ?? null;
    if (heat && !String(existing.heat_no || "").trim()) {
      const synced = await syncMrnHeatFromLot(uid, heat);
      if (synced) return synced;
    }
    return existing;
  }

  let source = buildMrnPayloadFromAdjustment(adjustment, userName);
  if (!source?.mrn_no && !source?.item_dcode) {
    const erpHit = await fetchErpMrnByUid(uid);
    if (erpHit) {
      source = {
        ...source,
        ...erpHit,
        uid,
        system_generate_user: userName ?? null,
        system_generate_date: new Date(),
        sticker_generated: false,
      };
    }
  }

  if (!source?.mrn_no && !source?.item_dcode) {
    const err = new Error(
      "Could not resolve the MRN in the local store. Reload the MRN on the adjustment and try again."
    );
    err.statusCode = 400;
    throw err;
  }

  try {
    return await insertMrn(source);
  } catch (err) {
    if (err?.code === "23505") {
      const raced = await findMrnByUid(uid);
      if (raced) return raced;
    }
    throw err;
  }
}
