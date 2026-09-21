import dbQuery from "../../../../../config/db/db.js";
import { MST_TABLES as M, RMSTORE_TABLES as T, IMS_TABLES as IT } from "../../../../../config/db/dbTables.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { fetchCoilSnapshotForLocation, fetchCoilDetailsByUids, flattenScansFromLocations, mergeScannedCoils, removeScannedCoil, parseExpectedCoils, parseScannedCoils, compareLocationCoilSets, resolveLocationStatusAfterScan, isLocationClosed, isLocationPending, resolveCoilAccName, sqlCoilInStoreAtLocation } from "../utils/snapshot/auditCoilSnapshot.js";
import { findAudits, ASSIGNED_USERS_SUBQUERY, AUDIT_DEFAULT_SELECT_FIELDS, AUDIT_LOCATIONS_JSON } from "../utils/list/auditList.js";

export { findAudits } from "../utils/list/auditList.js";

const ALLOWED_FILTER_FIELDS = ["audit_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_UPDATE_FIELDS = ["start_date", "end_date", "remarks", "status", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

const DEFAULT_FIELDS = AUDIT_DEFAULT_SELECT_FIELDS;
export const findAudit = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["am.is_deleted = false"];

  for (const key of keys) {
    if (key !== "audit_id" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`am.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")},
     ${ASSIGNED_USERS_SUBQUERY} AS assigned_user_names,
     ${AUDIT_LOCATIONS_JSON} AS locations
     FROM ${T.AUDIT_MASTER} am
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  if (row) {
    row.scans = flattenScansFromLocations(row.audit_id, row.locations);
  }

  return row ?? null;
};

const insertAuditLocationRow = async (run, auditId, locationId, assignedUserId, { client = null } = {}) => {
  // Expected boxes freeze when user starts scanning — not at create time.
  const userId = assignedUserId ?? null;
  await run(
    `INSERT INTO ${T.AUDIT_LOCATIONS}
     (audit_id, location_id, assigned_user_id, plan_assigned_user_id, expected_coils, scanned_coils, is_active)
     VALUES ($1, $2, $3, $3, '[]'::jsonb, '[]'::jsonb, true)`,
    [auditId, locationId, userId]
  );
};

/**
 * Freeze live in-hand boxes as expected when location audit actually starts.
 * Skips if already scanning (has scans) or location is closed.
 */
export const ensureExpectedBoxesAtScanStart = async (audit_id, location_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT expected_coils, scanned_coils, status
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  if (isLocationClosed(locRow.status)) {
    return parseExpectedCoils(locRow.expected_coils);
  }

  const scans = parseScannedCoils(locRow.scanned_coils);
  if (scans.length > 0) {
    return parseExpectedCoils(locRow.expected_coils);
  }

  const expectedBoxes = await fetchCoilSnapshotForLocation(location_id, { client });
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET expected_coils = $3::jsonb
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(expectedBoxes)]
  );
  return expectedBoxes;
};

export const insertAudit = async (data, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const {
    start_date,
    end_date,
    remarks,
    created_by,
    approved = false,
    approved_by = null,
    approved_at = null,
    assignments = [],
  } = data;

  const normalizedAssignments = Array.isArray(assignments) && assignments.length
    ? assignments
        .map((row) => ({
          assigned_user_id: row?.assigned_user_id,
          location_ids: Array.isArray(row?.location_ids) ? row.location_ids : [],
        }))
        .filter((row) => row.assigned_user_id && row.location_ids.length)
    : [];

  const res = await run(
    `INSERT INTO ${T.AUDIT_MASTER}
     (start_date, end_date, remarks, created_by, approved, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [start_date, end_date, remarks, created_by, Boolean(approved), approved_by ?? null, approved_at ?? null]
  );
  const row = client ? res.rows[0] : res[0];

  for (const assignment of normalizedAssignments) {
    for (const locId of assignment.location_ids) {
      await insertAuditLocationRow(run, row.audit_id, locId, assignment.assigned_user_id, { client });
    }
  }

  return row;
};

export const updateAudit = async (fields = {}, filters = {}, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS.includes(k)) safeFields[k] = fields[k];
  }
  for (const k in filters) {
    if (k === "audit_id" || ALLOWED_FILTER_FIELDS.includes(k)) safeFilters[k] = filters[k];
  }

  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length) throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];

  const setClause = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const whereClause = filterKeys.map((k, i) => `${k} = $${fieldKeys.length + i + 1}`).join(" AND ");

  const res = await run(
    `UPDATE ${T.AUDIT_MASTER}
     SET ${setClause}
     WHERE ${whereClause} AND is_deleted = false
     RETURNING *`,
    values
  );
  const row = client ? res.rows[0] : res[0];

  const normalizedAssignments = Array.isArray(fields.assignments) && fields.assignments.length
    ? fields.assignments
        .map((assignment) => ({
          assigned_user_id: assignment?.assigned_user_id,
          location_ids: Array.isArray(assignment?.location_ids) ? assignment.location_ids : [],
        }))
        .filter((assignment) => assignment.assigned_user_id && assignment.location_ids.length)
    : [];

  if (normalizedAssignments.length) {
    const existingRes = await run(
      `SELECT assignment_id, location_id, status, is_active, plan_assigned_user_id, assigned_user_id
       FROM ${T.AUDIT_LOCATIONS} WHERE audit_id = $1`,
      [row.audit_id]
    );
    const existingRows = client ? existingRes.rows : existingRes;
    const activeByLocation = new Map();
    const hasCloneForLocation = new Set();
    for (const loc of existingRows || []) {
      const key = String(loc.location_id);
      if (loc.is_active) activeByLocation.set(key, loc);
      else hasCloneForLocation.add(key);
    }

    const newLocationKeys = new Set();
    for (const assignment of normalizedAssignments) {
      for (const locId of assignment.location_ids) {
        newLocationKeys.add(String(locId));
      }
    }

    for (const [locKey, activeLoc] of activeByLocation) {
      if (!newLocationKeys.has(locKey)) {
        if (hasCloneForLocation.has(locKey)) continue;
        await run(
          `DELETE FROM ${T.AUDIT_LOCATIONS}
           WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
          [row.audit_id, Number(locKey)]
        );
      }
    }

    for (const assignment of normalizedAssignments) {
      for (const locId of assignment.location_ids) {
        const locKey = String(locId);
        if (activeByLocation.has(locKey)) {
          if (hasCloneForLocation.has(locKey)) continue;
          await run(
            `UPDATE ${T.AUDIT_LOCATIONS}
             SET assigned_user_id = $3,
                 plan_assigned_user_id = $3
             WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
            [row.audit_id, locId, assignment.assigned_user_id]
          );
        } else if (!hasCloneForLocation.has(locKey)) {
          await insertAuditLocationRow(run, row.audit_id, locId, assignment.assigned_user_id, { client });
        }
      }
    }
  } else if (fields.location_ids) {
    await run(`DELETE FROM ${T.AUDIT_LOCATIONS} WHERE audit_id = $1`, [row.audit_id]);
    for (const locId of fields.location_ids) {
      await insertAuditLocationRow(run, row.audit_id, locId, fields.assigned_user_id ?? null, { client });
    }
  }

  return row ?? null;
};

