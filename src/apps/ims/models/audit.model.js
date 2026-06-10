import dbQuery from "../../../config/db.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../../../config/dbTables.js";
import { BOX_TX_TYPES } from "../constants/boxTransactionTypes.js";
import { sqlBoxInHand } from "../utils/boxInventorySql.js";
import { logBoxTransaction, singlePackingFromRows } from "../utils/logBoxTransaction.js";
import { fetchBoxSnapshotForLocation, fetchBoxDetailsByUids, flattenScansFromLocations, mergeScannedBoxes, removeScannedBox, parseExpectedBoxes, parseScannedBoxes, compareLocationBoxSets, resolveLocationStatusAfterScan, isLocationClosed, isLocationPending, resolveBoxAccName, resolveAuditBoxAccName, pickAuditAccCode, enrichAuditBoxRows, buildAuditEnrichContext } from "../utils/auditBoxSnapshot.js";

const ALLOWED_FILTER_FIELDS = ["audit_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["audit_id", "start_date", "end_date", "status", "created_at"];
const ALLOWED_UPDATE_FIELDS = ["start_date", "end_date", "remarks", "status", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

const ASSIGNED_USERS_SUBQUERY = `
  (SELECT string_agg(DISTINCT u_al.name, ', ' ORDER BY u_al.name)
   FROM ${T.AUDIT_LOCATIONS} al_names
   LEFT JOIN ${M.USERS} u_al ON al_names.assigned_user_id = u_al.id
   WHERE al_names.audit_id = am.audit_id)`;

const JOINS = `
  LEFT JOIN ${M.USERS} u_cr ON am.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON am.updated_by = u_up.id
  LEFT JOIN ${M.USERS} u_ap ON am.approved_by = u_ap.id
  LEFT JOIN ${M.USERS} u_dl ON am.deleted_by = u_dl.id
`;

const AUDIT_MASTER_COLUMNS = `
  am.audit_id, am.start_date, am.end_date, am.remarks, am.status,
  am.approved, am.approved_by, am.approved_at,
  am.is_deleted, am.deleted_by, am.deleted_at,
  am.created_by, am.created_at, am.updated_by, am.updated_at
`;

const DEFAULT_FIELDS = [
  AUDIT_MASTER_COLUMNS,
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
  "u_dl.name AS deleted_by_name",
];

const AUDIT_LOCATIONS_JSON = `
  (SELECT json_agg(al_row) FROM (
     SELECT
       al.assignment_id,
       al.audit_id,
       al.location_id,
       al.assigned_user_id,
       al.plan_assigned_user_id,
       al.status,
       al.expected_boxes,
       al.scanned_boxes,
       al.is_active,
       al.reassigned_at,
       al.score_pct,
       al.score_at,
       COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no,
       u_loc.name AS assigned_user_name,
       u_plan.name AS plan_assigned_user_name
     FROM ${T.AUDIT_LOCATIONS} al
     JOIN ${T.LOCATION_MASTER} lm ON al.location_id = lm.location_id
     LEFT JOIN ${M.USERS} u_loc ON al.assigned_user_id = u_loc.id
     LEFT JOIN ${M.USERS} u_plan ON al.plan_assigned_user_id = u_plan.id
     WHERE al.audit_id = am.audit_id
     ORDER BY al.is_active ASC, al.reassigned_at ASC NULLS FIRST,
       NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint ASC NULLS LAST, lm.shelf_no ASC NULLS LAST
   ) al_row)`;

export const findAudits = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {}, user = {} } = options;

  const values = [];
  let i = 1;

  const conditions = ["am.is_deleted = false"];

  // Visibility logic
  if (user.type !== 'super_admin') {
    const canAuthorize = Boolean(permission.can_authorize);
    const canEdit = Boolean(permission.can_edit);
    const canView = Boolean(permission.can_view);

    if (canAuthorize || canEdit || canView) {
      // Management sees all active audits
    } else {
      // Workers: currently assigned locations (active + in date) OR audits they created
      conditions.push(`(
        am.created_by = $${i++}
        OR (
          EXISTS (
            SELECT 1 FROM ${T.AUDIT_LOCATIONS} al_vis
            WHERE al_vis.audit_id = am.audit_id AND al_vis.assigned_user_id = $${i++}
          )
          AND am.approved = true
          AND CURRENT_DATE BETWEEN am.start_date AND am.end_date
        )
      )`);
      values.push(user.id, user.id);
    }
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`am.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`am.created_at <= $${i++}`);
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "status" && val === "pending") {
      values.push("pending", "approved");
      conditions.push(`(am.status = $${i++} OR am.status = $${i++})`);
      continue;
    }

    values.push(val);
    conditions.push(`am.${key} = $${i++}`);
  }

  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    const idx = i++;
    conditions.push(`(
      am.remarks ILIKE $${idx}
      OR ${ASSIGNED_USERS_SUBQUERY} ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${T.AUDIT_MASTER} am ${JOINS} ${where}`, values);
  const count = countRes[0]?.count || 0;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "audit_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  let orderByClause = `am.${sortByField}`;
  if (sortByField === "assigned_user_name") orderByClause = ASSIGNED_USERS_SUBQUERY;

  const dataValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")},
     ${ASSIGNED_USERS_SUBQUERY} AS assigned_user_names,
     ${AUDIT_LOCATIONS_JSON} AS locations
     FROM ${T.AUDIT_MASTER} am
     ${JOINS}
     ${where}
     ORDER BY ${orderByClause} ${sortOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    dataValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit)
  };
};

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
     ${JOINS}
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
  const expectedBoxes = await fetchBoxSnapshotForLocation(locationId, { client });
  const userId = assignedUserId ?? null;
  await run(
    `INSERT INTO ${T.AUDIT_LOCATIONS}
     (audit_id, location_id, assigned_user_id, plan_assigned_user_id, expected_boxes, scanned_boxes, is_active)
     VALUES ($1, $2, $3, $3, $4::jsonb, '[]'::jsonb, true)`,
    [auditId, locationId, userId, JSON.stringify(expectedBoxes)]
  );
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
  const { audit_id, location_id, box_no_uid, scanned_by } = data;

  const locRes = await run(
    `SELECT scanned_boxes FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const merged = mergeScannedBoxes(locRow.scanned_boxes, [box_no_uid], scanned_by);
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_boxes = $3::jsonb
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(merged)]
  );

  return merged.find((row) => row.box_no_uid === String(box_no_uid || "").trim().toUpperCase()) ?? null;
};

