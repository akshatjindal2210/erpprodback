import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { findActiveJobCardsByIssueUid, jobCardRowToApi, softDeleteJobCardsByIssueUid } from "./issueRequestJobCard.model.js";

const TABLE = T.ISSUE_REQUEST;
const JC_TABLE = T.ISSUE_REQUEST_JOB_CARD;
const COIL = T.COIL_TABLE;

const MASTER_COLUMNS = `
  r.issue_uid,
  r.shift,
  r.remarks,
  r.requested_qty,
  r.coil_count,
  r.out_entry_locked,
  r.out_entry_locked_by,
  r.out_entry_locked_at,
  r.approved,
  r.approved_by,
  r.approved_at,
  r.is_deleted,
  r.deleted_by,
  r.deleted_at,
  r.created_by,
  r.created_at,
  r.updated_by,
  r.updated_at
`;

/** Aggregate job-card rows for master list / get-by-id (replaces legacy master JSONB). */
const JC_AGG_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(jsonb_agg(
        jsonb_build_object(
          'pjobcardno', jc.pjobcardno,
          'issue_qty', jc.issue_qty,
          'planqty', jc.planqty,
          'macname', jc.macname,
          'pldt', jc.pldt,
          'item_code', jc.item_code,
          'item_desc', jc.item_desc,
          'rm_item_code', jc.rm_item_code,
          'rm_item_desc', jc.rm_item_desc
        ) ORDER BY jc.id
      ), '[]'::jsonb) AS job_cards,
      (array_agg(jc.item_code ORDER BY jc.id))[1] AS item_code,
      (array_agg(jc.item_desc ORDER BY jc.id))[1] AS item_desc,
      (array_agg(jc.rm_item_code ORDER BY jc.id))[1] AS rm_item_code,
      (array_agg(jc.rm_item_desc ORDER BY jc.id))[1] AS rm_item_desc,
      (array_agg(jc.production_id ORDER BY jc.id))[1] AS production_id
    FROM ${JC_TABLE} jc
    WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
  ) jc_agg ON true
`;

const MASTER_STORE_OUT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE TRIM(c.coil->>'coil_no_uid') <> '')::int AS assigned_coil_count,
      COUNT(*) FILTER (
        WHERE TRIM(c.coil->>'coil_no_uid') <> ''
          AND EXISTS (
            SELECT 1 FROM ${COIL} ct
            WHERE ct.is_deleted = false
              AND LOWER(TRIM(ct.coil_no_uid)) = LOWER(TRIM(c.coil->>'coil_no_uid'))
              AND ct.out_uid IS NOT NULL
          )
      )::int AS out_coil_count
    FROM ${JC_TABLE} jc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS c(coil)
    WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
  ) st ON true
`;

const JC_STORE_OUT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE TRIM(c.coil->>'coil_no_uid') <> '')::int AS assigned_coil_count,
      COUNT(*) FILTER (
        WHERE TRIM(c.coil->>'coil_no_uid') <> ''
          AND EXISTS (
            SELECT 1 FROM ${COIL} ct
            WHERE ct.is_deleted = false
              AND LOWER(TRIM(ct.coil_no_uid)) = LOWER(TRIM(c.coil->>'coil_no_uid'))
              AND ct.out_uid IS NOT NULL
          )
      )::int AS out_coil_count
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS c(coil)
  ) jst ON true
