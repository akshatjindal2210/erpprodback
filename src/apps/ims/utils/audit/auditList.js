/**
 * Inventory Audit — list query (fast + readable).
 *
 * Table: ims_audit_master (am)
 * Nested: locations[] JSON (Master + Location tabs)
 *
 * Filters: audit_id, status, approved, created_at range
 * Search:  audit id, remarks, status, creator, location, assignee (EXISTS)
 *
 * Perf:
 * - List omits assigned_user_names SQL — UI builds names from locations[]
 * - COUNT only when result hits page limit (most loads = 1 query)
 */

import dbQuery from "../../../../config/db.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../../../../config/dbTables.js";

const ALLOWED_FILTER_FIELDS = ["audit_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["audit_id", "start_date", "end_date", "status", "created_at"];

const sqlLocationNo = (lm) =>
  `COALESCE(${lm}.location_no, CONCAT(${lm}.rack_no, UPPER(COALESCE(${lm}.shelf_no, ''))))`;

export const ASSIGNED_USERS_SUBQUERY = `
  (SELECT string_agg(DISTINCT u_al.name, ', ' ORDER BY u_al.name)
   FROM ${T.AUDIT_LOCATIONS} al_names
   LEFT JOIN ${M.USERS} u_al ON al_names.assigned_user_id = u_al.id
   WHERE al_names.audit_id = am.audit_id)`;

export const AUDIT_LIST_JOINS = `
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

/** Detail / findAudit — full row + deleted metadata */
export const AUDIT_DEFAULT_SELECT_FIELDS = [
  AUDIT_MASTER_COLUMNS,
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
  "u_dl.name AS deleted_by_name",
];

/** List page — lighter select (no delete columns) */
const AUDIT_LIST_SELECT = [
  "am.audit_id",
  "am.start_date",
  "am.end_date",
  "am.remarks",
  "am.status",
  "am.approved",
  "am.approved_by",
  "am.approved_at",
  "am.created_by",
  "am.created_at",
  "am.updated_by",
  "am.updated_at",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
].join(", ");

export const AUDIT_LOCATIONS_JSON = `
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
       COALESCE(al.result_rejected, false) AS result_rejected,
       ${sqlLocationNo("lm")} AS location_no,
       u_loc.name AS assigned_user_name,
       u_plan.name AS plan_assigned_user_name
     FROM ${T.AUDIT_LOCATIONS} al
     JOIN ${T.LOCATION_MASTER} lm ON al.location_id = lm.location_id
     LEFT JOIN ${M.USERS} u_loc ON al.assigned_user_id = u_loc.id
     LEFT JOIN ${M.USERS} u_plan ON al.plan_assigned_user_id = u_plan.id
     WHERE al.audit_id = am.audit_id
     ORDER BY al.is_active ASC, al.reassigned_at ASC NULLS FIRST,
       NULLIF(regexp_replace(lm.rack_no, '\\D', '', 'g'), '')::bigint ASC NULLS LAST,
       lm.shelf_no ASC NULLS LAST
   ) al_row)`;

function nextParam(values, val) {
  values.push(val);
  return values.length;
}

function applyVisibility(user, permission, conditions, values) {
  if (user?.type === "super_admin") return;

  const isManager = Boolean(permission?.can_authorize || permission?.can_edit || permission?.can_view);
  if (isManager) return;

  const creatorIdx = nextParam(values, user.id);
  const assigneeIdx = nextParam(values, user.id);
  conditions.push(`(
    am.created_by = $${creatorIdx}
    OR (
      EXISTS (
        SELECT 1 FROM ${T.AUDIT_LOCATIONS} al_vis
        WHERE al_vis.audit_id = am.audit_id AND al_vis.assigned_user_id = $${assigneeIdx}
      )
      AND am.approved = true
      AND CURRENT_DATE BETWEEN am.start_date AND am.end_date
    )
  )`);
}

function applyFilters(filters, conditions, values) {
  for (const [key, rawVal] of Object.entries(filters)) {
    if (rawVal === undefined || rawVal === null || rawVal === "") continue;

    if (key === "from_date" || key === "fromDate") {
      conditions.push(`am.created_at >= $${nextParam(values, rawVal)}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      conditions.push(`am.created_at <= $${nextParam(values, rawVal)}`);
      continue;
    }
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "status" && rawVal === "pending") {
      const a = nextParam(values, "pending");
      const b = nextParam(values, "approved");
      conditions.push(`(am.status = $${a} OR am.status = $${b})`);
      continue;
    }

    conditions.push(`am.${key} = $${nextParam(values, rawVal)}`);
  }
}

/** EXISTS search — faster than string_agg ILIKE on every row */
function applySearch(search, conditions, values) {
  const q = search != null ? String(search).trim() : "";
  if (!q) return false;

  const idx = nextParam(values, `%${q}%`);
  const locLabel = sqlLocationNo("lm_s");

  conditions.push(`(
    am.audit_id::text ILIKE $${idx}
    OR am.remarks ILIKE $${idx}
    OR am.status ILIKE $${idx}
    OR u_cr.name ILIKE $${idx}
    OR u_ap.name ILIKE $${idx}
    OR EXISTS (
      SELECT 1
      FROM ${T.AUDIT_LOCATIONS} al_s
      JOIN ${T.LOCATION_MASTER} lm_s ON al_s.location_id = lm_s.location_id
      LEFT JOIN ${M.USERS} u_s ON al_s.assigned_user_id = u_s.id
      LEFT JOIN ${M.USERS} u_plan ON al_s.plan_assigned_user_id = u_plan.id
      WHERE al_s.audit_id = am.audit_id
        AND (
          ${locLabel} ILIKE $${idx}
          OR u_s.name ILIKE $${idx}
          OR u_plan.name ILIKE $${idx}
        )
    )
  )`);
  return true;
}

function buildListWhere({ filters = {}, search, permission = {}, user = {} }) {
  const values = [];
  const conditions = ["am.is_deleted = false"];

  applyVisibility(user, permission, conditions, values);
  applyFilters(filters, conditions, values);
  const needsUserJoins = applySearch(search, conditions, values);

  return { whereClause: `WHERE ${conditions.join(" AND ")}`, values, needsUserJoins };
}

async function countAudits(whereClause, values, needsUserJoins) {
  const joins = needsUserJoins ? AUDIT_LIST_JOINS : "";
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM ${T.AUDIT_MASTER} am ${joins} ${whereClause}`,
    values
  );
  return Number(count) || 0;
}

export async function findAudits(options = {}) {
  const {
    filters = {},
    search,
    sort = {},
    page = 1,
    limit = 10,
    fields = [],
    permission = {},
    user = {},
  } = options;

  const { whereClause, values, needsUserJoins } = buildListWhere({
    filters,
    search,
    permission,
    user,
  });

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortBy = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "audit_id";
  const sortOrder = sort.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const selectCore = fields.length ? fields.join(", ") : AUDIT_LIST_SELECT;

  const rows = await dbQuery(
    `SELECT ${selectCore},
       ${AUDIT_LOCATIONS_JSON} AS locations
     FROM ${T.AUDIT_MASTER} am
     ${AUDIT_LIST_JOINS}
     ${whereClause}
     ORDER BY am.${sortBy} ${sortOrder}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  let total = rows.length;
  if (rows.length >= safeLimit || safePage > 1) {
    total = await countAudits(whereClause, values, needsUserJoins);
  }

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}
