/**
 * Store-In register — IMS-style: coils stay on in_uid after store-out.
 * Fallback reads inward_link transaction when legacy store-out cleared in_uid.
 */

import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { COIL_QC_JOIN, COIL_QC_STATUS_EXPR } from "../../../lib/utils/coilQcStatusSql.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";

const COIL = T.COIL_TABLE;
const MRN = T.MRN;
const LOC = T.MASTER_LOCATION;
const TX = T.COIL_TRANSACTION;

const REGISTER_COIL_SELECT = `
  c.coil_uid, c.coil_no_uid, c.mrn_uid, m.mrn_no, m.serial_no, m.heat_no,
  m.item_dcode, m.item_code, m.item_desc, c.qty, c.location_id, c.in_uid,
  c.out_uid, c.status, ${COIL_QC_STATUS_EXPR} AS qc_check_status,
  lm.location_no, lm.rack_no, lm.row_no
`;

/** Coils linked to a store-in entry (includes shop-floor / out status — register view). */
export async function findInwardRegisterCoils(in_uid) {
  const id = Number(in_uid);
  if (!Number.isFinite(id)) return [];
  return dbQuery(
    `SELECT ${REGISTER_COIL_SELECT}
     FROM ${COIL} c
     LEFT JOIN ${MRN} m ON m.uid = c.mrn_uid
     ${COIL_QC_JOIN}
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE c.in_uid = $1 AND c.is_deleted = false
     ORDER BY c.coil_uid ASC`,
    [id]
  );
}

/** Active coils still on this store-in register (editable). */
function isLiveInwardCoil(coil) {
  const st = String(coil?.status || "active").toLowerCase();
  return st === "active" || st === "rejected";
}

/** Group register coils by location (IMS inward modal analog). */
export function groupRegisterCoilsIntoLocations(coils) {
  const map = {};
  const HISTORY_KEY = "__history__";
  const PENDING_KEY = "__pending__";

  for (const coil of coils || []) {
    const lid = coil.location_id != null ? Number(coil.location_id) : null;
    let key;
    if (lid != null) {
      key = String(lid);
    } else if (isLiveInwardCoil(coil) && coil.in_uid != null) {
      key = PENDING_KEY;
    } else {
      key = HISTORY_KEY;
    }

    if (!map[key]) {
      if (key === HISTORY_KEY) {
        map[key] = {
          location_id: null,
          name: "Moved / issued",
          location_no: "—",
          historical: true,
          coils: [],
        };
      } else if (key === PENDING_KEY) {
        map[key] = {
          location_id: null,
          name: "Assign location",
          location_no: "—",
          historical: false,
          coils: [],
        };
      } else {
        const locName =
          String(coil.location_no || "").trim() ||
          `RM-${coil.rack_no || ""}${String(coil.row_no || "").toUpperCase()}`.trim() ||
          String(lid);
        map[key] = {
          location_id: lid,
          name: locName,
          location_no: locName,
          historical: false,
          coils: [],
        };
      }
    }
    map[key].coils.push(coil);
  }

  return Object.values(map).sort((a, b) => Number(!!a.historical) - Number(!!b.historical));
}

/** Split grouped register rows — editable (saved layout) vs read-only history. */
export function splitRegisterLocations(grouped = []) {
  const editable = [];
  const history = [];
  for (const loc of grouped || []) {
    if (loc.historical) history.push(loc);
    else editable.push(loc);
  }
  return { editable, history };
}

