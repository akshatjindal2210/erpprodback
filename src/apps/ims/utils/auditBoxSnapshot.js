import dbQuery from "../../../config/db.js";
import { IMS_TABLES as T } from "../../../config/dbTables.js";
import {
  sqlBoxInHand,
  sqlBoxItemDcode,
  sqlBoxCustomerCode,
  sqlBoxPackingNumber,
} from "./boxInventorySql.js";

const SNAPSHOT_SQL = `
  SELECT
    b.box_uid,
    TRIM(b.box_no_uid::text) AS box_no_uid,
    ${sqlBoxPackingNumber("b")} AS packing_number,
    b.qty,
    NULLIF(TRIM(b.override_cust::text), '') AS override_cust,
    b.is_loose,
    b.location_id,
    b.sa_id,
    b.sa_entry_type,
    ${sqlBoxItemDcode("sa", "dp")} AS item_dcode,
    ${sqlBoxCustomerCode("b", "dp")} AS acc_code,
    COALESCE(NULLIF(TRIM(b.override_cust::text), ''), NULLIF(TRIM(dp.acc_code::text), '')) AS acc_name,
    NULLIF(TRIM(dp.item_dcode::text), '') AS item_code
  FROM ${T.BOX_TABLE} b
  LEFT JOIN ${T.STOCK_ADJUSTMENT} sa ON b.sa_id = sa.adjustment_id
  LEFT JOIN ${T.DAILYPROD} dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
  WHERE b.location_id = $1
    AND ${sqlBoxInHand("b")}
  ORDER BY b.box_no_uid
`;

/** In-hand boxes at this location — frozen snapshot for audit comparison. */
export async function fetchBoxSnapshotForLocation(locationId, { client = null } = {}) {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(SNAPSHOT_SQL, [locationId]);
  const rows = client ? res.rows : res;
  return (rows || []).map(normalizeSnapshotBox);
}

const BOX_DETAIL_BY_UID_SQL = `
  SELECT
    b.box_uid,
    TRIM(b.box_no_uid::text) AS box_no_uid,
    ${sqlBoxPackingNumber("b")} AS packing_number,
    b.qty,
    NULLIF(TRIM(b.override_cust::text), '') AS override_cust,
    b.is_loose,
    b.location_id,
    b.sa_id,
    b.sa_entry_type,
    ${sqlBoxItemDcode("sa", "dp")} AS item_dcode,
    ${sqlBoxCustomerCode("b", "dp")} AS acc_code,
    COALESCE(NULLIF(TRIM(b.override_cust::text), ''), NULLIF(TRIM(dp.acc_code::text), '')) AS acc_name,
    NULLIF(TRIM(dp.item_dcode::text), '') AS item_code,
    COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
  FROM ${T.BOX_TABLE} b
  LEFT JOIN ${T.LOCATION_MASTER} lm ON b.location_id = lm.location_id
  LEFT JOIN ${T.STOCK_ADJUSTMENT} sa ON b.sa_id = sa.adjustment_id
  LEFT JOIN ${T.DAILYPROD} dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
  WHERE TRIM(UPPER(b.box_no_uid::text)) = ANY($1::text[])
  ORDER BY b.box_no_uid
`;

/** Box table details for a set of box UIDs (any location). */
export async function fetchBoxDetailsByUids(uids = [], { client = null } = {}) {
  const normalized = [...new Set((uids || []).map((uid) => normalizeUid(uid)).filter(Boolean))];
  if (!normalized.length) return new Map();

  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(BOX_DETAIL_BY_UID_SQL, [normalized]);
  const rows = client ? res.rows : res;
  const map = new Map();
  for (const row of rows || []) {
    const detail = {
      ...normalizeSnapshotBox(row),
      location_no: row.location_no ?? null,
    };
    map.set(detail.box_no_uid, detail);
  }
  return map;
}

