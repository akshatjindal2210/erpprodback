import dbQuery from "../../../../../../config/db/db.js";
import {
  isInwardLocationValidationEnabled,
  isLocationCapacityValidationEnabled,
} from "../../../../../core/configuration/models/appConfig.model.js";
import { effectiveBoxCustomerAcc } from "../../../box/utils/override-customer/boxCustomerOverride.js";
import { sqlBoxInHand } from "../../../box/utils/inventory/boxInventorySql.js";
import { LOCATION_APP_TYPE_IMS } from "../../../location/models/locationMaster.model.js";

export { isInwardLocationValidationEnabled, isLocationCapacityValidationEnabled };

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

function locationAccSet(loc) {
  const arr =
    Array.isArray(loc?.acc_codes) && loc.acc_codes.length
      ? loc.acc_codes
      : loc?.acc_code != null
        ? [loc.acc_code]
        : [];
  return new Set(arr.map(normCode).filter(Boolean));
}

function locationItemSet(loc) {
  const arr =
    Array.isArray(loc?.item_dcodes) && loc.item_dcodes.length
      ? loc.item_dcodes
      : loc?.item_dcode != null
        ? [loc.item_dcode]
        : [];
  return new Set(arr.map(normCode).filter(Boolean));
}

function locationRule(loc) {
  // Include/exclude applies only when location has item(s); customer-only = include allowlist
  const items = locationItemSet(loc);
  if (!items.size) return "include";
  return String(loc?.rule ?? loc?.restriction_mode ?? "include").trim().toLowerCase() === "exclude"
    ? "exclude"
    : "include";
}

/**
 * When `inward_location_validation` is true (IMS locations only):
 * - include + customer/item list → box must match listed values
 * - exclude + customer/item list → box must NOT match listed values
 * - empty lists → open (any box allowed)
 * Customer and item rules both apply when both lists are set.
 *
 * Capacity (`location_capacity_validation`) is separate: occupied + incoming ≤ total_capacity
 * when total_capacity > 0.
 */
function boxAllowedAtLocation(locAccs, locItems, boxAcc, boxItem, mode = "include") {
  const hasAcc = locAccs.size > 0;
  const hasItem = locItems.size > 0;

  if (!hasAcc && !hasItem) return true;

  const isExclude = mode === "exclude";

  if (hasAcc) {
    const accOk = boxAcc != null && locAccs.has(boxAcc);
    if (isExclude ? accOk : !accOk) return false;
  }

  if (hasItem) {
    const itemOk = boxItem != null && locItems.has(boxItem);
    if (isExclude ? itemOk : !itemOk) return false;
  }

  return true;
}

function denyMessage(uid, locLabel, locAccs, locItems, boxAcc, boxItem, mode) {
  const isExclude = mode === "exclude";

  if (locAccs.size > 0) {
    const accHit = boxAcc != null && locAccs.has(boxAcc);
    if (isExclude ? accHit : !accHit) {
      return isExclude
        ? `Box "${uid}" cannot be placed at location "${locLabel}": this customer is excluded from this location.`
        : `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to another customer, mixed stock is not allowed.`;
    }
  }

  if (locItems.size > 0) {
    const itemHit = boxItem != null && locItems.has(boxItem);
    if (isExclude ? itemHit : !itemHit) {
      return isExclude
        ? `Box "${uid}" cannot be placed at location "${locLabel}": this item is excluded from this location.`
        : `Box "${uid}" cannot be placed at location "${locLabel}": this location is assigned to specific item(s) only.`;
    }
  }

  return `Box "${uid}" cannot be placed at location "${locLabel}".`;
}

