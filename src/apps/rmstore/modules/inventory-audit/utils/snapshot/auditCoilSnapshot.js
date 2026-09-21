import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T, IMS_TABLES as IT } from "../../../../../../config/db/dbTables.js";
import { coilQcJoinForAlias } from "../../../../lib/utils/coilQcStatusSql.js";

/** Physical in-store coils at this RM location (matches inventory report IN_STORE bucket). */
const COIL_IN_STORE_WHERE = `
  c.location_id = $1
  AND c.is_deleted = false
  AND LOWER(TRIM(COALESCE(c.status, 'active'))) NOT IN ('out', 'consumed')
  AND c.out_uid IS NULL
  AND LOWER(TRIM(COALESCE(c.status, 'active'))) <> 'consumed'
`;

const SNAPSHOT_SQL = `
  SELECT
    c.coil_uid,
    TRIM(c.coil_no_uid::text) AS coil_no_uid,
    c.qty,
    c.location_id,
    c.mrn_uid,
    c.sa_id,
    c.sa_entry_type,
    c.status,
    m.mrn_no,
    m.item_dcode,
    COALESCE(NULLIF(TRIM(m.item_code), ''), m.item_dcode::text) AS item_code,
    m.item_desc,
    m.acc_code,
    NULLIF(TRIM(m.acc_name), '') AS acc_name,
    COALESCE(NULLIF(TRIM(m.heat_no), ''), NULLIF(TRIM(m.it_lot_no), '')) AS heat_no
  FROM ${T.COIL_TABLE} c
  LEFT JOIN ${T.MRN} m ON m.mrn_uid = c.mrn_uid AND m.is_deleted = false
  ${coilQcJoinForAlias("c", "q")}
  WHERE ${COIL_IN_STORE_WHERE}
  ORDER BY c.coil_no_uid
`;

const COIL_DETAIL_BY_UID_SQL = `
  SELECT
    c.coil_uid,
    TRIM(c.coil_no_uid::text) AS coil_no_uid,
    c.qty,
    c.location_id,
    c.mrn_uid,
    c.sa_id,
    c.sa_entry_type,
    c.status,
    m.mrn_no,
    m.item_dcode,
    COALESCE(NULLIF(TRIM(m.item_code), ''), m.item_dcode::text) AS item_code,
    m.item_desc,
    m.acc_code,
    NULLIF(TRIM(m.acc_name), '') AS acc_name,
    COALESCE(NULLIF(TRIM(m.heat_no), ''), NULLIF(TRIM(m.it_lot_no), '')) AS heat_no,
    COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
  FROM ${T.COIL_TABLE} c
  LEFT JOIN ${T.MRN} m ON m.mrn_uid = c.mrn_uid AND m.is_deleted = false
  LEFT JOIN ${IT.LOCATION_MASTER} lm ON c.location_id = lm.location_id
  ${coilQcJoinForAlias("c", "q")}
  WHERE TRIM(UPPER(c.coil_no_uid::text)) = ANY($1::text[])
    AND c.is_deleted = false
  ORDER BY c.coil_no_uid
`;

export async function fetchCoilSnapshotForLocation(locationId, { client = null } = {}) {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(SNAPSHOT_SQL, [locationId]);
  const rows = client ? res.rows : res;
  return (rows || []).map(normalizeSnapshotCoil);
}

export async function fetchCoilDetailsByUids(uids = [], { client = null } = {}) {
  const normalized = [...new Set((uids || []).map((uid) => normalizeUid(uid)).filter(Boolean))];
  if (!normalized.length) return new Map();

  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(COIL_DETAIL_BY_UID_SQL, [normalized]);
  const rows = client ? res.rows : res;
  const map = new Map();
  for (const row of rows || []) {
    const detail = normalizeSnapshotCoil(row);
    map.set(detail.coil_no_uid, { ...detail, location_no: row.location_no ?? null });
  }
  return map;
}

