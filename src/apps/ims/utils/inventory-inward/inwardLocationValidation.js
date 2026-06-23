import dbQuery from "../../../../config/db.js";
import { isInwardLocationValidationEnabled } from "../../../core/models/appConfig.model.js";
import { effectiveBoxCustomerAcc } from "../box/boxCustomerOverride.js";
import { sqlBoxInHand } from "../box/boxInventorySql.js";

export { isInwardLocationValidationEnabled };

/** Same normalization as location suggestion (integers / numeric strings compare as tier keys). */
function normCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
  }
  return s;
}

function effectiveBoxCustomer(override_cust, prod_acc_code) {
  return effectiveBoxCustomerAcc(override_cust, prod_acc_code);
}

function effectiveBoxItem(itemdcode) {
  return normCode(itemdcode);
}

function locationHasAcc(loc) {
  return loc?.acc_code != null && String(loc.acc_code).trim() !== "";
}

function locationHasItem(loc) {
  return loc?.item_dcode != null && String(loc.item_dcode).trim() !== "";
}

/**
 * When `inward_location_validation` is true (see inventoryInward controller):
 * - Location has customer → only that customer's boxes; any item of that customer is OK.
 * - Location has item only (no customer) → only boxes with that item.
 * - Open location (no customer, no item) → only boxes with no customer/item on record.
 * When false → this function is not called; any box may go to any location.
 */
/*
function boxAllowedAtLocation(locAcc, locItem, boxAcc, boxItem) {
  const hasAcc = locAcc != null;
  const hasItem = locItem != null;
  if (!hasAcc && !hasItem) return boxAcc == null && boxItem == null;
  if (hasAcc) return boxAcc === locAcc;
  if (hasItem) return boxItem === locItem;
  return true;
}
*/
function boxAllowedAtLocation(locAcc, locItem, boxAcc, boxItem) {
  const hasAcc = locAcc != null;
  const hasItem = locItem != null;

  // Open location → any box allowed
  if (!hasAcc && !hasItem) return true;

  // Location has customer → only that customer (any item)
  if (hasAcc) return boxAcc === locAcc;

  // Location has item only → any box with matching item, regardless of customer
  if (hasItem) return boxItem === locItem;

  return true;
}

