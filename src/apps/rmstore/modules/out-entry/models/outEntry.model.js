import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.OUT_ENTRY;
const SCANNED = T.OUT_ENTRY_SCANNED_COIL;
const COIL = T.COIL_TABLE;
const LOC = T.MASTER_LOCATION;

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
    entry_type, qc_reject_uid, mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count,
    location_refs, remarks, created_by, scan_complete,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (entry_type, qc_reject_uid, mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count,
      location_refs, remarks, created_by, scan_complete)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      entry_type ?? "store_out",
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
    `SELECT m.uid AS mrn_uid, m.mrn_no, m.sticker_mode, m.item_code, m.item_desc, m.acc_name
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

  return {
    mrn_uid: uid,
    mrn_no: mrn?.mrn_no ?? first.mrn_no ?? null,
    sticker_mode,
    item_code: mrn?.item_code || first.item_code || null,
    item_desc: mrn?.item_desc || first.item_desc || null,
    acc_name: mrn?.acc_name || null,
    heat_nos: heat_nos.join(", ") || null,
    coil_count: coils.length,
    total_qty,
    location_count: locMap.size,
    locations: [...locMap.values()],
    coils,
  };
};

/**
 * Pending Store Out list — coil-wise vs batch-wise (same idea as QC Check).
 * Coil MRNs → one row per stored coil.
 * Batch MRNs → one aggregated row per mrn_uid.
 * expand_coils: true → never aggregate (flat coil list).
 */
export const findStoredPendingForOut = async (options = {}) => {
  const { search, page = 1, limit = 1000, expand_coils = false } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "c.is_deleted = false",
    "c.location_id IS NOT NULL",
    `COALESCE(c.status, 'active') = 'active'`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      c.coil_no_uid ILIKE $${idx} OR
      COALESCE(c.mrn_uid, '') ILIKE $${idx} OR
      COALESCE(c.heat_no, '') ILIKE $${idx} OR
      COALESCE(c.item_code, '') ILIKE $${idx} OR
      COALESCE(c.item_desc, '') ILIKE $${idx} OR
      c.mrn_no::text ILIKE $${idx} OR
      COALESCE(lm.location_no, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const expand = expand_coils === true || expand_coils === "true";
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  if (expand) {
    const countRes = await dbQuery(
      `SELECT COUNT(*)::int AS count
       FROM ${COIL} c
       LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
       ${where}`,
      values
    );
    const total = Number(countRes[0]?.count || 0);
    const rows = await dbQuery(
      `SELECT c.*,
              lm.location_no,
              lm.rack_no,
              lm.row_no,
              COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil')::varchar AS sticker_mode,
              1::int AS coil_count,
              false AS is_batch_pending
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
       ${where}
       ORDER BY c.coil_uid DESC
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
  }

  const countRes = await dbQuery(
    `WITH stored AS (
       SELECT
         c.coil_no_uid,
         c.mrn_uid,
         COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil') AS sticker_mode
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
       ${where}
     )
     SELECT COUNT(*)::int AS count FROM (
       SELECT coil_no_uid FROM stored WHERE sticker_mode <> 'batch'
       UNION ALL
       SELECT mrn_uid FROM stored WHERE sticker_mode = 'batch' AND mrn_uid IS NOT NULL GROUP BY mrn_uid
     ) x`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const rows = await dbQuery(
    `WITH stored AS (
       SELECT
         c.coil_uid,
         c.coil_no_uid,
         c.mrn_uid,
         c.mrn_no,
         c.heat_no,
         c.item_dcode,
         c.item_code,
         c.item_desc,
         c.qty,
         c.location_id,
         lm.location_no,
         lm.rack_no,
         lm.row_no,
         c.created_at,
         c.created_by,
         COALESCE(NULLIF(LOWER(TRIM(m.sticker_mode)), ''), 'coil') AS sticker_mode
       FROM ${COIL} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       LEFT JOIN ${LOC} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
       ${where}
     ),
     coil_rows AS (
       SELECT
         coil_uid,
         coil_no_uid,
         mrn_uid,
         mrn_no,
         heat_no,
         item_dcode,
         item_code,
         item_desc,
         qty,
         location_id,
         location_no,
         rack_no,
         row_no,
         created_at,
         created_by,
         sticker_mode,
         1::int AS coil_count,
         false AS is_batch_pending
       FROM stored
       WHERE sticker_mode <> 'batch'
     ),
     batch_rows AS (
       SELECT
         MIN(coil_uid)::int AS coil_uid,
         STRING_AGG(coil_no_uid, ', ' ORDER BY created_at ASC, coil_no_uid ASC)::varchar AS coil_no_uid,
         mrn_uid,
         MAX(mrn_no) AS mrn_no,
         MAX(heat_no) AS heat_no,
         MAX(item_dcode) AS item_dcode,
         MAX(item_code) AS item_code,
         MAX(item_desc) AS item_desc,
         SUM(COALESCE(qty, 0)) AS qty,
         NULL::int AS location_id,
         CASE
           WHEN COUNT(DISTINCT location_id) = 1 THEN MAX(location_no)
           ELSE (COUNT(DISTINCT location_id)::text || ' locs')
         END AS location_no,
         NULL::varchar AS rack_no,
         NULL::varchar AS row_no,
         MAX(created_at) AS created_at,
         MAX(created_by) AS created_by,
         'batch'::varchar AS sticker_mode,
         COUNT(*)::int AS coil_count,
         true AS is_batch_pending
       FROM stored
       WHERE sticker_mode = 'batch' AND mrn_uid IS NOT NULL
       GROUP BY mrn_uid
     )
     SELECT * FROM (
       SELECT * FROM coil_rows
       UNION ALL
       SELECT * FROM batch_rows
     ) u
     ORDER BY created_at DESC NULLS LAST, coil_uid DESC
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