function parseTxDetails(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function inwardLinkCoilUidsFromLog(in_uid) {
  const [row] = await dbQuery(
    `SELECT details FROM ${TX}
     WHERE transaction_type = $1
       AND source_module = 'inventory_inward'
       AND source_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [COIL_TX_TYPES.INWARD_LINK, String(in_uid)]
  );
  const details = parseTxDetails(row?.details);
  const uids = Array.isArray(details.coil_no_uids)
    ? details.coil_no_uids.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  return [...new Set(uids)];
}

/** Re-link coils whose in_uid was cleared by legacy store-out. */
export async function repairInwardRegisterLinks(in_uid) {
  const id = Number(in_uid);
  if (!Number.isFinite(id)) return 0;
  const uids = await inwardLinkCoilUidsFromLog(id);
  if (!uids.length) return 0;

  const rows = await dbQuery(
    `UPDATE ${COIL}
     SET in_uid = $1,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($2::text[])
       AND is_deleted = false
       AND (in_uid IS NULL OR in_uid = $1)
     RETURNING coil_no_uid`,
    [id, uids]
  );
  return rows?.length || 0;
}

/** Restore rack location on active store-in coils when location_id was cleared (e.g. after edit). */
export async function repairInwardRegisterLocations(in_uid) {
  const id = Number(in_uid);
  if (!Number.isFinite(id)) return 0;

  const [row] = await dbQuery(
    `SELECT details FROM ${TX}
     WHERE transaction_type = $1
       AND source_module = 'inventory_inward'
       AND source_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [COIL_TX_TYPES.INWARD_LINK, String(in_uid)]
  );
  const details = parseTxDetails(row?.details);
  const registerLocs = Array.isArray(details.register_locations) ? details.register_locations : [];
  let fixed = 0;

  for (const loc of registerLocs) {
    const lid = Number(loc?.location_id);
    if (!Number.isFinite(lid) || lid <= 0) continue;
    const uids = (loc.coils || [])
      .map((c) => String(c?.coil_no_uid || c || "").trim())
      .filter(Boolean);
    if (!uids.length) continue;

    const rows = await dbQuery(
      `UPDATE ${COIL}
       SET location_id = $1,
           updated_at = NOW()
       WHERE in_uid = $2
         AND coil_no_uid = ANY($3::text[])
         AND is_deleted = false
         AND location_id IS NULL
         AND COALESCE(status, 'active') = 'active'
       RETURNING coil_no_uid`,
      [lid, id, uids]
    );
    fixed += rows?.length || 0;
  }
  return fixed;
}

function enrichCoilsLocationFromLog(coils, registerLocations) {
  const uidToLoc = new Map();
  for (const loc of registerLocations || []) {
    const lid = loc?.location_id != null ? Number(loc.location_id) : null;
    if (!Number.isFinite(lid) || lid <= 0) continue;
    for (const c of loc.coils || []) {
      const uid = String(c?.coil_no_uid || "").trim();
      if (!uid) continue;
      uidToLoc.set(uid, {
        location_id: lid,
        location_no: loc.location_no || loc.name || null,
        rack_no: c.rack_no ?? null,
        row_no: c.row_no ?? null,
      });
    }
  }
  if (!uidToLoc.size) return coils;
  return (coils || []).map((c) => {
    if (c.location_id != null) return c;
    const hit = uidToLoc.get(String(c.coil_no_uid || "").trim());
    return hit ? { ...c, ...hit } : c;
  });
}

/** Last-resort register read from inward_link transaction (legacy rows). */
export async function findInwardRegisterFallbackFromLog(in_uid) {
  const [row] = await dbQuery(
    `SELECT details FROM ${TX}
     WHERE transaction_type = $1
       AND source_module = 'inventory_inward'
       AND source_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [COIL_TX_TYPES.INWARD_LINK, String(in_uid)]
  );
  const details = parseTxDetails(row?.details);

  if (Array.isArray(details.register_locations) && details.register_locations.length) {
    const coils = details.register_locations.flatMap((loc) =>
      (loc.coils || []).map((c) => ({ ...c, _fromRegisterLog: true }))
    );
    return {
      coils,
      locations: details.register_locations,
      fromLog: true,
    };
  }

  const uids = await inwardLinkCoilUidsFromLog(in_uid);
  if (!uids.length) return { coils: [], locations: [], fromLog: false };

  const live = await dbQuery(
    `SELECT ${REGISTER_COIL_SELECT}
     FROM ${COIL} c
     LEFT JOIN ${MRN} m ON m.uid = c.mrn_uid
     ${COIL_QC_JOIN}
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE c.coil_no_uid = ANY($1::text[]) AND c.is_deleted = false
     ORDER BY c.coil_uid ASC`,
    [uids]
  );
  return {
    coils: live,
    locations: groupRegisterCoilsIntoLocations(live),
    fromLog: true,
  };
}

/** Full register payload for get-by-id (live link + repair + log fallback). */
export async function loadInwardRegisterPayload(in_uid, { expectedCoilCount = 0 } = {}) {
  let coils = await findInwardRegisterCoils(in_uid);

  if (!coils.length && expectedCoilCount > 0) {
    await repairInwardRegisterLinks(in_uid);
    coils = await findInwardRegisterCoils(in_uid);
  }

  const liveMissingLocation = coils.some(
    (c) => c.location_id == null && isLiveInwardCoil(c) && c.in_uid != null
  );
  if (liveMissingLocation) {
    await repairInwardRegisterLocations(in_uid);
    coils = await findInwardRegisterCoils(in_uid);
  }

  if (coils.some((c) => c.location_id == null && isLiveInwardCoil(c) && c.in_uid != null)) {
    const fallback = await findInwardRegisterFallbackFromLog(in_uid);
    coils = enrichCoilsLocationFromLog(coils, fallback.locations);
  }

  if (coils.length) {
    const grouped = groupRegisterCoilsIntoLocations(coils);
    const { editable, history } = splitRegisterLocations(grouped);
    return {
      coils,
      locations: editable,
      history_locations: history,
      fromLog: false,
    };
  }

  if (expectedCoilCount > 0) {
    const fallback = await findInwardRegisterFallbackFromLog(in_uid);
    if (fallback.coils.length) {
      const grouped = groupRegisterCoilsIntoLocations(fallback.coils);
      const { editable, history } = splitRegisterLocations(grouped);
      return {
        ...fallback,
        locations: editable.length ? editable : fallback.locations,
        history_locations: history,
      };
    }
  }

  return { coils: [], locations: [], history_locations: [], fromLog: false };
}

/** Snapshot for transaction log — what was submitted on the register. */
export function buildInwardRegisterLogDetails(locationsInput, linkedCoils = []) {
  const locations = groupRegisterCoilsIntoLocations(linkedCoils);
  return {
    location_count: locationsInput?.length || locations.length,
    locations: (locationsInput || []).map((l) => ({
      location_id: l.location_id,
      coil_count: (l.coils || []).length,
    })),
    register_locations: locations,
    coil_count: linkedCoils.length,
    coil_no_uids: linkedCoils.map((c) => c.coil_no_uid).filter(Boolean),
  };
}