export const deleteAudit = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "audit_id" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  if (!conditions.length) throw new Error("Invalid filters");

  values.push(meta.deleted_by ?? null);

  await dbQuery(
    `UPDATE ${T.AUDIT_MASTER}
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};

export const insertAuditScan = async (data, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const { audit_id, location_id, coil_no_uid, scanned_by } = data;

  const locRes = await run(
    `SELECT scanned_coils FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const merged = mergeScannedCoils(locRow.scanned_coils, [coil_no_uid], scanned_by);
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_coils = $3::jsonb
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(merged)]
  );

  return merged.find((row) => row.coil_no_uid === String(coil_no_uid || "").trim().toUpperCase()) ?? null;
};

export const appendAuditScannedBoxes = async (data, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const { audit_id, location_id, coil_no_uids = [], scanned_by } = data;

  const locRes = await run(
    `SELECT scanned_coils FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  await ensureExpectedBoxesAtScanStart(audit_id, location_id, { client });

  const merged = mergeScannedCoils(locRow.scanned_coils, coil_no_uids, scanned_by);
  const nextStatus = merged.length ? "draft" : "pending";
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_coils = $3::jsonb,
         status = CASE
           WHEN status IN ('completed', 'mismatch') THEN status
           ELSE $4
         END
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(merged), nextStatus]
  );

  return merged;
};

export const updateAuditLocationStatus = async (audit_id, location_id, status, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, status]
  );
};

export const countPendingAuditLocations = async (audit_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(
    `SELECT COUNT(*)::int AS count FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND is_active = true AND status = 'pending'`,
    [audit_id]
  );
  const row = client ? res.rows[0] : res[0];
  return row?.count ?? 0;
};

async function allActiveLocationsCoilMatched(audit_id, { client = null } = {}) {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(
    `SELECT expected_coils, scanned_coils
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND is_active = true`,
    [audit_id]
  );
  const rows = client ? res.rows : res;
  if (!rows?.length) return false;

  for (const row of rows) {
    const comparison = compareLocationCoilSets(row.expected_coils, parseScannedCoils(row.scanned_coils));
    if (!comparison.exact) return false;
  }
  return true;
}

export const syncAuditMasterStatus = async (audit_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(
    `SELECT status FROM ${T.AUDIT_LOCATIONS} WHERE audit_id = $1 AND is_active = true`,
    [audit_id]
  );
  const rows = client ? res.rows : res;
  const statuses = (rows || []).map((r) => String(r.status || "pending").toLowerCase());
  if (!statuses.length) return null;

  const allClosed = statuses.every((s) => isLocationClosed(s));
  const allCompleted = statuses.every((s) => s === "completed");
  const inventoryMatched = allCompleted ? await allActiveLocationsCoilMatched(audit_id, { client }) : false;

  let nextStatus = "pending";
  if (statuses.some((s) => s === "draft")) nextStatus = "in_progress";
  else if (statuses.some((s) => s !== "pending")) nextStatus = "in_progress";
  if (allClosed && allCompleted && inventoryMatched) nextStatus = "verified";
  else if (allClosed) nextStatus = "submitted";

  await updateAudit({ status: nextStatus }, { audit_id }, { client });
  return nextStatus;
};

export const evaluateAuditLocationProgress = async (
  audit_id,
  location_id,
  { forceComplete = false, client = null } = {}
) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT expected_coils, scanned_coils, status
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const activeScans = parseScannedCoils(locRow.scanned_coils);
  const comparison = compareLocationCoilSets(locRow.expected_coils, activeScans);
  const nextStatus = resolveLocationStatusAfterScan(comparison, { forceComplete });

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, nextStatus]
  );

  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  if (isLocationClosed(nextStatus)) {
    const locMetaRes = await run(
      `SELECT location_id, assignment_id, assigned_user_id, plan_assigned_user_id, expected_coils, scanned_coils
       FROM ${T.AUDIT_LOCATIONS}
       WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
      [audit_id, location_id]
    );
    const locMeta = client ? locMetaRes.rows[0] : locMetaRes[0];
    if (locMeta) {
      await recordLocationScoreFromComparison(audit_id, locMeta, comparison, { client });
    }
  }

  return {
    location_status: nextStatus,
    audit_status: auditStatus,
    comparison,
    auto_completed: Boolean(forceComplete) && nextStatus === "completed" && comparison.exact,
  };
};

