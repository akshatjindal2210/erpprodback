import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { COIL_QC_JOIN, COIL_QC_NOT_FINAL_COND } from "../../../lib/utils/coilQcStatusSql.js";
import { qcPendingMrnCoilSql } from "../../../lib/utils/mrnPortalCoilSql.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.QC_CHECK;

const QC_MRN_JOIN = `LEFT JOIN ${T.MRN} m ON m.uid = q.mrn_uid`;

/** MRN display fields (item/qty come from join / coil aggregate). */
const QC_ENRICH_SELECT = `
  m.mrn_no,
  m.heat_no,
  m.item_dcode,
  m.item_code,
  m.item_desc`;

const QC_APPROVED_COND = `q.approved = true`;

const QC_QTY_AGG_JOIN = `LEFT JOIN LATERAL (
       SELECT
         STRING_AGG(c.coil_no_uid, ', ' ORDER BY c.created_at ASC, c.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c
       WHERE c.qc_uid = q.qc_check_uid
         AND c.is_deleted = false
     ) qc_agg ON true`;

function qcSearchSql(idx) {
  return `(
      COALESCE(q.coil_no_uid,'') ILIKE $${idx} OR
      COALESCE(q.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(m.heat_no,'') ILIKE $${idx} OR
      COALESCE(m.item_code,'') ILIKE $${idx} OR
      COALESCE(m.item_desc,'') ILIKE $${idx} OR
      COALESCE(q.failure_reason,'') ILIKE $${idx} OR
      COALESCE(q.remarks,'') ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx}
    )`;
}