export async function fetchBoxSnapshotsForLocations(locationIds = [], { client = null } = {}) {
  const uniqueIds = [...new Set((locationIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const map = new Map();
  for (const locId of uniqueIds) {
    map.set(locId, await fetchBoxSnapshotForLocation(locId, { client }));
  }
  return map;
}

function normalizeSnapshotBox(row) {
  return {
    box_uid: row.box_uid ?? null,
    box_no_uid: String(row.box_no_uid || "").trim().toUpperCase(),
    packing_number: row.packing_number ?? null,
    qty: row.qty ?? null,
    override_cust: row.override_cust ?? null,
    is_loose: Boolean(row.is_loose),
    location_id: row.location_id ?? null,
    sa_id: row.sa_id ?? null,
    sa_entry_type: row.sa_entry_type ?? null,
    item_dcode: row.item_dcode ?? null,
    acc_code: row.acc_code ?? null,
    acc_name: row.acc_name ?? null,
    item_code: row.item_code ?? null,
  };
}

const normalizeUid = (uid) => String(uid || "").trim().toUpperCase();

export function parseScannedBoxes(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list
    .map((row) => ({
      box_no_uid: normalizeUid(row?.box_no_uid),
      scanned_at: row?.scanned_at ?? null,
      scanned_by: row?.scanned_by ?? null,
    }))
    .filter((row) => row.box_no_uid);
}

export function parseAssignmentHistory(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list
    .map((entry) => ({
      assignment_clone_id: entry?.assignment_clone_id ?? null,
      user_id: entry?.user_id != null ? Number(entry.user_id) : null,
      user_name: entry?.user_name ?? null,
      location_status: entry?.location_status ?? null,
      reassigned_at: entry?.reassigned_at ?? null,
      scan_count: Number(entry?.scan_count) || parseScannedBoxes(entry?.scanned_boxes).length,
      expected_boxes: parseExpectedBoxes(entry?.expected_boxes),
      scanned_boxes: parseScannedBoxes(entry?.scanned_boxes),
    }))
    .filter((entry) => entry.user_id != null);
}

/** Union of cloned history scans + active scanned_boxes (for comparison/count). */
export function getMergedScannedBoxes(rawLocation) {
  const loc = rawLocation && typeof rawLocation === "object" ? rawLocation : { scanned_boxes: rawLocation };
  const byUid = new Map();

  for (const entry of parseAssignmentHistory(loc.assignment_history)) {
    for (const row of entry.scanned_boxes || []) {
      if (row?.box_no_uid) byUid.set(row.box_no_uid, row);
    }
  }
  for (const row of parseScannedBoxes(loc.scanned_boxes)) {
    if (row?.box_no_uid) byUid.set(row.box_no_uid, row);
  }

  return [...byUid.values()].sort((a, b) => a.box_no_uid.localeCompare(b.box_no_uid));
}

export function parseExpectedBoxes(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list.map(normalizeSnapshotBox).filter((row) => row.box_no_uid);
}

/** Flatten location scanned_boxes for API consumers that expect audit.scans rows. */
export function flattenScansFromLocations(auditId, locations = []) {
  const scans = [];
  for (const loc of locations) {
    if (loc.is_active === false) continue;
    const locId = Number(loc.location_id);
    for (const row of parseScannedBoxes(loc.scanned_boxes)) {
      scans.push({
        audit_id: auditId,
        location_id: locId,
        location_no: loc.location_no ?? null,
        box_no_uid: row.box_no_uid,
        scanned_at: row.scanned_at,
        scanned_by: row.scanned_by,
      });
    }
  }
  return scans;
}

export function mergeScannedBoxes(existing = [], additions = [], scannedBy, scannedAt = new Date()) {
  const byUid = new Map();
  for (const row of parseScannedBoxes(existing)) {
    byUid.set(row.box_no_uid, row);
  }
  const at = scannedAt instanceof Date ? scannedAt.toISOString() : scannedAt;
  for (const uid of additions) {
    const key = normalizeUid(uid);
    if (!key) continue;
    if (!byUid.has(key)) {
      byUid.set(key, { box_no_uid: key, scanned_at: at, scanned_by: scannedBy ?? null });
    }
  }
  return [...byUid.values()].sort((a, b) => a.box_no_uid.localeCompare(b.box_no_uid));
}

export function removeScannedBox(existing = [], boxNoUid) {
  const key = normalizeUid(boxNoUid);
  return parseScannedBoxes(existing).filter((row) => row.box_no_uid !== key);
}

/** Compare expected snapshot vs scanned JSON for a location. */
export function compareLocationBoxSets(expected_boxes, scanned_boxes) {
  const expected = new Set(
    parseExpectedBoxes(expected_boxes).map((b) => normalizeUid(b.box_no_uid)).filter(Boolean)
  );
  const scanned = new Set(
    parseScannedBoxes(scanned_boxes).map((s) => normalizeUid(s.box_no_uid)).filter(Boolean)
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
  if (comparison.exact) return "completed";
  if (forceComplete) return "mismatch";
  if (comparison.scanned_count > 0) return "draft";
  return "pending";
}

export function isLocationPending(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "pending").trim().toLowerCase()
    : String(statusOrLoc ?? "pending").trim().toLowerCase();
  return key === "pending";
}

export function isLocationDraft(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "").trim().toLowerCase()
    : String(statusOrLoc ?? "").trim().toLowerCase();
  return key === "draft";
}

/** Location still open for scanning / edits (not finalized). */
export function isLocationEditable(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "pending").trim().toLowerCase()
    : String(statusOrLoc ?? "pending").trim().toLowerCase();
  return key === "pending" || key === "draft";
}

export function isLocationClosed(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "").trim().toLowerCase()
    : String(statusOrLoc ?? "").trim().toLowerCase();
  return key === "completed" || key === "mismatch";
}