export const appendAuditScannedBoxes = async (data, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const { audit_id, location_id, box_no_uids = [], scanned_by } = data;

  const locRes = await run(
    `SELECT scanned_boxes FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const merged = mergeScannedBoxes(locRow.scanned_boxes, box_no_uids, scanned_by);
  const nextStatus = merged.length ? "draft" : "pending";
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_boxes = $3::jsonb,
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
  const allMatched = statuses.every((s) => s === "completed");
  const anyMismatch = statuses.some((s) => s === "mismatch");

  let nextStatus = "pending";
  if (statuses.some((s) => s === "draft")) nextStatus = "in_progress";
  else if (statuses.some((s) => s !== "pending")) nextStatus = "in_progress";
  if (allClosed && allMatched) nextStatus = "verified";
  else if (allClosed && anyMismatch) nextStatus = "submitted";

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
    `SELECT expected_boxes, scanned_boxes, status
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const activeScans = parseScannedBoxes(locRow.scanned_boxes);
  const comparison = compareLocationBoxSets(locRow.expected_boxes, activeScans);
  const nextStatus = resolveLocationStatusAfterScan(comparison, { forceComplete });

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, nextStatus]
  );

  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  if (isLocationClosed(nextStatus)) {
    const locMetaRes = await run(
      `SELECT location_id, assignment_id, assigned_user_id, plan_assigned_user_id, expected_boxes, scanned_boxes
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
    auto_completed: nextStatus === "completed" && comparison.exact,
  };
};

/** @deprecated use countPendingAuditLocations */
export const countIncompleteAuditLocations = countPendingAuditLocations;

export const reopenAuditLocation = async (audit_id, location_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT scanned_boxes, status FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const currentStatus = String(locRow.status || "").toLowerCase();
  if (!isLocationClosed(currentStatus)) {
    throw new Error("Only completed or mismatch locations can be reopened");
  }

  const scanned = parseScannedBoxes(locRow.scanned_boxes);
  const nextStatus = scanned.length > 0 ? "draft" : "pending";

  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3
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
    `SELECT assignment_id, assigned_user_id, plan_assigned_user_id, status, expected_boxes, scanned_boxes
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

  const activeScans = parseScannedBoxes(locRow.scanned_boxes);
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

  const expectedBoxes = parseExpectedBoxes(locRow.expected_boxes);
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
     (audit_id, location_id, assigned_user_id, plan_assigned_user_id, expected_boxes, scanned_boxes, status, is_active)
     VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, 'pending', true)
     RETURNING assignment_id`,
    [
      audit_id,
      location_id,
      nextUserId,
      planUserId,
      JSON.stringify(expectedBoxes),
    ]
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

export const deleteAuditScan = async (audit_id, location_id, box_no_uid, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  const locRes = await run(
    `SELECT scanned_boxes, status FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) return;

  const next = removeScannedBox(locRow.scanned_boxes, box_no_uid);
  const nextStatus = next.length ? "draft" : "pending";
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS}
     SET scanned_boxes = $3::jsonb,
         status = CASE
           WHEN status IN ('completed', 'mismatch') THEN status
           ELSE $4
         END
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id, JSON.stringify(next), nextStatus]
  );

  await syncAuditMasterStatus(audit_id, { client });
};