async function loadLocationsByIds(locationIds) {
  const ids = [...new Set(locationIds.map((id) => parseInt(String(id), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  // IMS inward places boxes — capacity check counts boxes only (not RM coils).
  const occupiedSql = `COALESCE(
    (
      SELECT COUNT(*)::int
      FROM ims_box_table b
      WHERE b.location_id = lm.location_id
        AND ${sqlBoxInHand("b")}
    ),
    0
  )`;
  const rows = await dbQuery(
    `SELECT lm.location_id,
            COALESCE(lm.acc_codes, '{}') AS acc_codes,
            COALESCE(lm.item_dcodes, '{}') AS item_dcodes,
            (COALESCE(lm.acc_codes, '{}'))[1] AS acc_code,
            (COALESCE(lm.item_dcodes, '{}'))[1] AS item_dcode,
            COALESCE(NULLIF(lower(trim(lm.rule)), ''), 'include') AS rule,
            COALESCE(lm.total_capacity, 0)::int AS total_capacity,
            ${occupiedSql} AS occupied_capacity,
            COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS display_no
     FROM ims_location_master lm
     WHERE lm.is_deleted = false
       AND lower(trim(COALESCE(lm.type, '${LOCATION_APP_TYPE_IMS}'))) = '${LOCATION_APP_TYPE_IMS}'
       AND lm.location_id = ANY($1::int[])`,
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
            b.location_id,
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

function extractBoxUid(b) {
  if (b == null) return "";
  if (typeof b === "string" || typeof b === "number") return String(b).trim();
  return String(b.box_no_uid ?? b.boxNoUid ?? "").trim();
}

/**
 * Capacity: after placing incoming boxes, count must be <= total_capacity.
 * Boxes already on this location do not increase occupancy again.
 */
function capacityErrorForLocation(lm, incomingUids, boxMap) {
  const total = Number(lm?.total_capacity);
  // Enforce only when capacity is configured (> 0); legacy/null rows stay open.
  if (!Number.isFinite(total) || total <= 0) return null;

  const lid = Number(lm.location_id);
  const uniqueIncoming = [...new Set(incomingUids.filter(Boolean))];
  let alreadyHere = 0;
  for (const uid of uniqueIncoming) {
    const row = boxMap.get(uid);
    if (row && Number(row.location_id) === lid) alreadyHere += 1;
  }

  const occupied = Number(lm.occupied_capacity) || 0;
  const projected = occupied - alreadyHere + uniqueIncoming.length;
  if (projected > total) {
    const locLabel = lm.display_no || `id ${lid}`;
    const available = Math.max(total - occupied + alreadyHere, 0);
    return `Location "${locLabel}" capacity exceeded: total ${total}, occupied ${occupied}, available ${available}, trying to place ${uniqueIncoming.length}.`;
  }
  return null;
}

/**
 * @param {Array<{ location_id: unknown, boxes?: unknown[] }>} locations
 * @returns {Promise<string|null>} Error message or null if OK
 */
export async function validateInwardLocationsAgainstBoxes(locations) {
  const checkRules = await isInwardLocationValidationEnabled();
  const checkCapacity = await isLocationCapacityValidationEnabled();
  if (!checkRules && !checkCapacity) return null;
  if (!Array.isArray(locations) || locations.length === 0) return null;

  const locIds = [];
  const allBoxUids = [];
  /** @type {Map<number, string[]>} */
  const boxesByLoc = new Map();

  for (const loc of locations) {
    const lid = parseInt(String(loc?.location_id), 10);
    if (Number.isFinite(lid) && lid > 0) locIds.push(lid);

    const boxes = Array.isArray(loc?.boxes) ? loc.boxes : [];
    const uids = [];
    for (const b of boxes) {
      const uid = extractBoxUid(b);
      if (!uid) continue;
      allBoxUids.push(uid);
      uids.push(uid);
    }
    if (Number.isFinite(lid) && lid > 0 && uids.length) {
      const prev = boxesByLoc.get(lid) || [];
      boxesByLoc.set(lid, prev.concat(uids));
    }
  }

  const locMap = await loadLocationsByIds(locIds);
  const boxMap = await loadBoxesByNoUid(allBoxUids);

  if (checkCapacity) {
    for (const [lid, uids] of boxesByLoc.entries()) {
      const lm = locMap.get(lid);
      if (!lm) {
        return `Location id ${lid} not found or inactive.`;
      }
      const capErr = capacityErrorForLocation(lm, uids, boxMap);
      if (capErr) return capErr;
    }
  }

  if (!checkRules) return null;

  for (const loc of locations) {
    const lid = parseInt(String(loc?.location_id), 10);
    if (!Number.isFinite(lid) || lid <= 0) continue;

    const lm = locMap.get(lid);
    if (!lm) {
      return `Location id ${lid} not found or inactive.`;
    }

    const locAccs = locationAccSet(lm);
    const locItems = locationItemSet(lm);
    const mode = locationRule(lm);

    const boxes = Array.isArray(loc.boxes) ? loc.boxes : [];
    for (const b of boxes) {
      const uid = extractBoxUid(b);
      if (!uid) continue;

      const row = boxMap.get(uid);
      if (!row) {
        return `Box "${uid}" is not eligible for inward (outward or removed via stock adjustment).`;
      }

      const boxAcc = effectiveBoxCustomer(row.override_cust, row.prod_acc_code);
      const boxItem = effectiveBoxItem(row.itemdcode);

      if (!boxAllowedAtLocation(locAccs, locItems, boxAcc, boxItem, mode)) {
        return denyMessage(uid, lm.display_no || `id ${lid}`, locAccs, locItems, boxAcc, boxItem, mode);
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

function validateOneBoxAtLoadedLocation(lm, locAccs, locItems, mode, uid, row, capacityCtx = null, checkRules = true) {
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

  if (capacityCtx) {
    const alreadyHere = Number(row.location_id) === lid;
    const nextOccupied = capacityCtx.occupied + (alreadyHere ? 0 : 1);
    if (nextOccupied > capacityCtx.total) {
      const locLabel = lm.display_no || `id ${lid}`;
      const available = Math.max(capacityCtx.total - capacityCtx.occupied, 0);
      return {
        box_no_uid: uid,
        allowed: false,
        message: `Box "${uid}" cannot be placed at location "${locLabel}": capacity full (total ${capacityCtx.total}, occupied ${capacityCtx.occupied}, available ${available}).`,
      };
    }
  }

  if (checkRules) {
    const boxAcc = effectiveBoxCustomer(row.override_cust, row.prod_acc_code);
    const boxItem = effectiveBoxItem(row.itemdcode);

    if (!boxAllowedAtLocation(locAccs, locItems, boxAcc, boxItem, mode)) {
      return {
        box_no_uid: uid,
        allowed: false,
        message: denyMessage(uid, lm.display_no || `id ${lid}`, locAccs, locItems, boxAcc, boxItem, mode),
      };
    }
  }

  if (capacityCtx && Number(row.location_id) !== lid) {
    capacityCtx.occupied += 1;
  }
  return { box_no_uid: uid, allowed: true, message: null };
}

/**
 * Batch box vs location validation (same rules as save / single scan).
 * @returns {Promise<{ validation_enabled: boolean, results: Array<{ box_no_uid: string, allowed: boolean, message: string|null }> }>}
 */
export async function validateBoxesAtLocationBatch(location_id, box_no_uids) {
  const uids = [...new Set((box_no_uids || []).map((u) => String(u).trim()).filter(Boolean))];
  const checkRules = await isInwardLocationValidationEnabled();
  const checkCapacity = await isLocationCapacityValidationEnabled();
  const validation_enabled = checkRules || checkCapacity;

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
  const locAccs = lm ? locationAccSet(lm) : new Set();
  const locItems = lm ? locationItemSet(lm) : new Set();
  const mode = lm ? locationRule(lm) : "include";
  const boxMap = await loadBoxesByNoUid(uids);
  const totalCap = Number(lm?.total_capacity);
  const capacityCtx =
    checkCapacity && lm && Number.isFinite(totalCap) && totalCap > 0
      ? {
          total: totalCap,
          occupied: Number(lm.occupied_capacity) || 0,
        }
      : null;

  return {
    validation_enabled: true,
    results: uids.map((uid) =>
      validateOneBoxAtLoadedLocation(lm, locAccs, locItems, mode, uid, boxMap.get(uid), capacityCtx, checkRules)
    ),
  };
}