`;

function applyIssueRequestListFilters(filters = {}, conditions, values, { iRef, statsAlias = "st" } = {}) {
  let i = iRef.value;

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
  if (filters.out_entry_locked !== undefined && filters.out_entry_locked !== null && filters.out_entry_locked !== "") {
    const locked = filters.out_entry_locked === true || filters.out_entry_locked === "true";
    conditions.push(`COALESCE(r.out_entry_locked, false) = ${locked ? "true" : "false"}`);
  }
  if (filters.out_entry_complete === true || filters.out_entry_complete === "true") {
    conditions.push(
      `(COALESCE(${statsAlias}.assigned_coil_count, 0) > 0 AND COALESCE(${statsAlias}.out_coil_count, 0) >= COALESCE(${statsAlias}.assigned_coil_count, 0))`
    );
  } else if (filters.out_entry_complete === false || filters.out_entry_complete === "false") {
    conditions.push(
      `NOT (COALESCE(${statsAlias}.assigned_coil_count, 0) > 0 AND COALESCE(${statsAlias}.out_coil_count, 0) >= COALESCE(${statsAlias}.assigned_coil_count, 0))`
    );
  }

  iRef.value = i;
  return iRef;
}

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

function mapMasterRow(row) {
  if (!row) return null;
  return {
    ...row,
    job_cards: normalizeJsonArray(row.job_cards),
  };
}

export const findIssueRequests = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  const iRef = { value: 1 };
  const conditions = ["r.is_deleted = false"];

  applyIssueRequestListFilters(filters, conditions, values, { iRef, statsAlias: "st" });
  let i = iRef.value;

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc_agg.item_code,'') ILIKE $${idx} OR
      COALESCE(jc_agg.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc_agg.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc_agg.rm_item_desc,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.shift,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${JC_TABLE} jc_s
        WHERE jc_s.issue_uid = r.issue_uid
          AND jc_s.is_deleted = false
          AND (
            COALESCE(jc_s.pjobcardno,'') ILIKE $${idx} OR
            COALESCE(jc_s.item_code,'') ILIKE $${idx} OR
            COALESCE(jc_s.item_desc,'') ILIKE $${idx}
          )
      ) OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const fromClause = `FROM ${TABLE} r ${JC_AGG_JOIN} ${MASTER_STORE_OUT_JOIN}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT ${MASTER_COLUMNS},
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name,
            r.out_entry_locked_by AS out_entry_locked_by_name,
            jc_agg.job_cards,
            jc_agg.item_code,
            jc_agg.item_desc,
            jc_agg.rm_item_code,
            jc_agg.rm_item_desc,
            jc_agg.production_id,
            COALESCE(st.assigned_coil_count, 0)::int AS assigned_coil_count,
            COALESCE(st.out_coil_count, 0)::int AS store_out_coil_count,
            (COALESCE(st.assigned_coil_count, 0) > 0
              AND COALESCE(st.out_coil_count, 0) >= COALESCE(st.assigned_coil_count, 0)) AS out_entry_complete
     ${fromClause}
     ${where}
     ORDER BY r.issue_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows.map(mapMasterRow),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
};

