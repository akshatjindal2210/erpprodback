import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";

const TABLE = M.NOTIFICATION_TEMPLATES;

export const TRIGGER_EVENTS = ["add", "edit", "delete", "approve"];
export const RECIPIENT_TYPES = ["attribute", "role", "department", "designation", "user"];
export const SEND_VIA_OPTIONS = ["none", "free", "paid"];
export const AUDIENCE_KEYS = ["departments", "designations", "attributes", "roles", "users"];

const ALLOWED_SORT_FIELDS = ["id", "module_id", "name", "is_active", "created_at", "updated_at"];
const ALLOWED_UPDATE_FIELDS = [
  "module_id", "name", "subject", "message", "trigger_events", "recipient_type", "recipient_refs",
  "audience", "pwa_enabled", "email_enabled", "send_via", "is_active", "updated_by", "updated_at",
];
const ARRAY_FIELDS = new Set(["trigger_events", "recipient_refs"]);
const JSON_FIELDS = new Set(["audience"]);

const NT_FROM = `
  FROM ${TABLE} nt
  JOIN ${M.MODULES} m ON m.id = nt.module_id
`;

const namesOf = (table) => `(SELECT string_agg(x.name, ', ' ORDER BY x.name) FROM ${table} x WHERE x.id::text = ANY(nt.recipient_refs))`;

const NT_SELECT = `
  SELECT nt.*,
         m.name AS module_name,
         m.label AS module_label,
         m.app_type AS module_app_type,
         CASE nt.recipient_type
           WHEN 'attribute'   THEN ${namesOf(M.ATTRIBUTES)}
           WHEN 'department'  THEN ${namesOf(M.DEPARTMENTS)}
           WHEN 'designation' THEN ${namesOf(M.DESIGNATIONS)}
           WHEN 'user'        THEN ${namesOf(M.USERS)}
           ELSE array_to_string(nt.recipient_refs, ', ')
         END AS recipient_label,
         nt.created_by AS created_by_name,
         nt.updated_by AS updated_by_name
`;

const assertField = (key, list, ctx = "field") => {
  if (!list.includes(key)) throw new Error(`Invalid ${ctx}: "${key}"`);
};

/** Empty dim = skipped. `all: true` = no id filter. `ids` = specific. */
export function normalizeAudienceDim(raw) {
  if (!raw || typeof raw !== "object") return { all: false, ids: [] };
  const all = !!raw.all;
  const list = Array.isArray(raw.ids) ? raw.ids : Array.isArray(raw.refs) ? raw.refs : [];
  const ids = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
  return { all, ids: all ? [] : ids };
}

export function normalizeAudience(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    departments: normalizeAudienceDim(src.departments),
    designations: normalizeAudienceDim(src.designations),
    attributes: normalizeAudienceDim(src.attributes),
    roles: normalizeAudienceDim(src.roles),
    users: normalizeAudienceDim(src.users),
  };
}

export function isAudienceDimActive(dim) {
  return !!(dim && (dim.all || (Array.isArray(dim.ids) && dim.ids.length > 0)));
}

export function audienceHasAny(audience) {
  const a = normalizeAudience(audience);
  return AUDIENCE_KEYS.some((k) => isAudienceDimActive(a[k]));
}

/** Build legacy single-type fields from audience (first active dim) for older display paths. */
export function legacyFromAudience(audience) {
  const a = normalizeAudience(audience);
  const order = [
    ["departments", "department"],
    ["designations", "designation"],
    ["attributes", "attribute"],
    ["roles", "role"],
    ["users", "user"],
  ];
  for (const [key, type] of order) {
    const dim = a[key];
    if (!isAudienceDimActive(dim)) continue;
    return { recipient_type: type, recipient_refs: dim.all ? ["*"] : dim.ids.map(String) };
  }
  return { recipient_type: null, recipient_refs: [] };
}

/** Upgrade old rows that only have recipient_type + recipient_refs. */
export function audienceFromLegacy(recipient_type, recipient_refs) {
  const refs = Array.isArray(recipient_refs) ? recipient_refs.map(String) : [];
  const empty = normalizeAudience({});
  if (!recipient_type || !refs.length) return empty;
  const map = {
    department: "departments",
    designation: "designations",
    attribute: "attributes",
    role: "roles",
    user: "users",
  };
  const key = map[recipient_type];
  if (!key) return empty;
  empty[key] = { all: refs.includes("*"), ids: refs.filter((r) => r !== "*") };
  return empty;
}

export function effectiveAudience(row) {
  if (row?.audience && typeof row.audience === "object" && audienceHasAny(row.audience)) {
    return normalizeAudience(row.audience);
  }
  return audienceFromLegacy(row?.recipient_type, row?.recipient_refs);
}