export async function fetchCoilSnapshotsForLocations(locationIds = [], { client = null } = {}) {
  const uniqueIds = [...new Set((locationIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const map = new Map();
  for (const locId of uniqueIds) {
    map.set(locId, await fetchCoilSnapshotForLocation(locId, { client }));
  }
  return map;
}

function normalizeSnapshotCoil(row) {
  const accRaw = row.acc_name != null ? String(row.acc_name).trim() : "";
  const acc_name = accRaw && accRaw !== "-" ? accRaw : null;
  const codeRaw = row.acc_code != null ? String(row.acc_code).trim() : "";
  const acc_code = codeRaw && codeRaw !== "-" ? codeRaw : null;

  return {
    coil_uid: row.coil_uid ?? null,
    coil_no_uid: String(row.coil_no_uid || "").trim().toUpperCase(),
    qty: row.qty ?? null,
    location_id: row.location_id ?? null,
    mrn_uid: row.mrn_uid ?? null,
    mrn_no: row.mrn_no ?? null,
    sa_id: row.sa_id ?? null,
    sa_entry_type: row.sa_entry_type ?? null,
    status: row.status ?? null,
    item_dcode: row.item_dcode ?? null,
    item_code: row.item_code ?? null,
    item_desc: row.item_desc ?? null,
    acc_code,
    acc_name: acc_name ?? acc_code,
    heat_no: row.heat_no ?? null,
  };
}

export function resolveCoilAccName(row) {
  if (!row) return null;
  const name = row.acc_name != null ? String(row.acc_name).trim() : "";
  if (name && name !== "-") return name;
  const code = row.acc_code != null ? String(row.acc_code).trim() : "";
  return code && code !== "-" ? code : null;
}

const normalizeUid = (uid) => String(uid || "").trim().toUpperCase();

export function parseScannedCoils(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
  return list
    .map((row) => ({
      coil_no_uid: normalizeUid(row?.coil_no_uid ?? row?.box_no_uid),
      scanned_at: row?.scanned_at ?? null,
      scanned_by: row?.scanned_by ?? null,
    }))
    .filter((row) => row.coil_no_uid);
}

export function parseExpectedCoils(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
  return list.map(normalizeSnapshotCoilFromJson).filter((row) => row.coil_no_uid);
}

function normalizeSnapshotCoilFromJson(row) {
  if (!row || typeof row !== "object") return { coil_no_uid: "" };
  const coil_no_uid = normalizeUid(row.coil_no_uid ?? row.box_no_uid);
  return normalizeSnapshotCoil({ ...row, coil_no_uid });
}

export function flattenScansFromLocations(auditId, locations = []) {
  const scans = [];
  for (const loc of locations) {
    if (loc.is_active === false) continue;
    const locId = Number(loc.location_id);
    for (const row of parseScannedCoils(loc.scanned_coils ?? loc.scanned_boxes)) {
      scans.push({
        audit_id: auditId,
        location_id: locId,
        location_no: loc.location_no ?? null,
        coil_no_uid: row.coil_no_uid,
        scanned_at: row.scanned_at,
        scanned_by: row.scanned_by,
      });
    }
  }
  return scans;
}

export function mergeScannedCoils(existing = [], additions = [], scannedBy, scannedAt = new Date()) {
  const byUid = new Map();
  for (const row of parseScannedCoils(existing)) {
    byUid.set(row.coil_no_uid, row);
  }
  const at = scannedAt instanceof Date ? scannedAt.toISOString() : scannedAt;
  for (const uid of additions) {
    const key = normalizeUid(uid);
    if (!key) continue;
    if (!byUid.has(key)) {
      byUid.set(key, { coil_no_uid: key, scanned_at: at, scanned_by: scannedBy ?? null });
    }
  }
  return [...byUid.values()].sort((a, b) => a.coil_no_uid.localeCompare(b.coil_no_uid));
}

export function removeScannedCoil(existing = [], coilNoUid) {
  const key = normalizeUid(coilNoUid);
  return parseScannedCoils(existing).filter((row) => row.coil_no_uid !== key);
}

export function compareLocationCoilSets(expected_coils, scanned_coils) {
  const expected = new Set(
    parseExpectedCoils(expected_coils).map((b) => normalizeUid(b.coil_no_uid)).filter(Boolean)
  );
  const scanned = new Set(
    parseScannedCoils(scanned_coils).map((s) => normalizeUid(s.coil_no_uid)).filter(Boolean)
  );

  const missing = [...expected].filter((uid) => !scanned.has(uid)).sort();
  const extra = [...scanned].filter((uid) => !expected.has(uid)).sort();
  const exact = missing.length === 0 && extra.length === 0 && expected.size === scanned.size;
  const pending = scanned.size < expected.size && extra.length === 0;

  return {
    exact,
    pending,
    mismatch: !exact && !pending,
    missing,
    extra,
    expected_count: expected.size,
    scanned_count: scanned.size,
  };
}

export function resolveLocationStatusAfterScan(comparison, { forceComplete = false } = {}) {
  if (forceComplete) {
    return comparison.exact ? "completed" : "mismatch";
  }
  if (comparison.scanned_count > 0) return "draft";
  return "pending";
}

export function isLocationPending(statusOrLoc) {
  const key =
    typeof statusOrLoc === "object"
      ? String(statusOrLoc?.status ?? "pending").trim().toLowerCase()
      : String(statusOrLoc ?? "pending").trim().toLowerCase();
  return key === "pending";
}

export function isLocationClosed(statusOrLoc) {
  const key =
    typeof statusOrLoc === "object"
      ? String(statusOrLoc?.status ?? "").trim().toLowerCase()
      : String(statusOrLoc ?? "").trim().toLowerCase();
  return key === "completed" || key === "mismatch";
}

/** Warehouse coil eligible for location snapshot (in store, not issued). */
export const sqlCoilInStoreAtLocation = COIL_IN_STORE_WHERE;