/** @deprecated use countPendingAuditLocations */
export const countIncompleteAuditLocations = countPendingAuditLocations;

export const reopenAuditLocation = async (audit_id, location_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT scanned_coils, status FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const currentStatus = String(locRow.status || "").toLowerCase();
  if (!isLocationClosed(currentStatus)) {
    throw new Error("Only completed or mismatch locations can be reopened");
  }

  const scanned = parseScannedCoils(locRow.scanned_coils);
  const nextStatus = scanned.length > 0 ? "draft" : "pending";

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3, result_rejected = false
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, nextStatus]
  );

  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  return { location_status: nextStatus, audit_status: auditStatus };
};

/** Reassign — replace assignee if never started; clone row + fresh assignment if scans exist. */
export const reassignAuditLocation = async (audit_id, location_id, assigned_user_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  const nextUserId = Number(assigned_user_id);
  if (!Number.isFinite(nextUserId)) {
    throw new Error("assigned_user_id required");
  }

  const locRes = await run(
    `SELECT assignment_id, assigned_user_id, plan_assigned_user_id, status, expected_coils, scanned_coils
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const prevUserId =
    locRow.assigned_user_id != null ? Number(locRow.assigned_user_id) : null;
  if (prevUserId === nextUserId) {
    throw new Error("Location is already assigned to this user");
  }

  const userRes = await run(`SELECT id FROM ${M.USERS} WHERE id = $1`, [nextUserId]);
  const userRow = client ? userRes.rows[0] : userRes[0];
  if (!userRow) throw new Error("User not found");

  const activeScans = parseScannedCoils(locRow.scanned_coils);
  const currentStatus = String(locRow.status || "").toLowerCase();
  const hasStarted = activeScans.length > 0 || !isLocationPending(currentStatus);

  if (!hasStarted) {
    await run(
      `UPDATE ${T.AUDIT_LOCATIONS}
       SET assigned_user_id = $3
       WHERE assignment_id = $1 AND audit_id = $2`,
      [locRow.assignment_id, audit_id, nextUserId]
    );

    const auditStatus = await syncAuditMasterStatus(audit_id, { client });

    return {
      assignment_id: locRow.assignment_id,
      cloned_assignment_id: null,
      assigned_user_id: nextUserId,
      previous_assigned_user_id: prevUserId,
      location_status: "pending",
      audit_status: auditStatus,
      cloned_scan_count: 0,
      replaced: true,
    };
  }

  const planUserId = locRow.plan_assigned_user_id ?? prevUserId;
  const clonedAt = new Date();

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET is_active = false, reassigned_at = $3
     WHERE assignment_id = $1 AND audit_id = $2`,
    [locRow.assignment_id, audit_id, clonedAt]
  );

  const insertRes = await run(
    `INSERT INTO ${T.AUDIT_LOCATIONS}
     (audit_id, location_id, assigned_user_id, plan_assigned_user_id, expected_coils, scanned_coils, status, is_active)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, 'pending', true)
     RETURNING assignment_id`,
    [audit_id, location_id, nextUserId, planUserId]
  );
  const newRow = client ? insertRes.rows[0] : insertRes[0];

  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  return {
    assignment_id: newRow?.assignment_id ?? null,
    cloned_assignment_id: locRow.assignment_id,
    assigned_user_id: nextUserId,
    previous_assigned_user_id: prevUserId,
    location_status: "pending",
    audit_status: auditStatus,
    cloned_scan_count: activeScans.length,
    replaced: false,
  };
};