async function loadLocationsByIds(locationIds) {
  const ids = [...new Set(locationIds.map((id) => parseInt(String(id), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const rows = await dbQuery(
    `SELECT location_id, acc_code, item_dcode,
            COALESCE(location_no, CONCAT(rack_no, UPPER(COALESCE(shelf_no, '')))) AS display_no
     FROM ims_location_master
     WHERE is_deleted = false AND location_id = ANY($1::int[])`,
    [ids]
  );
  const map = new Map();
  for (const r of rows || []) {
    map.set(Number(r.location_id), r);
  }
  return map;
}

async function loadBoxesByNoUid(boxNoUids) {
  const uids = [...new Set((boxNoUids || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return new Map();
  const rows = await dbQuery(
    `SELECT b.box_no_uid,
            b.override_cust,
            j.acc_code AS prod_acc_code,
            j.item_dcode AS itemdcode
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod j ON b.packing_number::text = j.doc_no::text
     WHERE ${sqlBoxInHand("b")}
       AND b.box_no_uid::text = ANY($1::text[])`,
    [uids]
  );
  const map = new Map();
  for (const r of rows || []) {
    map.set(String(r.box_no_uid).trim(), r);
  }
  return map;
}

/**
 * @param {Array<{ location_id: unknown, boxes?: unknown[] }>} locations
 * @returns {Promise<string|null>} Error message or null if OK
 */
export async function validateInwardLocationsAgainstBoxes(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return null;

  const locIds = [];
  const allBoxUids = [];
  for (const loc of locations) {
    if (loc?.location_id != null) locIds.push(loc.location_id);
    const boxes = loc?.boxes;
    if (!Array.isArray(boxes)) continue;
    for (const b of boxes) {
      const uid = b == null ? "" : typeof b === "string" || typeof b === "number" ? String(b).trim() : String(b.box_no_uid ?? b.boxNoUid ?? "").trim();
      if (uid) allBoxUids.push(uid);
    }
  }

  const locMap = await loadLocationsByIds(locIds);
  const boxMap = await loadBoxesByNoUid(allBoxUids);

  for (const loc of locations) {
    const lid = parseInt(String(loc?.location_id), 10);
    if (!Number.isFinite(lid) || lid <= 0) continue;

    const lm = locMap.get(lid);
    if (!lm) {
      return `Location id ${lid} not found or inactive.`;
    }

    const locAcc = locationHasAcc(lm) ? normCode(lm.acc_code) : null;
    const locItem = locationHasItem(lm) ? normCode(lm.item_dcode) : null;

    const boxes = Array.isArray(loc.boxes) ? loc.boxes : [];
    for (const b of boxes) {
      const uid =
        b == null
          ? ""
          : typeof b === "string" || typeof b === "number"
            ? String(b).trim()
            : String(b.box_no_uid ?? b.boxNoUid ?? "").trim();
      if (!uid) continue;

      const row = boxMap.get(uid);
      if (!row) {
        return `Box "${uid}" is not eligible for inward (outward or removed via stock adjustment).`;
      }

      const boxAcc = effectiveBoxCustomer(row.override_cust, row.prod_acc_code);
      const boxItem = effectiveBoxItem(row.itemdcode);

      if (!boxAllowedAtLocation(locAcc, locItem, boxAcc, boxItem)) {
        const locLabel = lm.display_no || `id ${lid}`;
        // console.log(locOpen && (boxAcc != null || boxItem != null));
        // }
        if (locAcc != null && boxAcc !== locAcc) {
          return `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to another customer, mixed stock is not allowed.`;
        }
        if (locItem != null && boxItem !== locItem) {
          return `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to item ${locItem} only.`;
        }
        return `Box "${uid}" cannot be placed at location "${locLabel}".`;
      }
    }
  }

  return null;
}

/**
 * Single box vs location (same rules as full inward save).
 * @returns {Promise<{ allowed: boolean, message: string|null }>}
 */
export async function validateSingleBoxAtLocation(location_id, box_no_uid) {
  const err = await validateInwardLocationsAgainstBoxes([{ location_id, boxes: [box_no_uid] }]);
  return err ? { allowed: false, message: err } : { allowed: true, message: null };
}

function validateOneBoxAtLoadedLocation(lm, locAcc, locItem, uid, row) {
  const lid = lm ? Number(lm.location_id) : null;
  if (!lm) {
    return { box_no_uid: uid, allowed: false, message: `Location id ${lid} not found or inactive.` };
  }
  if (!row) {
    return {
      box_no_uid: uid,
      allowed: false,
      message: `Box "${uid}" is not eligible for inward (outward or removed via stock adjustment).`,
    };
  }

  const boxAcc = effectiveBoxCustomer(row.override_cust, row.prod_acc_code);
  const boxItem = effectiveBoxItem(row.itemdcode);

  if (boxAllowedAtLocation(locAcc, locItem, boxAcc, boxItem)) {
    return { box_no_uid: uid, allowed: true, message: null };
  }

  const locLabel = lm.display_no || `id ${lid}`;
  if (locAcc != null && boxAcc !== locAcc) {
    return {
      box_no_uid: uid,
      allowed: false,
      message: `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to another customer, mixed stock is not allowed.`,
    };
  }
  if (locItem != null && boxItem !== locItem) {
    return {
      box_no_uid: uid,
      allowed: false,
      message: `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to item ${locItem} only.`,
    };
  }
  return { box_no_uid: uid, allowed: false, message: `Box "${uid}" cannot be placed at location "${locLabel}".` };
}

/**
 * Batch box vs location validation (same rules as save / single scan).
 * @returns {Promise<{ validation_enabled: boolean, results: Array<{ box_no_uid: string, allowed: boolean, message: string|null }> }>}
 */
export async function validateBoxesAtLocationBatch(location_id, box_no_uids) {
  const uids = [...new Set((box_no_uids || []).map((u) => String(u).trim()).filter(Boolean))];
  const validation_enabled = await isInwardLocationValidationEnabled();

  if (!uids.length) {
    return { validation_enabled, results: [] };
  }

  if (!validation_enabled) {
    return {
      validation_enabled: false,
      results: uids.map((box_no_uid) => ({ box_no_uid, allowed: true, message: null })),
    };
  }

  const lid = parseInt(String(location_id), 10);
  const locMap = await loadLocationsByIds([lid]);
  const lm = locMap.get(lid);
  const locAcc = lm && locationHasAcc(lm) ? normCode(lm.acc_code) : null;
  const locItem = lm && locationHasItem(lm) ? normCode(lm.item_dcode) : null;
  const boxMap = await loadBoxesByNoUid(uids);

  return {
    validation_enabled: true,
    results: uids.map((uid) => validateOneBoxAtLoadedLocation(lm, locAcc, locItem, uid, boxMap.get(uid))),
  };
}
