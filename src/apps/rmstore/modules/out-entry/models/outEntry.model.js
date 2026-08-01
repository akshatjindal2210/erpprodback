import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.OUT_ENTRY;
const SCANNED = T.OUT_ENTRY_SCANNED_COIL;
const COIL = T.COIL_TABLE;
const LOC = T.MASTER_LOCATION;
const ISSUE_REQUEST = T.ISSUE_REQUEST;
const ISSUE_REQUEST_JC = T.ISSUE_REQUEST_JOB_CARD;
const REJECTION = T.REJECTION;

/** Active coil not already out and not on an open store-out draft. */
function coilAvailableForOutSql(alias = "c") {
  return `${alias}.out_uid IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${SCANNED} s
      JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
      WHERE LOWER(TRIM(s.coil_no_uid)) = LOWER(TRIM(${alias}.coil_no_uid))
        AND COALESCE(o.approved, false) = false
    )`;
}

/** Coil already on an approved issue-request job card — show under Job Card pending only. */
function coilNotOnApprovedIssueRequestSql(alias = "c") {
  return `NOT EXISTS (
    SELECT 1
    FROM ${ISSUE_REQUEST} ir
    INNER JOIN ${ISSUE_REQUEST_JC} jc
      ON jc.issue_uid = ir.issue_uid AND jc.is_deleted = false
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS jc_coil(coil)
    WHERE ir.is_deleted = false
      AND ir.approved = true
      AND LOWER(TRIM(jc_coil.coil->>'coil_no_uid')) = LOWER(TRIM(${alias}.coil_no_uid))
  )`;
}

