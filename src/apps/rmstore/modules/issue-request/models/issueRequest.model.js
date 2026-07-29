import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.ISSUE_REQUEST;

function normalizeJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export const findIssueRequests = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false"];

  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`r.approved = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`r.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`r.created_at <= $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(r.item_code,'') ILIKE $${idx} OR
      COALESCE(r.item_desc,'') ILIKE $${idx} OR
      COALESCE(r.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(r.rm_item_desc,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.shift,'') ILIKE $${idx} OR
      COALESCE(r.job_cards::text,'') ILIKE $${idx} OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT r.*,
            r.created_by AS created_by_name,
            r.approved_by AS approved_by_name
     FROM ${TABLE} r
     ${where}
     ORDER BY r.issue_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findIssueRequest = async (issue_uid) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT r.*,
            r.created_by AS created_by_name,
            r.approved_by AS approved_by_name
     FROM ${TABLE} r
     WHERE r.issue_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row ?? null;
};

export const findIssueRequestCoils = async (issue_uid) => {
  const row = await findIssueRequest(issue_uid);
  if (!row) return [];
  return normalizeJsonArray(row.coils).map((c) => ({
    ...c,
    issue_uid: Number(issue_uid),
    coil_no_uid: String(c?.coil_no_uid || "").trim(),
    qty: c?.qty ?? 0,
  }));
};

export const findIssueRequestJobCards = async (issue_uid) => {
  const row = await findIssueRequest(issue_uid);
  if (!row) return [];
  return normalizeJsonArray(row.job_cards);
};

/**
 * Guarded numeric cast — job_cards JSONB may hold numbers, numeric strings or nulls.
 * Written without `?` because dbQuery rewrites `?` into positional placeholders.
 */
const JC_ISSUE_QTY = `CASE
    WHEN jsonb_typeof(jc->'issue_qty') = 'number'
      THEN (jc->>'issue_qty')::numeric
    WHEN jsonb_typeof(jc->'issue_qty') = 'string'
         AND jc->>'issue_qty' ~ '^[-]{0,1}[0-9]+([.][0-9]+){0,1}$'
      THEN (jc->>'issue_qty')::numeric
    ELSE 0
  END`;

/**
 * Sum already-requested qty per job card across all saved issue requests.
 * @param {string[]} jobCardNos
 * @param {{ excludeIssueUid?: number|null }} options exclude the request being edited
 */
export const findIssuedQtyByJobCards = async (jobCardNos = [], { excludeIssueUid = null } = {}) => {
  const keys = [
    ...new Set(
      (jobCardNos || []).map((v) => String(v ?? "").trim().toUpperCase()).filter(Boolean)
    ),
  ];
  if (!keys.length) return [];

  const values = [keys];
  let i = 2;
  let excludeClause = "";
  const exclude = Number(excludeIssueUid);
  if (Number.isFinite(exclude) && exclude > 0) {
    values.push(exclude);
    excludeClause = `AND r.issue_uid <> $${i++}`;
  }

  return dbQuery(
    `SELECT UPPER(TRIM(jc->>'pjobcardno')) AS pjobcardno,
            COALESCE(SUM(${JC_ISSUE_QTY}), 0)::float8 AS issued_qty,
            COALESCE(SUM(${JC_ISSUE_QTY}) FILTER (WHERE r.approved = true), 0)::float8 AS approved_qty,
            COUNT(*)::int AS request_count,
            MAX(r.issue_uid)::int AS last_issue_uid
     FROM ${TABLE} r
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(r.job_cards) = 'array' THEN r.job_cards ELSE '[]'::jsonb END
     ) AS jc
     WHERE r.is_deleted = false
       ${excludeClause}
       AND UPPER(TRIM(jc->>'pjobcardno')) = ANY($1::text[])
     GROUP BY 1`,
    values
  );
};

export const insertIssueRequest = async (data) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (production_id, item_dcode, item_code, item_desc, rm_item_dcode, rm_item_code, rm_item_desc,
      requested_qty, total_qty, coil_count, job_cards, shift, remarks, approved, approved_by, approved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      data.production_id ?? null,
      data.item_dcode ?? null,
      data.item_code ?? null,
      data.item_desc ?? null,
      data.rm_item_dcode ?? null,
      data.rm_item_code ?? null,
      data.rm_item_desc ?? null,
      data.requested_qty ?? 0,
      data.total_qty ?? 0,
      data.coil_count ?? 0,
      JSON.stringify(data.job_cards || []),
      data.shift === "B" ? "B" : "A",
      data.remarks ?? null,
      data.approved === true,
      data.approved_by ?? null,
      data.approved_at ?? null,
      data.created_by ?? null,
    ]
  );
  return row;
};

export const replaceIssueRequestCoils = async (issue_uid, coils = []) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return [];
  const payload = (coils || [])
    .map((c) => ({
      coil_no_uid: String(c?.coil_no_uid || "").trim(),
      qty: c?.qty ?? 0,
      item_code: c?.item_code ?? null,
      heat_no: c?.heat_no ?? null,
      mrn_no: c?.mrn_no ?? null,
      pjobcardno: c?.pjobcardno ?? null,
    }))
    .filter((c) => c.coil_no_uid);
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET coils = $2::jsonb, updated_at = NOW()
     WHERE issue_uid = $1 AND is_deleted = false
     RETURNING coils`,
    [id, JSON.stringify(payload)]
  );
  return normalizeJsonArray(row?.coils).map((c) => ({ ...c, issue_uid: id }));
};

export const updateIssueRequest = async (issue_uid, fields = {}) => {
  const allowed = [
    "production_id", "item_dcode", "item_code", "item_desc",
    "rm_item_dcode", "rm_item_code", "rm_item_desc",
    "requested_qty", "total_qty", "coil_count", "job_cards", "shift", "remarks",
    "approved", "approved_by", "approved_at", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  if (safe.job_cards !== undefined) {
    safe.job_cards = JSON.stringify(safe.job_cards || []);
  }
  if (safe.shift !== undefined) {
    safe.shift = safe.shift === "B" ? "B" : "A";
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findIssueRequest(issue_uid);
  const values = Object.values(safe);
  values.push(Number(issue_uid));
  const setClause = keys
    .map((k, i) => (k === "job_cards" ? `${k} = $${i + 1}::jsonb` : `${k} = $${i + 1}`))
    .join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE issue_uid = $${keys.length + 1} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteIssueRequest = async (issue_uid, deleted_by = null) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE issue_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};