export const findNotificationTemplates = async ({
  filters = {},
  search,
  sort = { by: "id", order: "DESC" },
  page = 1,
  limit = 500,
} = {}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(5000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;
  const safeSortBy = ALLOWED_SORT_FIELDS.includes(sort?.by) ? sort.by : "id";
  const safeOrder = sort?.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const values = [];
  const where = ["nt.is_deleted = false"];

  if (filters.id != null) {
    values.push(filters.id);
    where.push(`nt.id = $${values.length}`);
  }
  if (filters.module_id != null && filters.module_id !== "") {
    values.push(filters.module_id);
    where.push(`nt.module_id = $${values.length}`);
  }
  if (filters.app_type) {
    values.push(String(filters.app_type).toLowerCase());
    where.push(`LOWER(m.app_type) = $${values.length}`);
  }
  if (filters.is_active !== undefined && filters.is_active !== "" && filters.is_active !== null) {
    values.push(filters.is_active === true || filters.is_active === "true");
    where.push(`nt.is_active = $${values.length}`);
  }
  if (filters.trigger_event && TRIGGER_EVENTS.includes(filters.trigger_event)) {
    values.push(filters.trigger_event);
    where.push(`$${values.length} = ANY(nt.trigger_events)`);
  }
  if (filters.recipient_type && RECIPIENT_TYPES.includes(filters.recipient_type)) {
    values.push(filters.recipient_type);
    where.push(`nt.recipient_type = $${values.length}`);
  }
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    const p = `$${values.length}`;
    where.push(`(nt.name ILIKE ${p} OR nt.message ILIKE ${p} OR m.label ILIKE ${p} OR m.name ILIKE ${p})`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [countRow] = await dbQuery(`SELECT COUNT(*)::int AS count ${NT_FROM} ${whereSql}`, values);
  const totalCount = countRow?.count ?? 0;

  const data = await dbQuery(
    `${NT_SELECT} ${NT_FROM} ${whereSql}
     ORDER BY nt.${safeSortBy} ${safeOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, offset]
  );

  return {
    data: data.map((row) => ({ ...row, audience: effectiveAudience(row) })),
    total_count: totalCount,
    current_page: safePage,
    last_page: Math.ceil(totalCount / safeLimit) || 1,
  };
};

export const findNotificationTemplate = async (id) => {
  const [row] = await dbQuery(
    `${NT_SELECT} ${NT_FROM} WHERE nt.is_deleted = false AND nt.id = $1 LIMIT 1`,
    [id]
  );
  if (!row) return null;
  return { ...row, audience: effectiveAudience(row) };
};

/**
 * SOP-style uniqueness: one live template per module + trigger event.
 * `excludeId` skips the row being updated.
 */
export const findConflictingTemplate = async (module_id, trigger_events = [], excludeId = null) => {
  const events = Array.isArray(trigger_events) ? trigger_events.filter(Boolean) : [];
  if (!module_id || !events.length) return null;
  const values = [module_id, events];
  let excludeSql = "";
  if (excludeId != null) {
    values.push(excludeId);
    excludeSql = ` AND nt.id <> $${values.length}`;
  }
  const [row] = await dbQuery(
    `SELECT nt.id, nt.name, nt.trigger_events
     FROM ${TABLE} nt
     WHERE nt.is_deleted = false
       AND nt.module_id = $1
       AND nt.trigger_events && $2::text[]
       ${excludeSql}
     ORDER BY nt.id ASC
     LIMIT 1`,
    values
  );
  return row ?? null;
};

/** Active templates for module id (module notify dispatcher). */
export const findActiveTemplatesByModuleId = async (moduleId) => {
  const id = Number(moduleId);
  if (!Number.isFinite(id) || id <= 0) return [];
  return dbQuery(
    `SELECT nt.*, m.id AS module_id, m.name AS module_name, m.label AS module_label, m.app_type AS module_app_type
     FROM ${TABLE} nt
     JOIN ${M.MODULES} m ON m.id = nt.module_id
     WHERE nt.module_id = $1 AND nt.is_active = true AND nt.is_deleted = false
     ORDER BY nt.id ASC`,
    [id]
  ).then((rows) => rows.map((row) => ({ ...row, audience: effectiveAudience(row) })));
};

export const insertNotificationTemplate = async ({
  module_id,
  name,
  subject,
  message,
  trigger_events,
  recipient_type,
  recipient_refs,
  audience,
  pwa_enabled = true,
  email_enabled = false,
  send_via = "none",
  is_active = true,
  created_by,
}) => {
  const aud = normalizeAudience(audience);
  const legacy = legacyFromAudience(aud);
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
      (module_id, name, subject, message, trigger_events, recipient_type, recipient_refs,
       audience, pwa_enabled, email_enabled, send_via, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8::jsonb, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      module_id, name, subject ?? null, message, trigger_events,
      recipient_type ?? legacy.recipient_type,
      (recipient_refs ?? legacy.recipient_refs).map(String),
      JSON.stringify(aud),
      !!pwa_enabled, !!email_enabled, send_via, !!is_active, created_by,
    ]
  );
  return row;
};

export const updateNotificationTemplate = async (id, fields = {}) => {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  for (const k of keys) assertField(k, ALLOWED_UPDATE_FIELDS, "update field");

  const values = [];
  const setParts = keys.map((key) => {
    values.push(fields[key]);
    const idx = values.length;
    if (ARRAY_FIELDS.has(key)) return `${key} = $${idx}::text[]`;
    if (JSON_FIELDS.has(key)) return `${key} = $${idx}::jsonb`;
    return `${key} = $${idx}`;
  });

  // Serialize audience object for jsonb
  const audIdx = keys.indexOf("audience");
  if (audIdx >= 0 && values[audIdx] != null && typeof values[audIdx] === "object") {
    values[audIdx] = JSON.stringify(normalizeAudience(values[audIdx]));
  }

  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE id = $${keys.length + 1} AND is_deleted = false
     RETURNING *`,
    [...values, id]
  );
  return row ?? null;
};

export const deleteNotificationTemplate = async (id, { deleted_by } = {}) => {
  const rows = await dbQuery(
    `UPDATE ${TABLE} SET is_deleted = true, is_active = false, deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND is_deleted = false
     RETURNING id`,
    [id, deleted_by ?? null]
  );
  return rows.length > 0;
};