export const deleteAuditScan = async (audit_id, location_id, coil_no_uid, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  const locRes = await run(
    `SELECT scanned_coils, status FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) return;

  const next = removeScannedCoil(locRow.scanned_coils, coil_no_uid);
  const nextStatus = next.length ? "draft" : "pending";
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_coils = $3::jsonb,
         status = CASE
           WHEN status IN ('completed', 'mismatch') THEN status
           ELSE $4
         END
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(next), nextStatus]
  );

  await syncAuditMasterStatus(audit_id, { client });
};

const normalizeCoilUid = (uid) => String(uid || "").trim().toUpperCase();

function formatCoilCustomer(detail, enrichCtx = null) {
  if (!detail) return "—";
  const name =
    detail.acc_name ||
    (enrichCtx ? resolveCoilAccName(detail) : null) ||
    resolveCoilAccName(detail);
  if (name && String(name).trim() !== "" && name !== "-") return String(name).trim();
  const code = detail?.acc_code;
  return code || "—";
}

function formatCoilItem(detail) {
  if (!detail) return "—";
  return detail.item_code || "—";
}

async function enrichExpectedCoilDetails(boxes = []) {
  if (!Array.isArray(boxes) || !boxes.length) return boxes;
  return boxes.map((row) => ({ ...row, acc_name: resolveCoilAccName(row) }));
}

function buildCoilReportRow(uid, detail, auditLocationNo, differenceType, enrichCtx = null) {
  return {
    difference_type: differenceType,
    coil_no_uid: uid,
    mrn_no: detail?.mrn_no ?? "—",
    acc_name: formatCoilCustomer(detail, enrichCtx),
    item_code: formatCoilItem(detail),
    qty: detail?.qty ?? "—",
    location_no: detail?.location_no || auditLocationNo || "—",
    expected: differenceType === "not_scanned" || differenceType === "matched_scan",
    scanned: differenceType === "extra_scan" || differenceType === "matched_scan",
  };
}

/**
 * Score % = (matched − extra) ÷ expected × 100, floor 0.
 * Missing lowers matched; each extra scan also deducts 1 point per expected box.
 */
export function computeLocationScorePct(expectedCount, matchedCount, extraCount = 0) {
  const expected = Number(expectedCount) || 0;
  const matched = Number(matchedCount) || 0;
  const extra = Number(extraCount) || 0;
  const net = Math.max(0, matched - extra);
  if (expected <= 0) return net > 0 ? 0 : 100;
  return Math.round((net / expected) * 10000) / 100;
}

export function scoreBreakdownFromComparison(comparison) {
  const expected = Number(comparison?.expected_count) || 0;
  const scanned = Number(comparison?.scanned_count) || 0;
  const missingCount = Array.isArray(comparison?.missing) ? comparison.missing.length : 0;
  const extraCount = Array.isArray(comparison?.extra) ? comparison.extra.length : 0;
  const matched = Math.max(0, expected - missingCount);
  return {
    expected_count: expected,
    scanned_count: scanned,
    matched_count: matched,
    extra_count: extraCount,
    score_pct: computeLocationScorePct(expected, matched, extraCount),
  };
}

export function scoreBreakdownFromLocation(loc) {
  const comparison = compareLocationCoilSets(loc?.expected_coils, loc?.scanned_coils);
  return scoreBreakdownFromComparison(comparison);
}

export const saveLocationScorePct = async (
  audit_id,
  location_id,
  score_pct,
  { assignment_id = null, client = null } = {}
) => {
  const auditId = Number(audit_id);
  const locId = Number(location_id);
  if (!Number.isFinite(auditId) || !Number.isFinite(locId)) {
    throw new Error("Invalid audit_id or location_id");
  }

  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const conditions = ["audit_id = $1", "location_id = $2"];
  const values = [auditId, locId, score_pct];

  if (assignment_id != null) {
    conditions.push(`assignment_id = $${values.length + 1}`);
    values.push(assignment_id);
  } else {
    conditions.push("is_active = true");
  }

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET score_pct = $3,
         score_at = NOW()
     WHERE ${conditions.join(" AND ")}`,
    values
  );
  return score_pct;
};

