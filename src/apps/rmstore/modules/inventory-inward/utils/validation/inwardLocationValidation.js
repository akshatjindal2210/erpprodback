import dbQuery from "../../../../../../config/db/db.js";
import { isLocationCapacityValidationEnabled } from "../../../../../core/configuration/models/appConfig.model.js";
import { LOCATION_APP_TYPE_RMSTORE } from "../../../../../ims/modules/location/models/locationMaster.model.js";
import { IMS_TABLES as IT, RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export { isLocationCapacityValidationEnabled };

const LOC = IT.LOCATION_MASTER;
const COIL = T.COIL_TABLE;

async function loadRmLocationsByIds(locationIds) {
  const ids = [...new Set(locationIds.map((id) => parseInt(String(id), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();

  // RM Store In places coils — capacity counts coils only (not IMS boxes).
  const occupiedSql = `COALESCE(
    (
      SELECT COUNT(*)::int
      FROM ${COIL} rc
      WHERE rc.location_id = lm.location_id
        AND rc.is_deleted = false
        AND COALESCE(rc.status, 'active') IN ('active', 'rejected')
    ),
    0
  )`;

  const rows = await dbQuery(
    `SELECT lm.location_id,
            COALESCE(lm.total_capacity, 0)::int AS total_capacity,
            ${occupiedSql} AS occupied_capacity,
            COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS display_no
     FROM ${LOC} lm
     WHERE lm.is_deleted = false
       AND lower(trim(COALESCE(lm.type, ''))) = '${LOCATION_APP_TYPE_RMSTORE}'
       AND lm.location_id = ANY($1::int[])`,
    [ids]
  );

  const map = new Map();
  for (const r of rows || []) {
    map.set(Number(r.location_id), r);
  }
  return map;
}

async function loadCoilsByUid(coilUids) {
  const uids = [...new Set((coilUids || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return new Map();

  const rows = await dbQuery(
    `SELECT coil_no_uid, location_id
     FROM ${COIL}
     WHERE is_deleted = false
       AND coil_no_uid::text = ANY($1::text[])`,
    [uids]
  );

  const map = new Map();
  for (const r of rows || []) {
    map.set(String(r.coil_no_uid).trim(), r);
  }
  return map;
}

/**
 * Capacity: after placing incoming coils, count must be <= total_capacity.
 * Coils already on this location do not increase occupancy again.
 * Only enforced when total_capacity > 0.
 */
function capacityErrorForLocation(lm, incomingUids, coilMap) {
  const total = Number(lm?.total_capacity);
  if (!Number.isFinite(total) || total <= 0) return null;

  const lid = Number(lm.location_id);
  const uniqueIncoming = [...new Set(incomingUids.filter(Boolean))];
  let alreadyHere = 0;
  for (const uid of uniqueIncoming) {
    const row = coilMap.get(uid);
    if (row && Number(row.location_id) === lid) alreadyHere += 1;
  }

  const occupied = Number(lm.occupied_capacity) || 0;
  const projected = occupied - alreadyHere + uniqueIncoming.length;
  if (projected > total) {
    const locLabel = lm.display_no || `id ${lid}`;
    const available = Math.max(total - occupied + alreadyHere, 0);
    return `Location "${locLabel}" capacity exceeded: total ${total}, occupied ${occupied}, available ${available}, trying to place ${uniqueIncoming.length} coil(s).`;
  }
  return null;
}

/**
 * @param {Array<{ location_id: number, coils: string[] }>} locations
 * @returns {Promise<string|null>}
 */
export async function validateRmInwardLocationsAgainstCoils(locations) {
  if (!(await isLocationCapacityValidationEnabled())) return null;
  if (!Array.isArray(locations) || locations.length === 0) return null;

  /** @type {Map<number, string[]>} */
  const coilsByLoc = new Map();
  const allUids = [];

  for (const loc of locations) {
    const lid = parseInt(String(loc?.location_id), 10);
    if (!Number.isFinite(lid) || lid <= 0) continue;
    const uids = [...new Set((loc.coils || []).map((u) => String(u).trim()).filter(Boolean))];
    if (!uids.length) continue;
    const prev = coilsByLoc.get(lid) || [];
    coilsByLoc.set(lid, prev.concat(uids));
    allUids.push(...uids);
  }

  if (!coilsByLoc.size) return null;

  const locMap = await loadRmLocationsByIds([...coilsByLoc.keys()]);
  const coilMap = await loadCoilsByUid(allUids);

  for (const [lid, uids] of coilsByLoc.entries()) {
    const lm = locMap.get(lid);
    if (!lm) {
      return `Location id ${lid} not found or inactive for RM Store.`;
    }
    const capErr = capacityErrorForLocation(lm, uids, coilMap);
    if (capErr) return capErr;
  }

  return null;
}