const normalizeBoxUid = (uid) => String(uid || "").trim().toUpperCase();

function formatBoxCustomer(detail, enrichCtx = null) {
  if (!detail) return "—";
  const name =
    detail.acc_name ||
    (enrichCtx ? resolveAuditBoxAccName(detail, enrichCtx) : null) ||
    resolveBoxAccName(detail);
  if (name && String(name).trim() !== "" && name !== "-") return String(name).trim();
  const code = pickAuditAccCode(detail);
  return code || "—";
}

function formatBoxItem(detail) {
  if (!detail) return "—";
  return detail.item_code || "—";
}

async function enrichExpectedBoxDetails(boxes = [], enrichOpts = null) {
  if (!Array.isArray(boxes) || !boxes.length) return boxes;
  return enrichAuditBoxRows(boxes, enrichOpts);
}

function buildBoxReportRow(uid, detail, auditLocationNo, differenceType, enrichCtx = null) {
  return {
    difference_type: differenceType,
    box_no_uid: uid,
    packing_number: detail?.packing_number ?? "—",
    acc_name: formatBoxCustomer(detail, enrichCtx),
    item_code: formatBoxItem(detail),
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
  const comparison = compareLocationBoxSets(loc?.expected_boxes, loc?.scanned_boxes);
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
       al.expected_boxes,
       al.scanned_boxes,
       COALESCE(al.plan_assigned_user_id, al.assigned_user_id) AS score_user_id,
       al.score_pct,
       al.score_at,
       COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no,
       COALESCE(u_plan.name, u_loc.name) AS assigned_user_name
     FROM ${T.AUDIT_LOCATIONS} al
     JOIN ${T.LOCATION_MASTER} lm ON al.location_id = lm.location_id
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

const buildDifferenceRow = buildBoxReportRow;

export const getAuditComparisonReport = async (audit_id, { locationId = null } = {}) => {
  const audit = await findAudit({ audit_id });
  if (!audit) return null;

  const locations = [];
  const allDifferenceRows = [];
  const { enrichOpts, enrichCtx } = await buildAuditEnrichContext();

  for (const loc of audit.locations || []) {
    if (loc.is_active === false) continue;
    const locId = Number(loc.location_id);
    if (locationId != null && locId !== Number(locationId)) continue;

    const expectedBoxes = await enrichExpectedBoxDetails(parseExpectedBoxes(loc.expected_boxes), enrichOpts);
    const expectedByUid = new Map(
      expectedBoxes.map((b) => [normalizeBoxUid(b.box_no_uid), b]).filter(([uid]) => uid)
    );
    let systemSet;

    if (expectedBoxes.length) {
      systemSet = new Set(expectedBoxes.map((b) => normalizeBoxUid(b.box_no_uid)).filter(Boolean));
    } else {
      const inHandSql = sqlBoxInHand("b");
      const systemRows = await dbQuery(
        `SELECT TRIM(b.box_no_uid::text) AS box_no_uid
         FROM ${T.BOX_TABLE} b
         WHERE b.location_id = $1 AND ${inHandSql}
         ORDER BY b.box_no_uid`,
        [locId]
      );
      systemSet = new Set(systemRows.map((r) => normalizeBoxUid(r.box_no_uid)).filter(Boolean));
    }

    const scannedSet = new Set(
      parseScannedBoxes(loc.scanned_boxes).map((s) => normalizeBoxUid(s.box_no_uid)).filter(Boolean)
    );

    const missing_boxes = [...systemSet].filter((uid) => !scannedSet.has(uid)).sort();
    const extra_boxes = [...scannedSet].filter((uid) => !systemSet.has(uid)).sort();
    const matched_scanned_boxes = [...scannedSet].filter((uid) => systemSet.has(uid)).sort();
    const matched = missing_boxes.length === 0 && extra_boxes.length === 0;

    const lookupUids = [...new Set([...missing_boxes, ...extra_boxes, ...matched_scanned_boxes])];
    const fetchedDetails = await fetchBoxDetailsByUids(lookupUids, { enrichOpts });

    // Prefer live box_table + SA join over frozen expected_boxes (old snapshots lack acc_name).
    const resolveDetail = (uid) => fetchedDetails.get(uid) ?? expectedByUid.get(uid) ?? null;

    const not_scanned_rows = missing_boxes.map((uid) =>
      buildBoxReportRow(uid, resolveDetail(uid), loc.location_no, "not_scanned", enrichCtx)
    );
    const extra_scan_rows = extra_boxes.map((uid) =>
      buildBoxReportRow(uid, resolveDetail(uid), loc.location_no, "extra_scan", enrichCtx)
    );
    const matched_rows = matched_scanned_boxes.map((uid) =>
      buildBoxReportRow(uid, resolveDetail(uid), loc.location_no, "matched_scan", enrichCtx)
    );
    const difference_rows = [...not_scanned_rows, ...extra_scan_rows];

    for (const row of difference_rows) {
      allDifferenceRows.push({ ...row, location_id: locId, audit_location_no: loc.location_no });
    }

    locations.push({
      location_id: locId,
      location_no: loc.location_no,
      location_status: loc.status,
      system_count: systemSet.size,
      scanned_count: scannedSet.size,
      matched_scanned_count: matched_scanned_boxes.length,
      not_scanned_count: missing_boxes.length,
      extra_scan_count: extra_boxes.length,
      matched,
      missing_boxes,
      extra_boxes,
      matched_scanned_boxes,
      matched_rows,
      not_scanned_rows,
      extra_scan_rows,
      mismatch_incomplete: missing_boxes.length > 0,
      mismatch_extra_scans: extra_boxes.length > 0,
      system_boxes: [...systemSet].sort(),
      scanned_boxes: [...scannedSet].sort(),
      expected_box_details: expectedBoxes,
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

const inHandSql = sqlBoxInHand("b");

/** Super-admin: align box_table with audit scans, log transactions, complete locations, verify audit. */
export const applyAuditComparisonAdjustment = async (
  audit_id,
  { locationId = null, userId = null, client = null } = {}
) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const audit = await findAudit({ audit_id });
  if (!audit) throw new Error("Audit not found");

  const report = await getAuditComparisonReport(audit_id, { locationId });
  if (!report?.locations?.length) throw new Error("No locations to adjust");

  const summary = {
    missing_boxes: 0,
    extra_boxes: 0,
    locations_adjusted: 0,
  };

  for (const loc of report.locations) {
    const locId = Number(loc.location_id);
    const missing = loc.missing_boxes || [];
    const extra = loc.extra_boxes || [];
    if (!missing.length && !extra.length) continue;

    const auditLocRes = await run(
      `SELECT assignment_id, assigned_user_id, plan_assigned_user_id, expected_boxes, scanned_boxes
       FROM ${T.AUDIT_LOCATIONS}
       WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
      [audit_id, locId]
    );
    const auditLoc = client ? auditLocRes.rows[0] : auditLocRes[0];
    if (!auditLoc) continue;

    if (missing.length) {
      const removeRes = await run(
        `UPDATE ${T.BOX_TABLE} b
         SET location_id = NULL,
             updated_by = $3,
             updated_at = NOW()
         WHERE b.location_id = $1
           AND TRIM(UPPER(b.box_no_uid::text)) = ANY($2::text[])
           AND b.is_deleted = false
           AND ${inHandSql}
         RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose, b.location_id`,
        [locId, missing.map((u) => normalizeBoxUid(u)), userId]
      );
      const removed = client ? removeRes.rows : removeRes;
      if (removed?.length) {
        summary.missing_boxes += removed.length;
        await logBoxTransaction({
          client,
          transaction_type: BOX_TX_TYPES.AUDIT_MISSING,
          source_module: "audit",
          source_id: String(audit_id),
          packing_number: singlePackingFromRows(removed),
          user_id: userId,
          rows: removed,
          details: {
            audit_id,
            location_id: locId,
            difference_type: "missing",
            reason: "Audit missing — box removed from location after adjustment",
            box_count: removed.length,
          },
        });
      }
    }

    if (extra.length) {
      const extraUids = extra.map((u) => normalizeBoxUid(u));
      const extraRes = await run(
        `UPDATE ${T.BOX_TABLE} b
         SET location_id = $1,
             updated_by = $2,
             updated_at = NOW()
         WHERE TRIM(UPPER(b.box_no_uid::text)) = ANY($3::text[])
           AND b.is_deleted = false
           AND ${inHandSql}
         RETURNING b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.is_loose, b.location_id`,
        [locId, userId, extraUids]
      );
      const extraRows = client ? extraRes.rows : extraRes;
      if (extraRows?.length) {
        summary.extra_boxes += extraRows.length;
        await logBoxTransaction({
          client,
          transaction_type: BOX_TX_TYPES.AUDIT_EXTRA,
          source_module: "audit",
          source_id: String(audit_id),
          packing_number: singlePackingFromRows(extraRows),
          user_id: userId,
          rows: extraRows,
          details: {
            audit_id,
            location_id: locId,
            difference_type: "extra",
            reason: "Audit extra — box assigned to audit location after adjustment",
            box_count: extraRows.length,
          },
        });
      }
    }

    await run(
      `UPDATE ${T.AUDIT_LOCATIONS} SET status = 'completed'
       WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
      [audit_id, locId]
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
export const completeAuditLocation = async (audit_id, location_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const locRes = await run(
    `SELECT expected_boxes, scanned_boxes, status, assignment_id, assigned_user_id, plan_assigned_user_id
     FROM ${T.AUDIT_LOCATIONS}
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );
  const locRow = client ? locRes.rows[0] : locRes[0];
  if (!locRow) throw new Error("Audit location not found");

  const activeScans = parseScannedBoxes(locRow.scanned_boxes);
  const comparison = compareLocationBoxSets(locRow.expected_boxes, activeScans);

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
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = 'completed'
     WHERE audit_id = $1 AND location_id = $2 AND is_active = true`,
    [audit_id, location_id]
  );

  await recordLocationScoreFromComparison(audit_id, locRow, comparison, { client, location_id });
  const auditStatus = await syncAuditMasterStatus(audit_id, { client });

  return {
    location_status: "completed",
    audit_status: auditStatus,
    comparison,
    already_complete: false,
  };
};