/** Job-card-wise rows — one row per job card on each issue request (like FN item-wise). */
export const findIssueRequestJobCardRows = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  const iRef = { value: 1 };
  const conditions = ["r.is_deleted = false"];

  applyIssueRequestListFilters(filters, conditions, values, { iRef, statsAlias: "jst" });
  let i = iRef.value;

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_desc,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(jc.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const fromClause = `
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     ${JC_STORE_OUT_JOIN}`;

  const countRes = await dbQuery(`SELECT COUNT(*) AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT
       r.issue_uid,
       jc.id AS job_card_id,
       jc.pjobcardno,
       jc.pldt,
       jc.macname,
       jc.item_code,
       jc.item_desc,
       jc.rm_item_code,
       jc.rm_item_desc,
       jc.production_id,
       jc.planqty::float8 AS planqty,
       jc.issue_qty::float8 AS issue_qty,
       jc.coil_count,
       r.shift,
       r.approved,
       r.remarks,
       r.out_entry_locked,
       r.out_entry_locked_at,
       r.created_at,
       r.updated_at,
       r.approved_at,
       r.created_by AS created_by_name,
       r.updated_by AS updated_by_name,
       r.approved_by AS approved_by_name,
       r.out_entry_locked_by AS out_entry_locked_by_name,
       COALESCE(jst.assigned_coil_count, 0)::int AS assigned_coil_count,
       COALESCE(jst.out_coil_count, 0)::int AS store_out_coil_count,
       (COALESCE(jst.assigned_coil_count, 0) > 0
         AND COALESCE(jst.out_coil_count, 0) >= COALESCE(jst.assigned_coil_count, 0)) AS out_entry_complete
     ${fromClause}
     ${where}
     ORDER BY r.issue_uid DESC, jc.pjobcardno ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 1 };
};

export const findIssueRequest = async (issue_uid) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ${MASTER_COLUMNS},
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name,
            jc_agg.job_cards,
            jc_agg.item_code,
            jc_agg.item_desc,
            jc_agg.rm_item_code,
            jc_agg.rm_item_desc,
            jc_agg.production_id
     FROM ${TABLE} r
     ${JC_AGG_JOIN}
     WHERE r.issue_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return mapMasterRow(row) ?? null;
};

/** Flat coil list from normalized job-card rows. */
export const findIssueRequestCoils = async (issue_uid) => {
  const rows = await findActiveJobCardsByIssueUid(issue_uid);
  const id = Number(issue_uid);
  const flat = [];
  for (const jc of rows) {
    for (const c of normalizeJsonArray(jc.coils)) {
      const coil_no_uid = String(c?.coil_no_uid || "").trim();
      if (!coil_no_uid) continue;
      flat.push({
        coil_no_uid,
        qty: c?.qty ?? 0,
        pjobcardno: jc.pjobcardno ?? c?.pjobcardno ?? null,
        issue_uid: id,
      });
    }
  }
  return flat;
};

export const findIssueRequestJobCards = async (issue_uid) => {
  const rows = await findActiveJobCardsByIssueUid(issue_uid);
  return rows.map(jobCardRowToApi);
};

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
    `SELECT UPPER(TRIM(jc.pjobcardno)) AS pjobcardno,
            COALESCE(SUM(jc.issue_qty), 0)::float8 AS issued_qty,
            COALESCE(SUM(jc.issue_qty) FILTER (WHERE r.approved = true), 0)::float8 AS approved_qty,
            COUNT(*)::int AS request_count,
            MAX(r.issue_uid)::int AS last_issue_uid
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     WHERE r.is_deleted = false
       ${excludeClause}
       AND UPPER(TRIM(jc.pjobcardno)) = ANY($1::text[])
     GROUP BY 1`,
    values
  );
};

/** Coils reserved on other issue requests (pending + approved). Edit excludes self via excludeIssueUid. */
export const findReservedCoilsFromRequests = async ({ excludeIssueUid = null } = {}) => {
  const values = [];
  let excludeClause = "";
  const exclude = Number(excludeIssueUid);
  if (Number.isFinite(exclude) && exclude > 0) {
    values.push(exclude);
    excludeClause = `AND r.issue_uid <> $1`;
  }

  return dbQuery(
    `SELECT LOWER(TRIM(c->>'coil_no_uid')) AS coil_no_uid,
            r.issue_uid,
            r.approved
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
     ) AS c
     WHERE r.is_deleted = false
       ${excludeClause}
       AND TRIM(c->>'coil_no_uid') <> ''`,
    values
  );
};

export const insertIssueRequest = async (data) => {
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (shift, remarks, requested_qty, coil_count, approved, approved_by, approved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.shift === "B" ? "B" : "A",
      data.remarks ?? null,
      data.requested_qty ?? 0,
      data.coil_count ?? 0,
      data.approved === true,
      data.approved_by ?? null,
      data.approved_at ?? null,
      data.created_by ?? null,
    ]
  );
  return row;
};

export const updateIssueRequest = async (issue_uid, fields = {}) => {
  const id = Number(issue_uid);
  if (Number.isFinite(id) && id > 0) {
    const [lockRow] = await dbQuery(
      `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
      [id]
    );
    if (lockRow?.out_entry_locked) {
      const err = new Error("This issue request is locked for store out.");
      err.statusCode = 409;
      throw err;
    }
  }

  const allowed = [
    "shift", "remarks", "requested_qty", "coil_count",
    "approved", "approved_by", "approved_at", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  if (safe.shift !== undefined) {
    safe.shift = safe.shift === "B" ? "B" : "A";
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findIssueRequest(issue_uid);
  const values = Object.values(safe);
  values.push(Number(issue_uid));
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
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
  const [lockRow] = await dbQuery(
    `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
    [id]
  );
  if (lockRow?.out_entry_locked) {
    const err = new Error("This issue request is locked for store out.");
    err.statusCode = 409;
    throw err;
  }
  await softDeleteJobCardsByIssueUid(id, deleted_by);
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE issue_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};

export const lockIssueRequestForStoreOut = async ({ issue_uid, userName }, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  const rows = await run(
    `UPDATE ${TABLE}
     SET out_entry_locked = true,
         out_entry_locked_by = COALESCE(out_entry_locked_by, $2),
         out_entry_locked_at = COALESCE(out_entry_locked_at, NOW())
     WHERE issue_uid = $1 AND is_deleted = false
     RETURNING issue_uid, out_entry_locked, out_entry_locked_at`,
    [id, userName ?? null]
  );
  return client?.query ? rows[0] : rows[0];
};

export const unlockIssueRequestForStoreOut = async ({ issue_uid }, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  const rows = await run(
    `UPDATE ${TABLE}
     SET out_entry_locked = false,
         out_entry_locked_by = NULL,
         out_entry_locked_at = NULL
     WHERE issue_uid = $1 AND is_deleted = false
     RETURNING issue_uid, out_entry_locked, out_entry_locked_at`,
    [id]
  );
  return client?.query ? rows[0] : rows[0];
};

export const isIssueRequestLockedForStoreOut = async (issue_uid) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [row] = await dbQuery(
    `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
    [id]
  );
  return Boolean(row?.out_entry_locked);
};