export const saveLocationResultRejected = async (
  audit_id,
  location_id,
  result_rejected,
  { assignment_id = null, client = null } = {}
) => {
  const auditId = Number(audit_id);
  const locId = Number(location_id);
  if (!Number.isFinite(auditId) || !Number.isFinite(locId)) {
    throw new Error("Invalid audit_id or location_id");
  }

  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const conditions = ["audit_id = $1", "location_id = $2"];
  const values = [auditId, locId, Boolean(result_rejected)];

  if (assignment_id != null) {
    conditions.push(`assignment_id = $${values.length + 1}`);
    values.push(assignment_id);
  } else {
    conditions.push("is_active = true");
  }

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET result_rejected = $3
     WHERE ${conditions.join(" AND ")}`,
    values
  );
  return Boolean(result_rejected);
};

function mapLocationScoreRow(row) {
  const breakdown = scoreBreakdownFromLocation(row);
  return {
    assignment_id: row.assignment_id,
    audit_id: row.audit_id,
    location_id: row.location_id,
    assigned_user_id: row.score_user_id ?? row.assigned_user_id,
    assigned_user_name: row.assigned_user_name,
    location_no: row.location_no,
    score_at: row.score_at,
    ...breakdown,
  };
}

export const getAuditLocationScores = async (audit_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(
    `SELECT
       al.assignment_id,
       al.audit_id,
       al.location_id,
       al.assigned_user_id,
       al.expected_coils,
       al.scanned_coils,
       COALESCE(al.plan_assigned_user_id, al.assigned_user_id) AS score_user_id,
       al.score_pct,
       al.score_at,
       COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no,
       COALESCE(u_plan.name, u_loc.name) AS assigned_user_name
     FROM ${T.AUDIT_LOCATIONS} al
     JOIN ${IT.LOCATION_MASTER} lm ON al.location_id = lm.location_id
     LEFT JOIN ${M.USERS} u_loc ON al.assigned_user_id = u_loc.id
     LEFT JOIN ${M.USERS} u_plan ON al.plan_assigned_user_id = u_plan.id
     WHERE al.audit_id = $1
       AND al.is_active = true
       AND al.score_at IS NOT NULL
     ORDER BY location_no ASC, al.assignment_id ASC`,
    [audit_id]
  );
  const rows = client ? res.rows : res;
  const location_scores = (rows || []).map(mapLocationScoreRow);

  const byUser = new Map();
  for (const row of location_scores) {
    const userId = row.assigned_user_id != null ? Number(row.assigned_user_id) : 0;
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        assigned_user_id: row.assigned_user_id,
        assigned_user_name: row.assigned_user_name || (userId ? `User #${userId}` : "—"),
        expected_count: 0,
        scanned_count: 0,
        matched_count: 0,
        extra_count: 0,
        location_count: 0,
      });
    }
    const agg = byUser.get(userId);
    agg.expected_count += Number(row.expected_count) || 0;
    agg.scanned_count += Number(row.scanned_count) || 0;
    agg.matched_count += Number(row.matched_count) || 0;
    agg.extra_count += Number(row.extra_count) || 0;
    agg.location_count += 1;
  }

  const user_scores = [...byUser.values()].map((agg) => ({
    ...agg,
    score_pct: computeLocationScorePct(agg.expected_count, agg.matched_count, agg.extra_count),
  }));

  return { location_scores, user_scores };
};