export const findOutEntries = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["o.is_deleted = false"];

  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`o.approved = $${i++}`);
  }
  if (filters.scan_complete !== undefined && filters.scan_complete !== null && filters.scan_complete !== "") {
    values.push(filters.scan_complete === true || filters.scan_complete === "true");
    conditions.push(`COALESCE(o.scan_complete, false) = $${i++}`);
  }
  if (filters.entry_type) {
    values.push(String(filters.entry_type).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(o.entry_type, 'store_out')) = $${i++}`);
  }
  if (filters.qc_reject_uid != null && filters.qc_reject_uid !== "") {
    values.push(Number(filters.qc_reject_uid));
    conditions.push(`o.qc_reject_uid = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`o.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`o.created_at <= $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(o.heat_nos,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(o.location_refs,'') ILIKE $${idx} OR
      COALESCE(o.remarks,'') ILIKE $${idx} OR
      COALESCE(o.entry_type,'') ILIKE $${idx} OR
      o.out_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} o ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT o.*,
            o.created_by AS created_by_name,
            o.approved_by AS approved_by_name
     FROM ${TABLE} o
     ${where}
     ORDER BY o.out_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findOutEntry = async (out_uid) => {
  const id = Number(out_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT o.*, o.created_by AS created_by_name, o.approved_by AS approved_by_name
     FROM ${TABLE} o WHERE o.out_uid = $1 AND o.is_deleted = false LIMIT 1`,
    [id]
  );
  return row ?? null;
};

export const insertOutEntry = async (data) => {
  const {
    entry_type, issue_uid, pjobcardno, qc_reject_uid, mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count,
    location_refs, remarks, created_by, scan_complete,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (entry_type, issue_uid, pjobcardno, qc_reject_uid, mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count,
      location_refs, remarks, created_by, scan_complete)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      entry_type ?? "store_out",
      issue_uid ?? null,
      pjobcardno ?? null,
      qc_reject_uid ?? null,
      mrn_refs ?? null, heat_nos ?? null, item_codes ?? null, qtys ?? null,
      total_qty ?? 0, coil_count ?? 0, location_refs ?? null, remarks ?? null, created_by,
      scan_complete === true,
    ]
  );
  return row;
};

export const updateOutEntry = async (out_uid, fields = {}) => {
  const allowed = [
    "remarks", "approved", "approved_by", "approved_at", "updated_by", "updated_at",
    "scan_complete", "mrn_refs", "heat_nos", "item_codes", "qtys", "total_qty",
    "coil_count", "location_refs",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findOutEntry(out_uid);
  const values = Object.values(safe);
  values.push(Number(out_uid));
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE out_uid = $${keys.length + 1} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteOutEntry = async (out_uid, deleted_by) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE out_uid = $1 AND is_deleted = false`,
    [Number(out_uid), deleted_by ?? null]
  );
};

export const replaceOutEntryScannedCoils = async (out_uid, coil_no_uids = []) => {
  const id = Number(out_uid);
  const list = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  await dbQuery(`DELETE FROM ${SCANNED} WHERE out_uid = $1`, [id]);
  if (!list.length) return [];
  for (const uid of list) {
    await dbQuery(
      `INSERT INTO ${SCANNED} (out_uid, coil_no_uid) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, uid]
    );
  }
  return list;
};

export const findOutEntryScannedCoilUids = async (out_uid) => {
  const rows = await dbQuery(
    `SELECT coil_no_uid FROM ${SCANNED} WHERE out_uid = $1 ORDER BY created_at ASC`,
    [Number(out_uid)]
  );
  return (rows || []).map((r) => r.coil_no_uid);
};

export const findOutEntryScannedCoilsDetailed = async (out_uid) => {
  return dbQuery(
    `SELECT c.*,
            lm.location_no,
            lm.rack_no,
            lm.row_no,
            s.created_at AS scanned_at
     FROM ${SCANNED} s
     JOIN ${COIL} c ON c.coil_no_uid = s.coil_no_uid AND c.is_deleted = false
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE s.out_uid = $1
     ORDER BY s.created_at ASC`,
    [Number(out_uid)]
  );
};

/** Coil already reserved on another open (non-approved) store-out draft/pending. */
export const findOpenOutDraftForCoil = async (coil_no_uid, excludeOutUid = null) => {
  const values = [String(coil_no_uid || "").trim()];
  let i = 2;
  let excludeSql = "";
  if (excludeOutUid != null && Number.isFinite(Number(excludeOutUid))) {
    values.push(Number(excludeOutUid));
    excludeSql = ` AND o.out_uid <> $${i++}`;
  }
  const [row] = await dbQuery(
    `SELECT o.out_uid
     FROM ${SCANNED} s
     JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
     WHERE s.coil_no_uid = $1
       AND COALESCE(o.approved, false) = false
       ${excludeSql}
     LIMIT 1`,
    values
  );
  return row ?? null;
};

/** Coils on open (non-approved) store-out drafts — block issue request picks. */
export const findOutDraftReservedCoilUids = async () => {
  const rows = await dbQuery(
    `SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_no_uid
     FROM ${SCANNED} s
     JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
     WHERE COALESCE(o.approved, false) = false
       AND TRIM(s.coil_no_uid) <> ''`
  );
  return new Set((rows || []).map((r) => String(r.coil_no_uid || "").trim()).filter(Boolean));
};

export const clearOutEntryScannedCoils = async (out_uid) => {
  await dbQuery(`DELETE FROM ${SCANNED} WHERE out_uid = $1`, [Number(out_uid)]);
};

export function buildOutEntryCoilSummary(coils = []) {
  const list = Array.isArray(coils) ? coils : [];
  const mrnRefs = [...new Set(list.map((c) => c.mrn_no).filter((v) => v != null))].join(" | ");
  const heatNos = [...new Set(list.map((c) => c.heat_no).filter(Boolean))].join(" | ");
  const itemCodes = [...new Set(list.map((c) => c.item_code).filter(Boolean))].join(" | ");
  const locationRefs = [
    ...new Set(
      list
        .map((c) => c.location_no || (c.location_id != null ? String(c.location_id) : null))
        .filter(Boolean)
    ),
  ].join(" | ");
  const total_qty = list.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const qtys = list.map((c) => c.qty ?? "").join(",");
  return {
    mrn_refs: mrnRefs || null,
    heat_nos: heatNos || null,
    item_codes: itemCodes || null,
    location_refs: locationRefs || null,
    total_qty,
    qtys,
    coil_count: list.length,
  };
}

/**
 * MRNs that still have active stored coils — for Store Out picker (IMS FUID-style).
 */
export const findStoredMrnSummaries = async ({ search, page = 1, limit = 50 } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    "c.is_deleted = false",
    "c.location_id IS NOT NULL",
    `COALESCE(c.status, 'active') = 'active'`,
    `NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(c.mrn_uid, '') ILIKE $${idx} OR
      c.mrn_no::text ILIKE $${idx} OR
      COALESCE(c.item_code, '') ILIKE $${idx} OR
      COALESCE(c.heat_no, '') ILIKE $${idx} OR
      COALESCE(m.acc_name, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM (
       SELECT c.mrn_uid
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       ${where}
       GROUP BY c.mrn_uid
     ) x`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `SELECT c.mrn_uid,
            MAX(c.mrn_no) AS mrn_no,
            MAX(COALESCE(m.sticker_mode, 'coil')) AS sticker_mode,
            MAX(COALESCE(m.item_code, c.item_code)) AS item_code,
            MAX(COALESCE(m.item_desc, c.item_desc)) AS item_desc,
            MAX(m.acc_name) AS acc_name,
            COUNT(*)::int AS coil_count,
            COALESCE(SUM(c.qty), 0)::float AS total_qty,
            COUNT(DISTINCT c.location_id)::int AS location_count
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     ${where}
     GROUP BY c.mrn_uid
     ORDER BY MAX(c.mrn_no) DESC NULLS LAST, c.mrn_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

/** Stored coils for one MRN + sticker mode — Store Out pick plan. */
export const findStoredMrnDetail = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return null;

  const [mrn] = await dbQuery(
    `SELECT m.uid AS mrn_uid, m.mrn_no, m.sticker_mode, m.item_code, m.item_dcode, m.item_desc, m.acc_name
     FROM ${T.MRN} m
     WHERE m.uid = $1
     LIMIT 1`,
    [uid]
  );

  const coils = await dbQuery(
    `SELECT c.*,
            lm.location_no,
            lm.rack_no,
            lm.row_no
     FROM ${COIL} c
     LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE c.is_deleted = false
       AND c.location_id IS NOT NULL
       AND COALESCE(c.status, 'active') = 'active'
       AND c.mrn_uid = $1
     ORDER BY lm.location_no ASC NULLS LAST, c.coil_index ASC NULLS LAST, c.coil_no_uid ASC`,
    [uid]
  );

  if (!coils.length && !mrn) return null;

  const first = coils[0] || {};
  const sticker_mode =
    String(mrn?.sticker_mode || "coil").trim().toLowerCase() === "batch" ? "batch" : "coil";

  const locMap = new Map();
  for (const c of coils) {
    const key = c.location_id != null ? String(c.location_id) : "none";
    if (!locMap.has(key)) {
      locMap.set(key, {
        location_id: c.location_id ?? null,
        location_no: c.location_no || (c.location_id != null ? `ID ${c.location_id}` : "No location"),
        rack_no: c.rack_no || null,
        row_no: c.row_no || null,
        coils: [],
      });
    }
    locMap.get(key).coils.push(c);
  }

  const heat_nos = [...new Set(coils.map((c) => c.heat_no).filter(Boolean))];
  const total_qty = coils.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const itemFromCoils =
    coils.find((c) => c.item_code)?.item_code ||
    coils.find((c) => c.item_dcode)?.item_dcode ||
    null;
  const accFromCoils = coils.find((c) => c.acc_name)?.acc_name || null;

  return {
    mrn_uid: uid,
    mrn_no: mrn?.mrn_no ?? first.mrn_no ?? null,
    sticker_mode,
    item_code: mrn?.item_code || first.item_code || itemFromCoils || null,
    item_dcode: mrn?.item_dcode ?? first.item_dcode ?? null,
    item_desc: mrn?.item_desc || first.item_desc || null,
    acc_name: mrn?.acc_name || first.acc_name || accFromCoils || null,
    heat_nos: heat_nos.join(", ") || null,
    coil_count: coils.length,
    total_qty,
    location_count: locMap.size,
    locations: [...locMap.values()],
    coils,
  };
};

const JC_ISSUE_QTY_EXPR = `COALESCE(jc.issue_qty, 0)`;

/** True when coil is on an approved issue-request job card and still pending Store Out. */
export const isCoilPendingJobCardStoreOut = async (coil_no_uid, excludeOutUid = null) => {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return false;

  const values = [uid.toLowerCase()];
  let draftExclude = "";
  if (excludeOutUid != null && excludeOutUid !== "") {
    values.push(Number(excludeOutUid));
    draftExclude = `AND o.out_uid <> $${values.length}`;
  }

  const [row] = await dbQuery(
    `WITH jc_coils AS (
       SELECT TRIM(c.coil->>'coil_no_uid') AS coil_no_uid
       FROM ${ISSUE_REQUEST} r
       INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
       ) AS c(coil)
       WHERE r.is_deleted = false AND r.approved = true
     ),
     available_coils AS (
       SELECT LOWER(TRIM(c.coil_no_uid)) AS coil_key
       FROM ${COIL} c
       WHERE c.is_deleted = false
         AND COALESCE(c.status, 'active') = 'active'
         AND c.out_uid IS NULL
     ),
     draft_blocked AS (
       SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_key
       FROM ${SCANNED} s
       JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
       WHERE COALESCE(o.approved, false) = false
         AND TRIM(s.coil_no_uid) <> ''
         ${draftExclude}
     )
     SELECT 1 AS ok
     FROM jc_coils j
     INNER JOIN available_coils s ON s.coil_key = LOWER(TRIM(j.coil_no_uid))
     LEFT JOIN draft_blocked db ON db.coil_key = s.coil_key
     WHERE LOWER(TRIM(j.coil_no_uid)) = $1
       AND TRIM(j.coil_no_uid) <> ''
       AND db.coil_key IS NULL
     LIMIT 1`,
    values
  );
  return Boolean(row);
};

/**
 * Pending Store Out grouped by approved issue-request job card.
 * Coils still not physically out (out_uid null) — store-in + coil area (same pool as Issue Request).
 * Excludes coils already on open store-out drafts.
 */
export const findPendingStoreOutByJobCard = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false", "r.approved = true", "jc.is_deleted = false"];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  const baseCte = `
    WITH jc_coils AS (
      SELECT
        r.issue_uid,
        r.shift,
        r.approved_at,
        r.approved_by AS approved_by_name,
        TRIM(jc.pjobcardno) AS pjobcardno,
        jc.macname,
        jc.item_code,
        jc.item_desc,
        jc.rm_item_code,
        jc.rm_item_desc,
        ${JC_ISSUE_QTY_EXPR}::float8 AS issue_qty,
        TRIM(c.coil->>'coil_no_uid') AS coil_no_uid
      FROM ${ISSUE_REQUEST} r
      INNER JOIN ${ISSUE_REQUEST_JC} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
      ) AS c(coil)
      ${where}
    ),
    available_coils AS (
      SELECT
        LOWER(TRIM(c.coil_no_uid)) AS coil_key,
        c.coil_no_uid,
        c.qty,
        c.mrn_uid,
        c.mrn_no,
        c.heat_no,
        lm.location_no
      FROM ${COIL} c
      LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
      WHERE c.is_deleted = false
        AND COALESCE(c.status, 'active') = 'active'
        AND c.out_uid IS NULL
    ),
    draft_blocked AS (
      SELECT DISTINCT LOWER(TRIM(s.coil_no_uid)) AS coil_key
      FROM ${SCANNED} s
      JOIN ${TABLE} o ON o.out_uid = s.out_uid AND o.is_deleted = false
      WHERE COALESCE(o.approved, false) = false
        AND TRIM(s.coil_no_uid) <> ''
    ),
    pending AS (
      SELECT
        j.issue_uid,
        j.pjobcardno,
        MAX(j.shift) AS shift,
        MAX(j.macname) AS macname,
        MAX(j.item_code) AS item_code,
        MAX(j.item_desc) AS item_desc,
        MAX(j.rm_item_code) AS rm_item_code,
        MAX(j.rm_item_desc) AS rm_item_desc,
        MAX(j.issue_qty) AS issue_qty,
        MAX(j.approved_at) AS approved_at,
        MAX(j.approved_by_name) AS approved_by_name,
        'job_card'::varchar AS pending_type,
        COUNT(s.coil_no_uid)::int AS pending_coil_count,
        COALESCE(SUM(s.qty), 0)::float8 AS pending_qty,
        STRING_AGG(DISTINCT s.mrn_no::text, ', ' ORDER BY s.mrn_no::text) AS mrn_nos,
        MIN(s.mrn_uid) AS mrn_uid,
        STRING_AGG(s.coil_no_uid, ', ' ORDER BY s.coil_no_uid) AS coil_no_uids
      FROM jc_coils j
      INNER JOIN available_coils s ON s.coil_key = LOWER(TRIM(j.coil_no_uid))
      LEFT JOIN draft_blocked db ON db.coil_key = s.coil_key
      WHERE TRIM(j.coil_no_uid) <> ''
        AND db.coil_key IS NULL
      GROUP BY j.issue_uid, j.pjobcardno
      HAVING COUNT(s.coil_no_uid) > 0
    )`;

  const countRes = await dbQuery(`${baseCte} SELECT COUNT(*)::int AS count FROM pending`, values);
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `${baseCte}
     SELECT *
     FROM pending
     ORDER BY approved_at DESC NULLS LAST, issue_uid DESC, pjobcardno ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};

/**
 * Open job-card Store Out drafts — shown in Pending after coils are scanned/submitted.
 * Keeps the two-step flow: Issue Request → scan here → authorize moves stock to shop floor.
 */
export const findPendingJobCardStoreOutDrafts = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "o.is_deleted = false",
    "COALESCE(o.approved, false) = false",
    "LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'",
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(o.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      o.out_uid::text ILIKE $${idx} OR
      o.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  const fromClause = `
    FROM ${TABLE} o
    LEFT JOIN ${ISSUE_REQUEST} ir ON ir.issue_uid = o.issue_uid AND ir.is_deleted = false
    LEFT JOIN ${ISSUE_REQUEST_JC} jc
      ON jc.issue_uid = ir.issue_uid
     AND jc.is_deleted = false
     AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM(o.pjobcardno))`;

  const countRes = await dbQuery(`SELECT COUNT(*)::int AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `SELECT
       o.out_uid,
       o.issue_uid,
       TRIM(o.pjobcardno) AS pjobcardno,
       o.scan_complete,
       o.approved,
       o.entry_type,
       o.coil_count,
       o.total_qty AS pending_qty,
       o.coil_count AS pending_coil_count,
       o.item_codes AS rm_item_code,
       o.mrn_refs AS mrn_nos,
       o.created_at,
       o.created_at AS sort_at,
       ir.shift,
       ir.approved_at,
       ir.approved_by AS approved_by_name,
       jc.macname,
       jc.item_code,
       jc.item_desc,
       jc.rm_item_desc,
       jc.issue_qty,
       'job_card'::varchar AS pending_type,
       false AS is_virtual_pending,
       (
         SELECT STRING_AGG(s.coil_no_uid, ', ' ORDER BY s.created_at ASC, s.coil_no_uid ASC)
         FROM ${SCANNED} s
         WHERE s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
       ) AS coil_no_uids
     ${fromClause}
     ${where}
     ORDER BY o.created_at DESC, o.out_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};

/**
 * RM Rejection authorized — virtual pending (no open out_entry draft) + existing store-out drafts.
 */
export const findPendingRejectionStoreOut = async (options = {}) => {
  const { search, page = 1, limit = 1000 } = options;
  const values = [];
  let i = 1;

  const openDraftExistsSql = `NOT EXISTS (
    SELECT 1 FROM ${TABLE} o
    WHERE o.is_deleted = false
      AND COALESCE(o.approved, false) = false
      AND (
        (r.out_uid IS NOT NULL AND o.out_uid = r.out_uid)
        OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid)
      )
  )`;

  const virtualConditions = [
    "r.is_deleted = false",
    "r.approved = true",
    `COALESCE(TRIM(r.bill_no), '') = ''`,
    openDraftExistsSql,
  ];
  const draftConditions = [
    "o.is_deleted = false",
    "COALESCE(o.approved, false) = false",
    "r.is_deleted = false",
    "r.approved = true",
    `COALESCE(TRIM(r.bill_no), '') = ''`,
    "(o.out_uid = r.out_uid OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid))",
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    const searchClause = `(
      COALESCE(r.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(r.heat_nos,'') ILIKE $${idx} OR
      COALESCE(r.item_codes,'') ILIKE $${idx} OR
      COALESCE(r.reason,'') ILIKE $${idx} OR
      r.qc_reject_uid::text ILIKE $${idx} OR
      COALESCE(r.out_uid::text,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${COIL} c
        WHERE c.is_deleted = false AND c.qc_reject_uid = r.qc_reject_uid
          AND COALESCE(c.coil_no_uid,'') ILIKE $${idx}
      )
    )`;
    virtualConditions.push(searchClause);
    draftConditions.push(`(
      o.out_uid::text ILIKE $${idx} OR
      COALESCE(o.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(o.heat_nos,'') ILIKE $${idx} OR
      COALESCE(o.item_codes,'') ILIKE $${idx} OR
      COALESCE(r.reason,'') ILIKE $${idx} OR
      r.qc_reject_uid::text ILIKE $${idx}
    )`);
  }

  const virtualWhere = `WHERE ${virtualConditions.join(" AND ")}`;
  const draftWhere = `WHERE ${draftConditions.join(" AND ")}`;

  const virtualRows = await dbQuery(
    `SELECT
       NULL::int AS out_uid,
       r.qc_reject_uid,
       r.mrn_refs AS mrn_no,
       r.mrn_refs,
       r.heat_nos AS heat_no,
       r.heat_nos,
       r.item_codes AS item_code,
       r.item_codes,
       r.total_qty AS qty,
       r.total_qty,
       r.coil_count,
       false AS scan_complete,
       r.remarks,
       r.remarks AS rejection_remarks,
       r.approved_at AS created_at,
       'rm_rejection'::varchar AS entry_type,
       r.reason,
       r.ipr_uid,
       'rejection'::varchar AS pending_type,
       true AS is_virtual_pending,
       r.approved_at AS sort_at
     FROM ${REJECTION} r
     ${virtualWhere}`,
    values
  );

  const draftFrom = `
    FROM ${TABLE} o
    INNER JOIN ${REJECTION} r ON r.is_deleted = false
      AND r.approved = true
      AND (o.out_uid = r.out_uid OR (o.qc_reject_uid IS NOT NULL AND o.qc_reject_uid = r.qc_reject_uid))`;

  const draftRows = await dbQuery(
    `SELECT
       o.out_uid,
       o.qc_reject_uid,
       o.mrn_refs AS mrn_no,
       o.mrn_refs,
       o.heat_nos AS heat_no,
       o.heat_nos,
       o.item_codes AS item_code,
       o.item_codes,
       o.total_qty AS qty,
       o.total_qty,
       o.coil_count,
       o.scan_complete,
       o.remarks,
       r.remarks AS rejection_remarks,
       o.created_at,
       o.entry_type,
       r.reason,
       r.ipr_uid,
       'rejection'::varchar AS pending_type,
       false AS is_virtual_pending,
       o.created_at AS sort_at
     ${draftFrom}
     ${draftWhere}`,
    values
  );

  const merged = [...(virtualRows || []), ...(draftRows || [])].sort((a, b) => {
    const ta = new Date(a.sort_at || 0).getTime();
    const tb = new Date(b.sort_at || 0).getTime();
    return tb - ta;
  });

  const total = merged.length;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;
  const data = merged.slice(offset, offset + safeLimit);

  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
};