function normalizeItems(raw) {
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

function ownInspectionMethod(it) {
  const v = it?.inspection_method != null ? String(it.inspection_method).trim() : "";
  return v || "";
}

async function lookupInspectionMethodsBySpecId(specIds = []) {
  const ids = [...new Set((specIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const rows = await dbQuery(
    `SELECT spec_id, inspection_method
     FROM ${T.SPEC_DETAIL}
     WHERE spec_id = ANY($1::int[])`,
    [ids]
  );
  const map = new Map();
  for (const r of rows || []) {
    const v = r.inspection_method != null ? String(r.inspection_method).trim() : "";
    if (v) map.set(Number(r.spec_id), v);
  }
  return map;
}

async function withInspectionMethods(items = []) {
  const list = Array.isArray(items) ? items : [];
  const missingIds = list
    .filter((it) => !ownInspectionMethod(it))
    .map((it) => it?.spec_id);
  const byId = await lookupInspectionMethodsBySpecId(missingIds);

  const stillMissingNames = [
    ...new Set(
      list
        .filter(
          (it) =>
            !ownInspectionMethod(it) &&
            !byId.get(Number(it?.spec_id)) &&
            String(it?.spec_name || "").trim(),
        )
        .map((it) => String(it.spec_name).trim().toLowerCase()),
    ),
  ];
  const byName = new Map();
  if (stillMissingNames.length) {
    const rows = await dbQuery(
      `SELECT spec_name, inspection_method
       FROM ${T.SPEC_DETAIL}
       WHERE inspection_method IS NOT NULL
         AND TRIM(inspection_method) <> ''
         AND LOWER(TRIM(spec_name)) = ANY($1::text[])`,
      [stillMissingNames],
    );
    for (const r of rows || []) {
      const key = String(r.spec_name || "").trim().toLowerCase();
      const v = String(r.inspection_method || "").trim();
      if (key && v && !byName.has(key)) byName.set(key, v);
    }
  }

  return list.map((it) => ({
    ...it,
    inspection_method:
      ownInspectionMethod(it) ||
      byId.get(Number(it?.spec_id)) ||
      byName.get(String(it?.spec_name || "").trim().toLowerCase()) ||
      null,
  }));
}

export const findQcChecks = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  let i = 1;
  const conditions = ["q.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`q.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (filters.status != null && String(filters.status).trim() !== "" && filters.status !== "all") {
    values.push(String(filters.status).trim().toLowerCase());
    conditions.push(`LOWER(q.status) = $${i++}`);
  } else if (filters.status === "all" || filters.exclude_pending === true) {
    // Register — include everything that has been submitted for approval
    conditions.push(`LOWER(q.status) IN ('passed', 'failed', 'awaiting_approval')`);
  }

  // Register list: only rows that have been approved (passed/failed)
  if (filters.approved === true || filters.approved === "true" || filters.register === true) {
    conditions.push(QC_APPROVED_COND);
  } else if (["passed", "failed"].includes(String(filters.status || "").trim().toLowerCase())) {
    conditions.push(QC_APPROVED_COND);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`q.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`q.created_at <= $${i++}`);
  }
  if (filters.mrn_uid != null && String(filters.mrn_uid).trim() !== "") {
    values.push(String(filters.mrn_uid).trim());
    conditions.push(`q.mrn_uid = $${i++}`);
  }
  if (filters.coil_no_uid != null && String(filters.coil_no_uid).trim() !== "") {
    values.push(String(filters.coil_no_uid).trim());
    conditions.push(`(
      q.coil_no_uid = $${i} OR 
      EXISTS (
        SELECT 1 FROM ${T.COIL_TABLE} c 
        WHERE c.qc_uid = q.qc_check_uid 
          AND c.coil_no_uid = $${i++}
          AND c.is_deleted = false
      )
    )`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(qcSearchSql(idx));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} q ${QC_MRN_JOIN} ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name,
            q.updated_by AS updated_by_name,
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     ${QC_QTY_AGG_JOIN}
     ${where}
     ORDER BY q.qc_check_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const missingIds = [];
  for (const row of rows || []) {
    for (const it of normalizeItems(row.items)) {
      if (!ownInspectionMethod(it) && it?.spec_id != null) missingIds.push(it.spec_id);
    }
  }
  const methodMap = await lookupInspectionMethodsBySpecId(missingIds);
  const data = (rows || []).map((row) => ({
    ...row,
    items: normalizeItems(row.items).map((it) => ({
      ...it,
      inspection_method: ownInspectionMethod(it) || methodMap.get(Number(it?.spec_id)) || null,
    })),
  }));

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findQcCheck = async (qc_check_uid) => {
  const id = Number(qc_check_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name,
            q.updated_by AS updated_by_name,
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     ${QC_QTY_AGG_JOIN}
     WHERE q.qc_check_uid = $1 AND q.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row ?? null;
};

export const findPendingQcCheckByCoil = async (coil_no_uid) => {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;

  const [row] = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name,
            q.updated_by AS updated_by_name,
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     JOIN ${T.COIL_TABLE} c ON c.qc_uid = q.qc_check_uid
     LEFT JOIN LATERAL (
       SELECT 
         STRING_AGG(c2.coil_no_uid, ', ' ORDER BY c2.created_at ASC, c2.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c2.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c2
       WHERE c2.qc_uid = q.qc_check_uid
         AND c2.is_deleted = false
     ) qc_agg ON true
     WHERE c.coil_no_uid = $1
       AND q.is_deleted = false
       AND LOWER(q.status) IN ('pending', 'draft', 'awaiting_approval')
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  if (row) return row;

  // Fallback for primary coil reference
  const [fallback] = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name,
            q.updated_by AS updated_by_name,
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     LEFT JOIN LATERAL (
       SELECT 
         STRING_AGG(c2.coil_no_uid, ', ' ORDER BY c2.created_at ASC, c2.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c2.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c2
       WHERE c2.qc_uid = q.qc_check_uid
         AND c2.is_deleted = false
     ) qc_agg ON true
     WHERE q.coil_no_uid = $1
       AND q.is_deleted = false
       AND LOWER(q.status) IN ('pending', 'draft', 'awaiting_approval')
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  return fallback ?? null;
};

/**
 * Coils waiting for QC — stored MRN Portal coils with approved stickers only.
 */
export const findPendingCoilsForQc = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "c.is_deleted = false",
    `COALESCE(c.status, 'active') = 'active'`,
    qcPendingMrnCoilSql("c", "m"),
    COIL_QC_NOT_FINAL_COND,
  ];

  // Optional date filter only when caller sends it (Pending tab usually omits — like Unapproved list)
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`c.created_at >= $${i++}::timestamp`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`c.created_at <= $${i++}::timestamp`);
  }
  if (filters.mrn_uid != null && String(filters.mrn_uid).trim() !== "") {
    values.push(String(filters.mrn_uid).trim());
    conditions.push(`c.mrn_uid = $${i++}`);
  }
  if (filters.coil_no_uid != null && String(filters.coil_no_uid).trim() !== "") {
    values.push(String(filters.coil_no_uid).trim());
    conditions.push(`c.coil_no_uid = $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(c.coil_no_uid,'') ILIKE $${idx} OR
      COALESCE(c.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(m.heat_no,'') ILIKE $${idx} OR
      COALESCE(m.item_code,'') ILIKE $${idx} OR
      COALESCE(m.item_desc,'') ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const expandCoils =
    filters.expand_coils === true ||
    filters.expand_coils === "true" ||
    filters.coil_level === true ||
    filters.coil_level === "true";

  // Coil-level list (scan gate / internal) — no batch aggregation
  if (expandCoils) {
    const countRes = await dbQuery(
      `SELECT COUNT(*)::int AS count
       FROM ${T.COIL_TABLE} c
       INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${COIL_QC_JOIN}
       ${where}`,
      values
    );
    const total = Number(countRes[0]?.count || 0);
    const rows = await dbQuery(
      `SELECT
          qpend.qc_check_uid,
          c.coil_no_uid,
          c.mrn_uid,
        m.mrn_no,
        m.heat_no,
        m.item_dcode,
        m.item_code,
        m.item_desc,
          c.qty,
          COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil')::varchar AS sticker_mode,          COALESCE(qpend.status, 'pending')::varchar AS status,
          qpend.failure_reason,
          qpend.remarks,
          qpend.inspected_by,
          qpend.inspected_at,
          NULL::text AS approved_by,
          NULL::timestamp AS approved_at,
          false AS approved,
          NULL::int AS qc_reject_uid,
          c.created_by,
          c.created_at,
          c.created_by AS created_by_name,
          qpend.inspected_by AS inspected_by_name,
          NULL::text AS approved_by_name,
          (qpend.qc_check_uid IS NULL) AS is_virtual_pending,
          1::int AS coil_count,
          (COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil') = 'batch') AS is_batch_pending
       FROM ${T.COIL_TABLE} c
       INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${COIL_QC_JOIN}
       LEFT JOIN LATERAL (
         SELECT q.qc_check_uid, q.status, q.failure_reason, q.remarks, q.inspected_by, q.inspected_at
         FROM ${TABLE} q
         WHERE (q.coil_no_uid = c.coil_no_uid OR q.qc_check_uid = c.qc_uid)
           AND q.is_deleted = false
           AND LOWER(q.status) IN ('pending', 'draft', 'awaiting_approval')
         ORDER BY q.qc_check_uid DESC
         LIMIT 1
       ) qpend ON true
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, safeLimit, offset]
    );
    return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  /**
   * Coil-wise MRNs → one pending row per coil.
   * Batch-wise MRNs → one pending row per MRN (not every coil).
   */
  const countRes = await dbQuery(
    `WITH pending AS (
       SELECT
         c.coil_no_uid,
         c.mrn_uid,
         COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil') AS sticker_mode
       FROM ${T.COIL_TABLE} c
       INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${COIL_QC_JOIN}
       ${where}
     )
     SELECT COUNT(*)::int AS count FROM (
       SELECT coil_no_uid FROM pending WHERE sticker_mode <> 'batch'
       UNION ALL
       SELECT mrn_uid FROM pending WHERE sticker_mode = 'batch' GROUP BY mrn_uid
     ) x`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `WITH pending AS (
       SELECT
         qpend.qc_check_uid,
         c.coil_no_uid,
         c.mrn_uid,
         m.mrn_no,
         m.heat_no,
         m.item_dcode,
         m.item_code,
         m.item_desc,
         c.qty,
         COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil') AS sticker_mode,
         COALESCE(qpend.status, 'pending')::varchar AS status,
         qpend.failure_reason,
         qpend.remarks,
         qpend.inspected_by,
         qpend.inspected_at,
         c.created_by,
         c.created_at,
         (qpend.qc_check_uid IS NULL) AS is_virtual_pending
       FROM ${T.COIL_TABLE} c
       INNER JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${COIL_QC_JOIN}
       LEFT JOIN LATERAL (
         SELECT q.qc_check_uid, q.status, q.failure_reason, q.remarks, q.inspected_by, q.inspected_at
         FROM ${TABLE} q
         WHERE (q.coil_no_uid = c.coil_no_uid OR q.qc_check_uid = c.qc_uid)
           AND q.is_deleted = false
           AND LOWER(q.status) IN ('pending', 'draft', 'awaiting_approval')
         ORDER BY q.qc_check_uid DESC
         LIMIT 1
       ) qpend ON true
       ${where}
     ),
     coil_rows AS (
       SELECT
         qc_check_uid,
         coil_no_uid,
         mrn_uid,
         mrn_no,
         heat_no,
         item_dcode,
         item_code,
         item_desc,
         qty,
         sticker_mode,
         status,
         failure_reason,
         remarks,
         inspected_by,
         inspected_at,
         created_by,
         created_at,
         is_virtual_pending,
         1::int AS coil_count,
         false AS is_batch_pending
       FROM pending
       WHERE sticker_mode <> 'batch'
     ),
     batch_rows AS (
       SELECT
         (ARRAY_AGG(qc_check_uid ORDER BY qc_check_uid DESC NULLS LAST))[1] AS qc_check_uid,
         STRING_AGG(coil_no_uid, ', ' ORDER BY created_at ASC, coil_no_uid ASC)::varchar AS coil_no_uid,
         mrn_uid,
         MAX(mrn_no) AS mrn_no,
         MAX(heat_no) AS heat_no,
         MAX(item_dcode) AS item_dcode,
         MAX(item_code) AS item_code,
         MAX(item_desc) AS item_desc,
         SUM(COALESCE(qty, 0)) AS qty,
         'batch'::varchar AS sticker_mode,
         CASE
           WHEN BOOL_AND(LOWER(status) = 'awaiting_approval') THEN 'awaiting_approval'
           WHEN BOOL_OR(LOWER(status) = 'draft') THEN 'draft'
           ELSE 'pending'
         END::varchar AS status,
         (ARRAY_AGG(failure_reason ORDER BY qc_check_uid DESC NULLS LAST))[1] AS failure_reason,
         (ARRAY_AGG(remarks ORDER BY qc_check_uid DESC NULLS LAST))[1] AS remarks,
         (ARRAY_AGG(inspected_by ORDER BY qc_check_uid DESC NULLS LAST))[1] AS inspected_by,
         (ARRAY_AGG(inspected_at ORDER BY qc_check_uid DESC NULLS LAST))[1] AS inspected_at,
         (ARRAY_AGG(created_by ORDER BY created_at ASC))[1] AS created_by,
         MIN(created_at) AS created_at,
         BOOL_AND(qc_check_uid IS NULL) AS is_virtual_pending,
         COUNT(*)::int AS coil_count,
         true AS is_batch_pending
       FROM pending
       WHERE sticker_mode = 'batch'
       GROUP BY mrn_uid
     ),
     combined AS (
       SELECT * FROM coil_rows
       UNION ALL
       SELECT * FROM batch_rows
     )
     SELECT
       qc_check_uid,
       coil_no_uid,
       mrn_uid,
       mrn_no,
       heat_no,
       item_dcode,
       item_code,
       item_desc,
       qty,
       sticker_mode,
       status,
       failure_reason,
       remarks,
       inspected_by,
       inspected_at,
       NULL::text AS approved_by,
       NULL::timestamp AS approved_at,
       false AS approved,
       NULL::int AS qc_reject_uid,
       created_by,
       created_at,
       created_by AS created_by_name,
       inspected_by AS inspected_by_name,
       NULL::text AS approved_by_name,
       is_virtual_pending,
       coil_count,
       is_batch_pending
     FROM combined
     ORDER BY created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

/** Insert QC header at inspect submit time (not on sticker generate). */
export const insertQcCheck = async (fields = {}, created_by = null) => {
  // Header stores one coil UID only (VARCHAR(120)); batch coils link via qc_check_uid.
  const primaryUid = String(fields.coil_no_uid || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || "";
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (coil_no_uid, mrn_uid, status, created_by)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [
      primaryUid,
      fields.mrn_uid ?? null,
      fields.status || "pending",
      created_by ?? null,
    ]
  );
  return row ?? null;
};

/** Any live QC row for a coil (blocks duplicate inspect). */
export const findLiveQcCheckByCoil = async (coil_no_uid) => {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;

  const [row] = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     JOIN ${T.COIL_TABLE} c ON c.qc_uid = q.qc_check_uid
     LEFT JOIN LATERAL (
       SELECT 
         STRING_AGG(c2.coil_no_uid, ', ' ORDER BY c2.created_at ASC, c2.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c2.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c2
       WHERE c2.qc_uid = q.qc_check_uid
         AND c2.is_deleted = false
     ) qc_agg ON true
     WHERE c.coil_no_uid = $1 AND q.is_deleted = false
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  if (row) return row;

  // Fallback for primary coil reference
  const [fallback] = await dbQuery(
    `SELECT q.*,
            ${QC_ENRICH_SELECT},
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     LEFT JOIN LATERAL (
       SELECT 
         STRING_AGG(c2.coil_no_uid, ', ' ORDER BY c2.created_at ASC, c2.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c2.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c2
       WHERE c2.qc_uid = q.qc_check_uid
         AND c2.is_deleted = false
     ) qc_agg ON true
     WHERE q.coil_no_uid = $1 AND q.is_deleted = false
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  return fallback ?? null;
};

export const findQcCheckItems = async (qc_check_uid) => {
  const row = await findQcCheck(qc_check_uid);
  if (!row) return [];
  const items = await withInspectionMethods(normalizeItems(row.items));
  return items
    .map((it, idx) => ({
      ...it,
      qc_check_uid: Number(qc_check_uid),
      sno: it?.sno ?? idx + 1,
    }))
    .sort((a, b) => Number(a.sno || 0) - Number(b.sno || 0));
};

export const replaceQcCheckItems = async (qc_check_uid, items = []) => {
  const id = Number(qc_check_uid);
  if (!Number.isFinite(id)) return [];
  const payload = (items || []).map((it, idx) => ({
    spec_id: it.spec_id ?? null,
    sno: it.sno ?? idx + 1,
    type: it.type ?? null,
    spec_name: it.spec_name ?? null,
    print_val: it.print_val ?? null,
    inspection_method: it.inspection_method != null && String(it.inspection_method).trim()
      ? String(it.inspection_method).trim()
      : null,
    spec_type: it.spec_type ?? null,
    min_value: it.min_value ?? 0,
    max_value: it.max_value ?? 0,
    correct_option: it.correct_option ?? null,
    incorrect_option: it.incorrect_option ?? null,
    document_required: it.document_required === true,
    actual_value: it.actual_value ?? null,
    document_note: it.document_note ?? null,
    result: it.result ?? null,
  }));
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET items = $2::jsonb
     WHERE qc_check_uid = $1 AND is_deleted = false
     RETURNING items`,
    [id, JSON.stringify(payload)]
  );
  return normalizeItems(row?.items).map((it) => ({ ...it, qc_check_uid: id }));
};

export const updateQcCheck = async (qc_check_uid, fields = {}) => {
  const allowed = [
    "status", "overall_result", "failure_reason", "remarks", "inspected_by", "inspected_at",
    "approved", "approved_by", "approved_at",
    "qc_reject_uid", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findQcCheck(qc_check_uid);

  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(safe);
  values.push(Number(qc_check_uid));
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE qc_check_uid = $${nextIndex} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteQcChecksByCoilNoUids = async (coil_no_uids = [], deleted_by = null) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[]) AND is_deleted = false
     RETURNING qc_check_uid`,
    [uids, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

export const softDeleteQcChecksByMrn = async (mrn_uid, deleted_by = null) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
     WHERE mrn_uid = $1 AND is_deleted = false
     RETURNING qc_check_uid`,
    [uid, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Permanently remove QC checks for an MRN (cancel stickers / full reset). */
export const hardDeleteQcChecksByMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const rows = await dbQuery(
    `DELETE FROM ${TABLE}
     WHERE mrn_uid = $1
     RETURNING qc_check_uid`,
    [uid]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Soft-delete one QC check by id. */
export const softDeleteQcCheck = async (qc_check_uid, deleted_by = null) => {
  const id = Number(qc_check_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
     WHERE qc_check_uid = $1 AND is_deleted = false
     RETURNING *`,
    [id, deleted_by]
  );
  return row ?? null;
};

/**
 * When RM Rejection register is deleted, unlink failed QC checks
 * so they reappear in Rejection Pending (QC Fail).
 */
export const reopenQcChecksForRejection = async (qc_reject_uid, updated_by = null) => {
  const id = Number(qc_reject_uid);
  if (!Number.isFinite(id)) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET qc_reject_uid = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE qc_reject_uid = $1 AND is_deleted = false AND LOWER(status) = 'failed'
     RETURNING qc_check_uid, coil_no_uid`,
    [id, updated_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/**
 * Link failed QC checks for coils to a Rejection Register row
 * so they leave Rejection Pending.
 */
export const linkFailedQcChecksToRejection = async (qc_reject_uid, coil_no_uids = [], updated_by = null) => {
  const id = Number(qc_reject_uid);
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!Number.isFinite(id) || !uids.length) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET qc_reject_uid = $1,
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND LOWER(status) = 'failed'
       AND approved = true
       AND qc_reject_uid IS NULL
     RETURNING qc_check_uid`,
    [id, updated_by ?? null, uids]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/**
 * Failed QC checks not yet saved to QC Rejection DB (virtual Rejection Pending).
 * Excludes coils already on a rejection / store-out so Register rejects don't linger here.
 */
export const findFailedQcChecksPendingRejection = async (options = {}) => {
  const { search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "q.is_deleted = false",
    "LOWER(q.status) = 'failed'",
    QC_APPROVED_COND,
    "q.qc_reject_uid IS NULL",
    `NOT EXISTS (
       SELECT 1 FROM ${T.COIL_TABLE} c
       WHERE c.qc_uid = q.qc_check_uid
         AND c.is_deleted = false
         AND (
           c.rm_uid IS NOT NULL
           OR c.out_uid IS NOT NULL
           OR LOWER(COALESCE(c.status, 'active')) IN ('out', 'consumed')
         )
     )`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(q.coil_no_uid,'') ILIKE $${idx} OR
      COALESCE(q.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(m.heat_no,'') ILIKE $${idx} OR
      COALESCE(m.item_code,'') ILIKE $${idx} OR
      COALESCE(m.item_desc,'') ILIKE $${idx} OR
      COALESCE(q.failure_reason,'') ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx} OR
      q.qc_check_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} q ${QC_MRN_JOIN} ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT q.qc_check_uid,
            COALESCE(qc_agg.coil_no_uid, q.coil_no_uid) AS coil_no_uid,
            COALESCE(qc_agg.coil_count, 1) AS coil_count,
            COALESCE(qc_agg.total_qty, 0) AS qty,
            q.mrn_uid,
            m.mrn_no,
            m.heat_no,
            m.item_dcode,
            m.item_code,
            m.item_desc,
            q.status,
            q.failure_reason,
            q.remarks,
            q.inspected_by,
            q.inspected_at,
            q.approved_by,
            q.approved_at,
            q.created_by,
            q.created_at,
            q.inspected_by AS inspected_by_name,
            TRUE AS is_virtual_pending
     FROM ${TABLE} q
     ${QC_MRN_JOIN}
     LEFT JOIN LATERAL (
       SELECT
         STRING_AGG(c.coil_no_uid, ', ' ORDER BY c.created_at ASC, c.coil_no_uid ASC) AS coil_no_uid,
         COUNT(*)::int AS coil_count,
         SUM(COALESCE(c.qty, 0)) AS total_qty
       FROM ${T.COIL_TABLE} c
       WHERE c.qc_uid = q.qc_check_uid
         AND c.is_deleted = false
     ) qc_agg ON true
     ${where}
     ORDER BY q.qc_check_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const data = (rows || []).map((r) => ({
    ...r,
    pending_source: "qc_check",
    pending_type: "qc_fail",
    qc_reject_uid: null,
    mrn_refs: r.mrn_no != null ? String(r.mrn_no) : null,
    heat_nos: r.heat_no || null,
    item_codes: r.item_code || null,
    item_desc: r.item_desc || null,
    item_descs: r.item_desc || null,
    reason: r.failure_reason || null,
    total_qty: r.qty ?? 0,
    coil_count: Number(r.coil_count) || 1,
    approved: false,
  }));

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};