async function recordLocationScoreFromComparison(audit_id, loc, comparison, { client = null, location_id = null } = {}) {
  if (!loc || !comparison) return null;
  const locId = Number(loc.location_id ?? location_id);
  if (!Number.isFinite(locId)) return null;
  const { score_pct } = scoreBreakdownFromComparison(comparison);
  return saveLocationScorePct(audit_id, locId, score_pct, {
    assignment_id: loc.assignment_id ?? null,
    client,
  });
}

const buildDifferenceRow = buildCoilReportRow;

export const getAuditComparisonReport = async (audit_id, { locationId = null } = {}) => {
  const audit = await findAudit({ audit_id });
  if (!audit) return null;

  const locations = [];
  const allDifferenceRows = [];
  const enrichCtx = null; const enrichOpts = null;

  for (const loc of audit.locations || []) {
    if (loc.is_active === false) continue;
    const locId = Number(loc.location_id);
    if (locationId != null && locId !== Number(locationId)) continue;

    const expectedBoxes = await enrichExpectedCoilDetails(parseExpectedCoils(loc.expected_coils));
    const expectedByUid = new Map(
      expectedBoxes.map((b) => [normalizeCoilUid(b.coil_no_uid), b]).filter(([uid]) => uid)
    );
    let systemSet;

    if (expectedBoxes.length) {
      systemSet = new Set(expectedBoxes.map((b) => normalizeCoilUid(b.coil_no_uid)).filter(Boolean));
    } else {
      const systemRows = await dbQuery(
        `SELECT TRIM(c.coil_no_uid::text) AS coil_no_uid
         FROM ${T.COIL_TABLE} c
         WHERE ${sqlCoilInStoreAtLocation.replace(/\$1/g, "$1")}
         ORDER BY c.coil_no_uid`,
        [locId]
      );
      systemSet = new Set(systemRows.map((r) => normalizeCoilUid(r.coil_no_uid)).filter(Boolean));
    }

    const scannedSet = new Set(
      parseScannedCoils(loc.scanned_coils).map((s) => normalizeCoilUid(s.coil_no_uid)).filter(Boolean)
    );

    const missing_coils = [...systemSet].filter((uid) => !scannedSet.has(uid)).sort();
    const extra_coils = [...scannedSet].filter((uid) => !systemSet.has(uid)).sort();
    const matched_scanned_coils = [...scannedSet].filter((uid) => systemSet.has(uid)).sort();
    const matched = missing_coils.length === 0 && extra_coils.length === 0;

    const lookupUids = [...new Set([...missing_coils, ...extra_coils, ...matched_scanned_coils])];
    const fetchedDetails = await fetchCoilDetailsByUids(lookupUids);

    // Prefer live box_table + SA join over frozen expected_coils (old snapshots lack acc_name).
    const resolveDetail = (uid) => fetchedDetails.get(uid) ?? expectedByUid.get(uid) ?? null;

    const not_scanned_rows = missing_coils.map((uid) =>
      buildCoilReportRow(uid, resolveDetail(uid), loc.location_no, "not_scanned", enrichCtx)
    );
    const extra_scan_rows = extra_coils.map((uid) =>
      buildCoilReportRow(uid, resolveDetail(uid), loc.location_no, "extra_scan", enrichCtx)
    );
    const matched_rows = matched_scanned_coils.map((uid) =>
      buildCoilReportRow(uid, resolveDetail(uid), loc.location_no, "matched_scan", enrichCtx)
    );
    const difference_rows = [...not_scanned_rows, ...extra_scan_rows];

    for (const row of difference_rows) {
      allDifferenceRows.push({ ...row, location_id: locId, audit_location_no: loc.location_no });
    }

    locations.push({
      location_id: locId,
      location_no: loc.location_no,
      location_status: loc.status,
      result_rejected: Boolean(loc.result_rejected),
      system_count: systemSet.size,
      scanned_count: scannedSet.size,
      matched_scanned_count: matched_scanned_coils.length,
      not_scanned_count: missing_coils.length,
      extra_scan_count: extra_coils.length,
      matched,
      missing_coils,
      extra_coils,
      matched_scanned_coils,
      matched_rows,
      not_scanned_rows,
      extra_scan_rows,
      mismatch_incomplete: missing_coils.length > 0,
      mismatch_extra_scans: extra_coils.length > 0,
      system_coils: [...systemSet].sort(),
      scanned_coils: [...scannedSet].sort(),
      expected_coil_details: expectedBoxes,
      difference_rows,
    });
  }

  const totalNotScanned = locations.reduce((n, l) => n + (l.not_scanned_count || 0), 0);
  const totalExtra = locations.reduce((n, l) => n + (l.extra_scan_count || 0), 0);
  const totalMatched = locations.reduce((n, l) => n + (l.matched_scanned_count || 0), 0);

  const scores = await getAuditLocationScores(audit_id);

  return {
    audit_id: audit.audit_id,
    status: audit.status,
    locations,
    scores,
    difference_rows: allDifferenceRows,
    matched_rows: locations.flatMap((l) =>
      (l.matched_rows || []).map((row) => ({ ...row, location_id: l.location_id, audit_location_no: l.location_no }))
    ),
    not_scanned_rows: locations.flatMap((l) =>
      (l.not_scanned_rows || []).map((row) => ({ ...row, location_id: l.location_id, audit_location_no: l.location_no }))
    ),
    extra_scan_rows: locations.flatMap((l) =>
      (l.extra_scan_rows || []).map((row) => ({ ...row, location_id: l.location_id, audit_location_no: l.location_no }))
    ),
    summary: {
      total_locations: locations.length,
      matched_locations: locations.filter((l) => l.matched).length,
      mismatched_locations: locations.filter((l) => !l.matched).length,
      total_differences: allDifferenceRows.length,
      total_not_scanned: totalNotScanned,
      total_extra_scans: totalExtra,
      total_matched: totalMatched,
      total_expected: locations.reduce((n, l) => n + (l.system_count || 0), 0),
      total_scanned: locations.reduce((n, l) => n + (l.scanned_count || 0), 0),
    },
  };
};

