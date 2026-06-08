import dbQuery from "../../../config/db.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../../../config/dbTables.js";
import { sqlBoxInHand } from "../utils/boxInventorySql.js";

const ALLOWED_FILTER_FIELDS = ["audit_id", "assigned_user_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["audit_id", "start_date", "end_date", "status", "created_at", "assigned_user_name"];
const ALLOWED_UPDATE_FIELDS = ["assigned_user_id", "start_date", "end_date", "remarks", "status", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

const JOINS = `
  LEFT JOIN ${M.USERS} u_as ON am.assigned_user_id = u_as.id
  LEFT JOIN ${M.USERS} u_cr ON am.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON am.updated_by = u_up.id
  LEFT JOIN ${M.USERS} u_ap ON am.approved_by = u_ap.id
  LEFT JOIN ${M.USERS} u_dl ON am.deleted_by = u_dl.id
`;

const DEFAULT_FIELDS = [
  "am.*",
  "u_as.name AS assigned_user_name",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
  "u_dl.name AS deleted_by_name"
];

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
      // Management/Viewers can see all non-deleted audits
    } else {
      // Regular users (usually with only 'add' power) only see:
      // 1. Audits they created themselves
      // 2. Audits assigned to them that are APPROVED and either:
      //    a) Already started/submitted/verified
      //    b) Currently within the scheduled date range
      conditions.push(`(
        am.created_by = $${i++} OR 
        (
          am.assigned_user_id = $${i++} AND 
          am.approved = true AND 
          (
            am.status IN ('in_progress', 'submitted', 'verified') OR 
            CURRENT_DATE BETWEEN am.start_date AND am.end_date
          )
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
    conditions.push(`(am.remarks ILIKE $${idx} OR u_as.name ILIKE $${idx})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${T.AUDIT_MASTER} am ${JOINS} ${where}`, values);
  const count = countRes[0]?.count || 0;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "audit_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  let orderByClause;
  switch (sortByField) {
    case "assigned_user_name": orderByClause = "u_as.name"; break;
    default: orderByClause = `am.${sortByField}`;
  }

  const dataValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")},
     (SELECT json_agg(al) FROM (
       SELECT al.*, COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
       FROM ${T.AUDIT_LOCATIONS} al
       JOIN ${T.LOCATION_MASTER} lm ON al.location_id = lm.location_id
       WHERE al.audit_id = am.audit_id
       ORDER BY NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint ASC NULLS LAST, lm.shelf_no ASC NULLS LAST
     ) al) AS locations
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
     (SELECT json_agg(al) FROM (
       SELECT al.*, COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
       FROM ${T.AUDIT_LOCATIONS} al
       JOIN ${T.LOCATION_MASTER} lm ON al.location_id = lm.location_id
       WHERE al.audit_id = am.audit_id
       ORDER BY NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint ASC NULLS LAST, lm.shelf_no ASC NULLS LAST
     ) al) AS locations
     FROM ${T.AUDIT_MASTER} am
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  if (row) {
    row.scans = await dbQuery(
      `SELECT ascan.*, COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
       FROM ${T.AUDIT_SCANS} ascan
       JOIN ${T.LOCATION_MASTER} lm ON ascan.location_id = lm.location_id
       WHERE ascan.audit_id = $1`,
      [row.audit_id]
    );
  }

  return row ?? null;
};

export const insertAudit = async (data, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const { assigned_user_id, start_date, end_date, remarks, created_by, location_ids = [] } = data;

  const res = await run(
    `INSERT INTO ${T.AUDIT_MASTER}
     (assigned_user_id, start_date, end_date, remarks, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [assigned_user_id, start_date, end_date, remarks, created_by]
  );
  const row = client ? res.rows[0] : res[0];

  if (location_ids.length) {
    for (const locId of location_ids) {
      await run(
        `INSERT INTO ${T.AUDIT_LOCATIONS} (audit_id, location_id) VALUES ($1, $2)`,
        [row.audit_id, locId]
      );
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

  if (fields.location_ids) {
    await run(`DELETE FROM ${T.AUDIT_LOCATIONS} WHERE audit_id = $1`, [row.audit_id]);
    for (const locId of fields.location_ids) {
      await run(
        `INSERT INTO ${T.AUDIT_LOCATIONS} (audit_id, location_id) VALUES ($1, $2)`,
        [row.audit_id, locId]
      );
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

  // Check if already scanned
  const existing = await run(
    `SELECT scan_id FROM ${T.AUDIT_SCANS} WHERE audit_id = $1 AND location_id = $2 AND box_no_uid = $3`,
    [audit_id, location_id, box_no_uid]
  );
  const existingRow = client ? existing.rows[0] : existing[0];
  if (existingRow) return existingRow;

  const res = await run(
    `INSERT INTO ${T.AUDIT_SCANS} (audit_id, location_id, box_no_uid, scanned_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [audit_id, location_id, box_no_uid, scanned_by]
  );
  return client ? res.rows[0] : res[0];
};

export const updateAuditLocationStatus = async (audit_id, location_id, status, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  await run(
    `UPDATE ${T.AUDIT_LOCATIONS} SET status = $3 WHERE audit_id = $1 AND location_id = $2`,
    [audit_id, location_id, status]
  );
};

export const countIncompleteAuditLocations = async (audit_id, { client = null } = {}) => {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(
    `SELECT COUNT(*)::int AS count FROM ${T.AUDIT_LOCATIONS} WHERE audit_id = $1 AND status != 'completed'`,
    [audit_id]
  );
  const row = client ? res.rows[0] : res[0];
  return row?.count ?? 0;
};

export const deleteAuditScan = async (audit_id, location_id, box_no_uid) => {
  await dbQuery(
    `DELETE FROM ${T.AUDIT_SCANS} WHERE audit_id = $1 AND location_id = $2 AND box_no_uid = $3`,
    [audit_id, location_id, box_no_uid]
  );
};

const normalizeBoxUid = (uid) => String(uid || "").trim().toUpperCase();

export const getAuditComparisonReport = async (audit_id) => {
  const audit = await findAudit({ audit_id });
  if (!audit) return null;

  const scansByLoc = {};
  for (const scan of audit.scans || []) {
    const locId = Number(scan.location_id);
    const uid = normalizeBoxUid(scan.box_no_uid);
    if (!Number.isFinite(locId) || !uid) continue;
    if (!scansByLoc[locId]) scansByLoc[locId] = new Set();
    scansByLoc[locId].add(uid);
  }

  const inHandSql = sqlBoxInHand("b");
  const locations = [];

  for (const loc of audit.locations || []) {
    const locId = Number(loc.location_id);
    const systemRows = await dbQuery(
      `SELECT TRIM(b.box_no_uid::text) AS box_no_uid
       FROM ${T.BOX_TABLE} b
       WHERE b.location_id = $1 AND ${inHandSql}
       ORDER BY b.box_no_uid`,
      [locId]
    );

    const systemSet = new Set(
      systemRows.map((r) => normalizeBoxUid(r.box_no_uid)).filter(Boolean)
    );
    const scannedSet = scansByLoc[locId] || new Set();

    const missing_boxes = [...systemSet].filter((uid) => !scannedSet.has(uid)).sort();
    const extra_boxes = [...scannedSet].filter((uid) => !systemSet.has(uid)).sort();
    const matched_scanned_boxes = [...scannedSet].filter((uid) => systemSet.has(uid)).sort();
    const matched = missing_boxes.length === 0 && extra_boxes.length === 0;

    locations.push({
      location_id: locId,
      location_no: loc.location_no,
      location_status: loc.status,
      system_count: systemSet.size,
      scanned_count: scannedSet.size,
      matched_scanned_count: matched_scanned_boxes.length,
      matched,
      missing_boxes,
      extra_boxes,
      matched_scanned_boxes,
      mismatch_incomplete: missing_boxes.length > 0,
      mismatch_extra_scans: extra_boxes.length > 0,
      system_boxes: [...systemSet].sort(),
      scanned_boxes: [...scannedSet].sort(),
    });
  }

  return {
    audit_id: audit.audit_id,
    status: audit.status,
    locations,
    summary: {
      total_locations: locations.length,
      matched_locations: locations.filter((l) => l.matched).length,
      mismatched_locations: locations.filter((l) => !l.matched).length,
    },
  };
};
