import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.QC_CHECK;

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

export const findQcChecks = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["q.is_deleted = false"];

  if (filters.status != null && String(filters.status).trim() !== "" && filters.status !== "all") {
    values.push(String(filters.status).trim().toLowerCase());
    conditions.push(`LOWER(q.status) = $${i++}`);
  } else if (filters.status === "all" || filters.exclude_pending === true) {
    // Register — only authorized outcomes (passed / failed)
    conditions.push(`LOWER(q.status) IN ('passed', 'failed')`);
  }

  // Register list: only rows authorized via Approve (approved = true)
  if (filters.approved === true || filters.approved === "true" || filters.register === true) {
    conditions.push(`q.approved = true`);
  } else if (filters.status === "all" || filters.exclude_pending === true ||
    ["passed", "failed"].includes(String(filters.status || "").trim().toLowerCase())) {
    conditions.push(`q.approved = true`);
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
    conditions.push(`q.coil_no_uid = $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(q.coil_no_uid,'') ILIKE $${idx} OR
      COALESCE(q.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(q.heat_no,'') ILIKE $${idx} OR
      COALESCE(q.item_code,'') ILIKE $${idx} OR
      COALESCE(q.item_desc,'') ILIKE $${idx} OR
      COALESCE(q.failure_reason,'') ILIKE $${idx} OR
      COALESCE(q.remarks,'') ILIKE $${idx} OR
      q.mrn_no::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} q ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT q.*,
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name
     FROM ${TABLE} q
     ${where}
     ORDER BY q.qc_check_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findQcCheck = async (qc_check_uid) => {
  const id = Number(qc_check_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT q.*,
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name
     FROM ${TABLE} q
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
            q.created_by AS created_by_name,
            q.inspected_by AS inspected_by_name,
            q.approved_by AS approved_by_name
     FROM ${TABLE} q
     WHERE q.coil_no_uid = $1
       AND q.is_deleted = false
       AND LOWER(q.status) IN ('pending', 'draft')
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  return row ?? null;
};

/**
 * Coils that need QC — stickered active coils without authorized QC yet.
 * Register = approved = true (passed | failed after Authorize).
 * Pending = virtual / draft / awaiting_approval.
 */
export const findPendingCoilsForQc = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "c.is_deleted = false",
    `COALESCE(c.status, 'active') = 'active'`,
    `NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL`,
    // Independent of rack/location — QC starts as soon as stickers exist
    `NOT EXISTS (
       SELECT 1 FROM ${TABLE} q
       WHERE q.coil_no_uid = c.coil_no_uid
         AND q.is_deleted = false
         AND q.approved = true
     )`,
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
      COALESCE(c.heat_no,'') ILIKE $${idx} OR
      COALESCE(c.item_code,'') ILIKE $${idx} OR
      COALESCE(c.item_desc,'') ILIKE $${idx} OR
      c.mrn_no::text ILIKE $${idx}
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
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${where}`,
      values
    );
    const total = Number(countRes[0]?.count || 0);
    const rows = await dbQuery(
      `SELECT
          qpend.qc_check_uid,
          c.coil_no_uid,
          c.mrn_uid,
          c.mrn_no,
          c.heat_no,
          c.item_dcode,
          c.item_code,
          c.item_desc,
          c.qty,
          COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil')::varchar AS sticker_mode,
          COALESCE(qpend.status, 'pending')::varchar AS status,
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
          false AS is_batch_pending
       FROM ${T.COIL_TABLE} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN LATERAL (
         SELECT q.qc_check_uid, q.status, q.failure_reason, q.remarks, q.inspected_by, q.inspected_at
         FROM ${TABLE} q
         WHERE q.coil_no_uid = c.coil_no_uid
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
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
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
         c.mrn_no,
         c.heat_no,
         c.item_dcode,
         c.item_code,
         c.item_desc,
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
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN LATERAL (
         SELECT q.qc_check_uid, q.status, q.failure_reason, q.remarks, q.inspected_by, q.inspected_at
         FROM ${TABLE} q
         WHERE q.coil_no_uid = c.coil_no_uid
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
         NULL::int AS qc_check_uid,
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
         NULL::text AS failure_reason,
         NULL::text AS remarks,
         NULL::text AS inspected_by,
         NULL::timestamp AS inspected_at,
         (ARRAY_AGG(created_by ORDER BY created_at ASC))[1] AS created_by,
         MIN(created_at) AS created_at,
         true AS is_virtual_pending,
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
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (coil_no_uid, mrn_uid, mrn_no, heat_no, item_dcode, item_code, item_desc, qty, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      String(fields.coil_no_uid || "").trim(),
      fields.mrn_uid ?? null,
      fields.mrn_no ?? null,
      fields.heat_no ?? null,
      fields.item_dcode ?? null,
      fields.item_code ?? null,
      fields.item_desc ?? null,
      fields.qty ?? 0,
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
    `SELECT q.*
     FROM ${TABLE} q
     WHERE q.coil_no_uid = $1 AND q.is_deleted = false
     ORDER BY q.qc_check_uid DESC
     LIMIT 1`,
    [uid]
  );
  return row ?? null;
};

export const findQcCheckItems = async (qc_check_uid) => {
  const row = await findQcCheck(qc_check_uid);
  if (!row) return [];
  const items = normalizeItems(row.items);
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
    "status", "failure_reason", "remarks", "inspected_by", "inspected_at",
    "approved", "approved_by", "approved_at",
    "qc_reject_uid", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findQcCheck(qc_check_uid);
  const values = Object.values(safe);
  values.push(Number(qc_check_uid));
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE qc_check_uid = $${keys.length + 1} AND is_deleted = false
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
 * When a QC Rejection is deleted, soft-delete linked failed checks
 * so coils reappear as virtual pending (no QC row).
 */
export const reopenQcChecksForRejection = async (qc_reject_uid, updated_by = null) => {
  const id = Number(qc_reject_uid);
  if (!Number.isFinite(id)) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $2,
         qc_reject_uid = NULL,
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
    "q.approved = true",
    "q.qc_reject_uid IS NULL",
    `NOT EXISTS (
       SELECT 1 FROM ${T.COIL_TABLE} c
       WHERE c.coil_no_uid = q.coil_no_uid
         AND c.is_deleted = false
         AND (
           c.qc_reject_uid IS NOT NULL
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
      COALESCE(q.heat_no,'') ILIKE $${idx} OR
      COALESCE(q.item_code,'') ILIKE $${idx} OR
      COALESCE(q.item_desc,'') ILIKE $${idx} OR
      COALESCE(q.failure_reason,'') ILIKE $${idx} OR
      q.mrn_no::text ILIKE $${idx} OR
      q.qc_check_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} q ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT q.qc_check_uid,
            q.coil_no_uid,
            q.mrn_uid,
            q.mrn_no,
            q.heat_no,
            q.item_dcode,
            q.item_code,
            q.item_desc,
            q.qty,
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
     ${where}
     ORDER BY q.qc_check_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const data = (rows || []).map((r) => ({
    ...r,
    pending_source: "qc_check",
    pending_type: "qc_fail",
    // Rejection Pending list shape (no qc_reject_uid in DB yet)
    qc_reject_uid: null,
    mrn_refs: r.mrn_no != null ? String(r.mrn_no) : null,
    heat_nos: r.heat_no || null,
    item_codes: r.item_code || null,
    reason: r.failure_reason || null,
    total_qty: r.qty ?? 0,
    coil_count: 1,
    approved: false,
  }));

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};