/** Align coil_table with audit scans, log transactions, complete locations. */
export const applyAuditComparisonAdjustment = async (
  audit_id,
  { locationId = null, userId = null, userName = null, client = null, result_rejected = false } = {}
) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const audit = await findAudit({ audit_id });
  if (!audit) throw new Error("Audit not found");

  const report = await getAuditComparisonReport(audit_id, { locationId });
  if (!report?.locations?.length) throw new Error("No locations to adjust");

  const coilAuditBy = userName != null && String(userName).trim() !== "" ? String(userName).trim() : null;

  const summary = {
    missing_coils: 0,
    extra_coils: 0,
    locations_adjusted: 0,
  };

  for (const loc of report.locations) {
    const locId = Number(loc.location_id);
    const missing = loc.missing_coils || [];
    const extra = loc.extra_coils || [];
    if (!missing.length && !extra.length) continue;

    const auditLocRes = await run(
      `SELECT assignment_id, assigned_user_id, plan_assigned_user_id, expected_coils, scanned_coils
       FROM ${T.AUDIT_LOCATIONS}
       WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
      [audit_id, locId]
    );
    const auditLoc = client ? auditLocRes.rows[0] : auditLocRes[0];
    if (!auditLoc) continue;

    if (missing.length) {
      const removeRes = await run(
        `UPDATE ${T.COIL_TABLE} c
         SET location_id = NULL,
             updated_by = $3,
             updated_at = NOW()
         WHERE c.location_id = $1
           AND TRIM(UPPER(c.coil_no_uid::text)) = ANY($2::text[])
           AND c.is_deleted = false
           
         RETURNING c.coil_uid, c.coil_no_uid, c.qty, c.location_id, c.mrn_uid`,
        [locId, missing.map((u) => normalizeCoilUid(u)), coilAuditBy]
      );
      const removed = client ? removeRes.rows : removeRes;
      if (removed?.length) {
        summary.missing_coils += removed.length;
        await logCoilTransactionSafe({
          client,
          transaction_type: COIL_TX_TYPES.AUDIT_MISSING,
          source_module: "rm_inventory_audit",
          source_id: String(audit_id),
          user_id: userId,
          rows: removed,
          details: {
            audit_id,
            location_id: locId,
            difference_type: "missing",
            reason: "Audit missing — coil removed from location after adjustment",
            coil_count: removed.length,
          },
        });
      }
    }

    if (extra.length) {
      const extraUids = extra.map((u) => normalizeCoilUid(u));
      const extraRes = await run(
        `UPDATE ${T.COIL_TABLE} c
         SET location_id = $1,
             updated_by = $2,
             updated_at = NOW()
         WHERE TRIM(UPPER(c.coil_no_uid::text)) = ANY($3::text[])
           AND c.is_deleted = false
           
         RETURNING c.coil_uid, c.coil_no_uid, c.qty, c.location_id, c.mrn_uid`,
        [locId, coilAuditBy, extraUids]
      );
      const extraRows = client ? extraRes.rows : extraRes;
      if (extraRows?.length) {
        summary.extra_coils += extraRows.length;
        await logCoilTransactionSafe({
          client,
          transaction_type: COIL_TX_TYPES.AUDIT_EXTRA,
          source_module: "rm_inventory_audit",
          source_id: String(audit_id),
          user_id: userId,
          rows: extraRows,
          details: {
            audit_id,
            location_id: locId,
            difference_type: "extra",
            reason: "Audit extra — coil assigned to audit location after adjustment",
            coil_count: extraRows.length,
          },
        });
      }
    }

    const refreshedExpected = await fetchCoilSnapshotForLocation(locId, { client });
    const activeScans = parseScannedCoils(auditLoc.scanned_coils);
    const postComparison = compareLocationCoilSets(refreshedExpected, activeScans);

    await run(
      `UPDATE ${T.AUDIT_LOCATIONS}
       SET status = 'completed',
           result_rejected = $3,
           expected_coils = $4::jsonb
       WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
      [audit_id, locId, Boolean(result_rejected), JSON.stringify(refreshedExpected)]
    );

    await recordLocationScoreFromComparison(
      audit_id,
      { ...auditLoc, location_id: locId },
      postComparison,
      { client, location_id: locId }
    );

    summary.locations_adjusted += 1;
  }

  if (!summary.locations_adjusted) {
    throw new Error("No mismatched locations to adjust");
  }

  summary.audit_status = await syncAuditMasterStatus(audit_id, { client });

  return summary;
};

/** Close location as Complete — status only, no box_table / inventory changes. */
export const completeAuditLocation = async (
  audit_id,
  location_id,
  { client = null, result_rejected = false } = {}
) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT expected_coils, scanned_coils, status, assignment_id, assigned_user_id, plan_assigned_user_id
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const activeScans = parseScannedCoils(locRow.scanned_coils);
  const comparison = compareLocationCoilSets(locRow.expected_coils, activeScans);

  const currentStatus = String(locRow.status || "").trim().toLowerCase();
  if (currentStatus === "completed") {
    const auditStatus = await syncAuditMasterStatus(audit_id, { client });
    return {
      location_status: "completed",
      audit_status: auditStatus,
      comparison,
      already_complete: true,
    };
  }

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET status = 'completed', result_rejected = $3
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, Boolean(result_rejected)]
  );

  await recordLocationScoreFromComparison(audit_id, locRow, comparison, { client, location_id });
  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  return {
    location_status: "completed",
    audit_status: auditStatus,
    comparison,
    result_rejected: Boolean(result_rejected),
    already_complete: false,
  };
};
