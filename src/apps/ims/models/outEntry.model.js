import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { BOX_TX_TYPES } from "../constants/boxTransactionTypes.js";
import { logBoxTransactionSafe, singlePackingFromRows } from "../utils/box/logBoxTransaction.js";

/** Store Out — DB access for ims_out_entry (list, CRUD, box links, FUID details). */

const ALLOWED_FILTER_FIELDS = ["out_uid", "fuid", "qc_hold_id", "reason", "entry_type", "approved", "scan_complete", "from_date", "to_date"];

const ALLOWED_SORT_FIELDS = ["created_at", "approved_at", "updated_at", "out_uid"];

const ALLOWED_UPDATE_FIELDS = [
  "fuid",
  "qc_hold_id",
  "reason",
  "entry_type",
  "packing_numbers",
  "item_codes",
  "qtys",
  "total_qty",
  "remarks",
  "approved",
  "approved_by",
  "approved_at",
  "updated_by",
  "updated_at",
  "scan_complete",
  "boxes_required",
  "boxes_scanned",
];

const JOINS = `
  LEFT JOIN ${M.USERS} u_cr  ON o.created_by  = u_cr.id
  LEFT JOIN ${M.USERS} u_upd ON o.updated_by  = u_upd.id
  LEFT JOIN ${M.USERS} u_dl  ON o.deleted_by  = u_dl.id
  LEFT JOIN ${M.USERS} u_ap  ON o.approved_by = u_ap.id
`;

const DEFAULT_FIELDS = [
  "o.out_uid", "o.fuid", "o.qc_hold_id", "o.reason",
  "o.entry_type",
  "o.packing_numbers", "o.item_codes", "o.qtys", "o.total_qty",
  "o.remarks",
  "o.approved", "o.approved_by", "o.approved_at",
  "o.scan_complete", "o.boxes_required", "o.boxes_scanned",
  "o.created_by", "o.created_at",
  "o.updated_by", "o.updated_at",
  "o.is_deleted", "o.deleted_by", "o.deleted_at",
  "u_cr.name  AS created_by_name",
  "u_upd.name AS updated_by_name",
  "u_dl.name  AS deleted_by_name",
  "u_ap.name  AS approved_by_name"
];

export const findOutEntries = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {} } = options;

  const values = [];
  let i = 1;

  const safeFields = fields.length > 0 
    ? fields.map(f => {
        if (f === "created_by_name") return "u_cr.name AS created_by_name";
        if (f === "updated_by_name") return "u_upd.name AS updated_by_name";
        if (f === "approved_by_name") return "u_ap.name AS approved_by_name";
        if (f === "deleted_by_name") return "u_dl.name AS deleted_by_name";
        if (f.includes('.')) return f;
        return `o.${f}`;
      }).join(", ")
    : DEFAULT_FIELDS.join(", ");

  const conditions = ["o.is_deleted = false"];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`o.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`o.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`o.created_at <= $${i++}`);
      continue;
    }

    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`o.${key} = $${i++}`);
  }

  // SEARCH
  if (search) {
    const searchTerm = `%${search}%`;
    values.push(searchTerm);
    conditions.push(`(o.remarks ILIKE $${i} OR u_cr.name ILIKE $${i})`);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // COUNT
  const [{ count }] = await dbQuery(`SELECT COUNT(*) AS count FROM ims_out_entry o ${JOINS} ${where}`, values);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  // SORTING
  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";

  const queryValues = [...values, safeLimit, offset];

  const rows = await dbQuery(
    `SELECT ${safeFields}
     FROM ims_out_entry o
     ${JOINS}
     ${where}
     ORDER BY o.${sortByField} ${sortOrder} 
     LIMIT $${i++} OFFSET $${i++}`,
    queryValues
  );

  return {
    data: rows,
    total: Number(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit)
  };
};

export const findOutEntry = async (filters = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return null;

  const values = [];
  let i = 1;
  const conditions = ["o.is_deleted = false"];

  for (const key of keys) {
    if (key !== "out_uid" && !ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(filters[key]);
    conditions.push(`o.${key} = $${i++}`);
  }

  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ims_out_entry o
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values
  );

  return row ?? null;
};

export const insertOutEntry = async (data, { client = null } = {}) => {
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
  
  const row = await run(
    `INSERT INTO ims_out_entry (${keys.join(", ")}) 
     VALUES (${placeholders}) 
     RETURNING *`,
    values
  );
  return client?.query ? row.rows[0] : row[0];
};

export const updateOutEntries = async (fields = {}, filters = {}, { client = null } = {}) => {
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const fieldKeys = Object.keys(fields).filter(k => ALLOWED_UPDATE_FIELDS.includes(k));
  const filterKeys = Object.keys(filters).filter(k => k === "out_uid" || ALLOWED_FILTER_FIELDS.includes(k));

  if (!fieldKeys.length || !filterKeys.length) throw new Error("Invalid update request");

  const setClause = fieldKeys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  const whereClause = filterKeys.map((k, idx) => `${k} = $${fieldKeys.length + idx + 1}`).join(" AND ");
  const values = [...fieldKeys.map(k => fields[k]), ...filterKeys.map(k => filters[k])];

  const row = await run(
    `UPDATE ims_out_entry SET ${setClause} WHERE ${whereClause} RETURNING *`,
    values
  );
  return client?.query ? row.rows[0] : row[0];
};

export const deleteOutEntries = async (filters = {}, meta = {}) => {
  const { client = null, deleted_by = null } = meta;
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  const keys = Object.keys(filters);
  const values = [];
  let i = 1;
  const conditions = [];

  for (const k of keys) {
    if (k !== "out_uid" && !ALLOWED_FILTER_FIELDS.includes(k)) continue;
    values.push(filters[k]);
    conditions.push(`${k} = $${i++}`);
  }

  values.push(deleted_by ?? null);
  await run(
    `UPDATE ims_out_entry SET is_deleted = true, deleted_at = NOW(), deleted_by = $${i}
     WHERE ${conditions.join(" AND ")}`,
    values
  );
};

const OUT_ENTRY_BOX_JSON_AGG = `
  json_agg(
    json_build_object(
      'box_uid', b.box_uid,
      'box_no_uid', b.box_no_uid,
      'qty', b.qty,
      'is_loose', b.is_loose,
      'out_uid', b.out_uid,
      'sa_id', b.sa_id,
      'sa_entry_type', b.sa_entry_type,
      'stock_adjustment_id', b.sa_id,
      'inventory_status', CASE
        WHEN b.sa_entry_type = 'stock_out'
          OR (b.sa_id IS NOT NULL AND b.out_uid IS NOT NULL AND b.out_uid::text = b.sa_id::text)
          THEN 'stock_adjustment'
        WHEN b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL THEN 'in_hand'
        ELSE 'outward'
      END,
      'is_in_hand', CASE
        WHEN (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL)
          AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
          THEN true
        ELSE false
      END,
      'is_outward', CASE
        WHEN b.out_uid IS NOT NULL
          AND NULLIF(TRIM(b.out_uid::text), '') IS NOT NULL
          AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
          AND NOT (b.sa_id IS NOT NULL AND b.out_uid::text = b.sa_id::text)
          THEN true
        ELSE false
      END,
      'is_stock_adjustment', CASE
        WHEN b.sa_entry_type = 'stock_out'
          OR (b.sa_id IS NOT NULL AND b.out_uid IS NOT NULL AND b.out_uid::text = b.sa_id::text)
          THEN true
        ELSE false
      END,
      'is_out', CASE
        WHEN b.out_uid IS NOT NULL
          AND NULLIF(TRIM(b.out_uid::text), '') IS NOT NULL
          AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
          AND NOT (b.sa_id IS NOT NULL AND b.out_uid::text = b.sa_id::text)
          THEN true
        ELSE false
      END,
      'is_out_current', CASE
        WHEN $3::INTEGER IS NOT NULL AND EXISTS (
          SELECT 1 FROM ims_out_entry_scanned_box d
          WHERE d.out_uid = $3::INTEGER AND d.box_no_uid = b.box_no_uid::text
        ) THEN true
        WHEN $3::INTEGER IS NOT NULL AND b.out_uid::text = $3::text AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
          AND EXISTS (
            SELECT 1 FROM ims_out_entry o
            WHERE o.out_uid::text = $3::text AND o.approved = true AND o.is_deleted = false
          ) THEN true
        ELSE false
      END
    ) ORDER BY b.box_uid ASC
  ) AS boxes
`;

/** In-hand, draft scans for this out_uid, or finalized outward on approved out entries only. */
const OUT_ENTRY_BOX_AVAILABILITY_SQL = `
  b.is_deleted = false
  AND (
    (b.out_uid IS NULL AND b.sa_entry_type IS DISTINCT FROM 'stock_out')
    OR (
      $3::INTEGER IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ims_out_entry_scanned_box d
        WHERE d.out_uid = $3::INTEGER AND d.box_no_uid = b.box_no_uid::text
      )
    )
    OR (
      b.out_uid IS NOT NULL
      AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
      AND EXISTS (
        SELECT 1 FROM ims_out_entry o
        WHERE o.out_uid::text = b.out_uid::text
          AND o.approved = true
          AND o.is_deleted = false
          AND (o.fuid = $2 OR ($3::INTEGER IS NOT NULL AND o.out_uid::text = $3::text))
      )
    )
  )
`;

export const findFuidDetailsForOutEntry = async (fuid, forOutUid = null) => {
  const outUidParam = forOutUid != null && forOutUid !== "" ? Number(forOutUid) : null;

  const packingRows = await dbQuery(`
    SELECT fi.*, fi.item_dcode::text AS item_code, NULL::text AS itemdesc
    FROM ims_forwarding_note_item_wise fi
    WHERE fi.fuid = $1 AND fi.is_deleted = false
    ORDER BY fi.id ASC
  `, [fuid]);

  // 2. Per packing: in-store locations + packing area (no location yet, still in hand)
  const itemsWithLocations = await Promise.all(packingRows.map(async (item) => {
    const params = [item.packing_number, fuid, outUidParam];

    const [packingAreaRows, inStoreRows] = await Promise.all([
      dbQuery(
        `
      SELECT
        NULL::integer AS location_id,
        'Packing Area'::text AS location_name,
        true AS is_packing_area,
        count(b.box_uid)::int AS box_count,
        coalesce(sum(b.qty), 0)::int AS total_qty,
        ${OUT_ENTRY_BOX_JSON_AGG}
      FROM ims_box_table b
      WHERE b.packing_number = $1
        AND b.location_id IS NULL
        AND ${OUT_ENTRY_BOX_AVAILABILITY_SQL}
      HAVING count(b.box_uid) > 0
      `,
        params
      ),
      dbQuery(
        `
      SELECT
        loc.location_id,
        COALESCE(loc.location_no, CONCAT(loc.rack_no, UPPER(COALESCE(loc.shelf_no, '')))) AS location_name,
        false AS is_packing_area,
        count(b.box_uid)::int AS box_count,
        coalesce(sum(b.qty), 0)::int AS total_qty,
        ${OUT_ENTRY_BOX_JSON_AGG}
      FROM ims_box_table b
      INNER JOIN ims_location_master loc ON b.location_id = loc.location_id
      WHERE b.packing_number = $1
        AND ${OUT_ENTRY_BOX_AVAILABILITY_SQL}
      GROUP BY loc.location_id, loc.location_no, loc.rack_no, loc.shelf_no
      `,
        params
      ),
    ]);

    const locations = [...(packingAreaRows || []), ...(inStoreRows || [])];

    return {
      ...item,
      locations,
    };
  }));

  return itemsWithLocations;
};

/** Draft scans (no stock impact until out entry is approved). */
export const findOutEntryDraftBoxUids = async (out_uid) => {
  if (!out_uid) return [];
  const rows = await dbQuery(
    `SELECT box_no_uid::text AS box_no_uid
     FROM ims_out_entry_scanned_box
     WHERE out_uid = $1
     ORDER BY box_no_uid ASC`,
    [out_uid]
  );
  return (rows || []).map((r) => String(r.box_no_uid).trim()).filter(Boolean);
};

export const replaceOutEntryDraftScans = async ({ out_uid, scanned_boxes = [] }, { client = null } = {}) => {
  if (!out_uid) return [];
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  await run(`DELETE FROM ims_out_entry_scanned_box WHERE out_uid = $1`, [out_uid]);
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return [];
  const values = [];
  const placeholders = uids.map((uid, i) => {
    values.push(out_uid, uid);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  });
  await run(
    `INSERT INTO ims_out_entry_scanned_box (out_uid, box_no_uid) VALUES ${placeholders.join(", ")}`,
    values
  );
  return uids;
};

export const clearOutEntryDraftScans = async (out_uid, { client = null } = {}) => {
  if (!out_uid) return;
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  await run(`DELETE FROM ims_out_entry_scanned_box WHERE out_uid = $1`, [out_uid]);
};

/** Boxes saved for this out entry   draft table or approved ims_box_table links. */
export const findOutEntryLinkedBoxes = async (out_uid) => {
  if (!out_uid) return [];
  const [entry] = await dbQuery(
    `SELECT approved, entry_type FROM ims_out_entry WHERE out_uid = $1 AND is_deleted = false LIMIT 1`,
    [out_uid]
  );
  if (entry?.entry_type === "other" || entry?.entry_type === "packing_area" || entry?.entry_type === "qc_area") {
    return dbQuery(
      `SELECT d.box_no_uid::text AS box_no_uid,
              b.packing_number,
              b.is_loose,
              NULL::integer AS out_uid,
              b.sa_id,
              b.sa_entry_type,
              b.qty,
              b.location_id
       FROM ims_out_entry_scanned_box d
       INNER JOIN ims_box_table b ON b.box_no_uid::text = d.box_no_uid AND b.is_deleted = false
       WHERE d.out_uid = $1
       ORDER BY d.box_no_uid ASC`,
      [out_uid]
    );
  }
  if (entry?.approved) {
    return dbQuery(
      `SELECT b.box_no_uid::text AS box_no_uid,
              b.packing_number,
              b.is_loose,
              b.out_uid,
              b.sa_id,
              b.sa_entry_type
       FROM ims_box_table b
       WHERE b.out_uid = $1 AND b.is_deleted = false
       ORDER BY b.box_uid ASC`,
      [out_uid]
    );
  }
  return dbQuery(
    `SELECT d.box_no_uid::text AS box_no_uid,
            b.packing_number,
            b.is_loose,
            NULL::integer AS out_uid,
            b.sa_id,
            b.sa_entry_type
     FROM ims_out_entry_scanned_box d
     INNER JOIN ims_box_table b ON b.box_no_uid::text = d.box_no_uid AND b.is_deleted = false
     WHERE d.out_uid = $1
     ORDER BY d.box_no_uid ASC`,
    [out_uid]
  );
};

/** Other out entry: remove store location and return boxes to packing area. */
export const applyOutEntryOtherReturn = async ({ out_uid, userId, scanned_boxes = [] }, { client = null } = {}) => {
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!out_uid || !uids.length) return [];

  await replaceOutEntryDraftScans({ out_uid, scanned_boxes: uids }, { client });

  const rows = await run(
    `UPDATE ims_box_table
     SET location_id = NULL,
         in_uid = NULL,
         updated_by = $1,
         updated_at = NOW()
     WHERE box_no_uid = ANY($2::text[])
       AND is_deleted = false
       AND out_uid IS NULL
       AND sa_entry_type IS DISTINCT FROM 'stock_out'
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose, location_id`,
    [userId, uids]
  );

  const resultRows = client?.query ? rows.rows : rows;

  if (resultRows?.length) {
    logBoxTransactionSafe({
      client,
      transaction_type: BOX_TX_TYPES.OUT_OTHER_RETURN_TO_PACKING,
      source_module: "out_entry",
      source_id: String(out_uid),
      packing_number: singlePackingFromRows(resultRows),
      user_id: userId,
      rows: resultRows,
      details: {
        out_uid,
        entry_type: "packing_area",
        packing_numbers: [...new Set(resultRows.map((r) => r.packing_number).filter(Boolean))],
        box_count: resultRows.length,
      },
    });
  }
  return resultRows;
};

/** QC Area out entry: move in-store held boxes to QC area (clear location, keep qc_hold_id). */
export const applyOutEntryQcAreaRelease = async (
  { out_uid, userId, scanned_boxes = [], qc_hold_id = null },
  { client = null } = {}
) => {
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  const holdId = Number(qc_hold_id);
  if (!out_uid || !uids.length || !Number.isFinite(holdId) || holdId <= 0) return [];

  await replaceOutEntryDraftScans({ out_uid, scanned_boxes: uids }, { client });

  const rows = await run(
    `UPDATE ims_box_table
     SET location_id = NULL,
         in_uid = NULL,
         qc_hold_id = $3::integer,
         updated_by = $1,
         updated_at = NOW()
     WHERE box_no_uid = ANY($2::text[])
       AND is_deleted = false
       AND out_uid IS NULL
       AND sa_entry_type IS DISTINCT FROM 'stock_out'
       AND qc_hold_id = $3::integer
       AND (location_id IS NOT NULL OR in_uid IS NOT NULL)
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose, location_id, qc_hold_id`,
    [userId, uids, holdId]
  );

  const resultRows = client?.query ? rows.rows : rows;

  if (resultRows?.length) {
    logBoxTransactionSafe({
      client,
      transaction_type: BOX_TX_TYPES.OUT_QC_AREA_RELEASE,
      source_module: "out_entry",
      source_id: String(out_uid),
      packing_number: singlePackingFromRows(resultRows),
      user_id: userId,
      rows: resultRows,
      details: {
        out_uid,
        qc_hold_id: holdId,
        entry_type: "qc_area",
        moved_to_qc_area: true,
        packing_numbers: [...new Set(resultRows.map((r) => r.packing_number).filter(Boolean))],
        box_count: resultRows.length,
      },
    });
  }
  return resultRows;
};

/** Apply stock: link boxes on ims_box_table. Call only when out entry is approved. */
export const applyOutEntryApprovedStock = async ({ out_uid, userId, scanned_boxes = [] }, { client = null } = {}) => {
  await clearOutEntryDraftScans(out_uid, { client });
  await resetBoxesForOutEntry(out_uid, userId, { client });
  if (scanned_boxes?.length) {
    await linkBoxesToOutEntry({ out_uid, userId, scanned_boxes }, { client });
  }
};

/** Draft save: scans stored without out_uid on boxes (stock unchanged). */
export const saveOutEntryDraftScans = async ({ out_uid, userId, scanned_boxes = [] }, { client = null } = {}) => {
  await resetBoxesForOutEntry(out_uid, userId, { client });
  return replaceOutEntryDraftScans({ out_uid, scanned_boxes }, { client });
};

export const linkBoxesToOutEntry = async ({ out_uid, userId, scanned_boxes = [] }, { client = null } = {}) => {
  if (!out_uid || !Array.isArray(scanned_boxes) || scanned_boxes.length === 0) return [];
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const rows = await run(
    `UPDATE ims_box_table
     SET out_uid = $1,
         updated_by = $2,
         updated_at = NOW()
     WHERE box_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND out_uid IS NULL
       AND sa_entry_type IS DISTINCT FROM 'stock_out'
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [out_uid, userId, scanned_boxes]
  );
  const resultRows = client?.query ? rows.rows : rows;
  if (resultRows?.length) {
    logBoxTransactionSafe({
      client,
      transaction_type: BOX_TX_TYPES.OUT_LINK,
      source_module: "out_entry",
      source_id: String(out_uid),
      packing_number: singlePackingFromRows(resultRows),
      user_id: userId,
      rows: resultRows,
      details: {
        out_uid,
        packing_numbers: [...new Set(resultRows.map((r) => r.packing_number).filter(Boolean))],
      },
    });
  }
  return resultRows;
};

export const resetBoxesForOutEntry = async (out_uid, userId = null, { client = null } = {}) => {
  if (!out_uid) return [];
  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const rows = await run(
    `UPDATE ims_box_table
     SET out_uid = NULL,
         updated_at = NOW()
     WHERE out_uid = $1
       AND sa_entry_type IS DISTINCT FROM 'stock_out'
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [out_uid]
  );

  const resultRows = client?.query ? rows.rows : rows;

  if (resultRows?.length) {
    logBoxTransactionSafe({
      client,
      transaction_type: BOX_TX_TYPES.OUT_UNLINK,
      source_module: "out_entry",
      source_id: String(out_uid),
      packing_number: singlePackingFromRows(resultRows),
      user_id: userId,
      rows: resultRows,
      details: {
        out_uid,
        packing_numbers: [...new Set(resultRows.map((r) => r.packing_number).filter(Boolean))],
      },
    });
  }
  return resultRows;
};

// Strict rule: one FUID can be linked to only one out entry ever.
export const findAnyOutEntryByFuid = async ({ fuid, excludeOutUid } = {}) => {
  if (!fuid) return null;
  const values = [fuid];
  let where = "fuid = $1";

  if (excludeOutUid !== undefined && excludeOutUid !== null) {
    values.push(excludeOutUid);
    where += ` AND out_uid <> $${values.length}`;
  }

  const [row] = await dbQuery(
    `SELECT out_uid, fuid, is_deleted
     FROM ims_out_entry
     WHERE ${where}
       AND is_deleted = false
     LIMIT 1`,
    values
  );
  return row ?? null;
};

/** Distinct reasons used on inventory out / packing area entries (dropdown suggestions). */
export const findDistinctOutEntryReasons = async ({ search, limit = 200 } = {}) => {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const values = [];
  let i = 1;
  const conditions = [
    "is_deleted = false",
    "BTRIM(reason) <> ''",
    "entry_type IN ('inventory_out', 'packing_area', 'other', 'qc_area')",
  ];

  if (search && String(search).trim()) {
    values.push(`%${String(search).trim().slice(0, 100)}%`);
    conditions.push(`reason ILIKE $${i++}`);
  }

  const rows = await dbQuery(
    `SELECT reason, MAX(created_at) AS last_used_at
     FROM ims_out_entry
     WHERE ${conditions.join(" AND ")}
     GROUP BY reason
     ORDER BY last_used_at DESC, reason ASC
     LIMIT $${i}`,
    [...values, safeLimit]
  );

  return rows || [];
};

const QC_HOLD_BOX_BASE_SQL = `
  b.is_deleted = false
  AND b.qc_hold_id = $1::integer
  AND b.out_uid IS NULL
  AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
`;

/** Live in-store boxes on a QC hold (scan to move from store → QC area). */
export const findInStoreBoxesOnQcHold = async (hold_id) => {
  const holdNum = Number(hold_id);
  if (!Number.isFinite(holdNum) || holdNum <= 0) return [];
  return dbQuery(
    `SELECT b.box_uid,
            b.box_no_uid,
            b.packing_number,
            b.qty,
            b.is_loose,
            b.location_id,
            b.qc_hold_id,
            b.in_uid,
            b.out_uid,
            b.sa_entry_type,
            b.is_deleted,
            COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
     FROM ims_box_table b
     LEFT JOIN ims_location_master lm ON b.location_id = lm.location_id
     WHERE ${QC_HOLD_BOX_BASE_SQL}
       AND (b.location_id IS NOT NULL OR b.in_uid IS NOT NULL)
     ORDER BY location_no NULLS LAST, b.box_no_uid ASC`,
    [holdNum]
  );
};

/** Packing-area boxes on QC hold (already in QC area — no scan required). */
export const countPackingAreaBoxesOnQcHold = async (hold_id) => {
  const holdNum = Number(hold_id);
  if (!Number.isFinite(holdNum) || holdNum <= 0) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS c
     FROM ims_box_table b
     WHERE ${QC_HOLD_BOX_BASE_SQL}
       AND b.location_id IS NULL
       AND b.in_uid IS NULL`,
    [holdNum]
  );
  return Number(row?.c) || 0;
};

/** @deprecated Use findInStoreBoxesOnQcHold — kept for callers that need all hold boxes. */
export const findBoxesOnQcHold = async (hold_id) => {
  const holdNum = Number(hold_id);
  if (!Number.isFinite(holdNum) || holdNum <= 0) return [];
  return dbQuery(
    `SELECT b.box_uid,
            b.box_no_uid,
            b.packing_number,
            b.qty,
            b.is_loose,
            b.location_id,
            b.qc_hold_id,
            b.in_uid,
            b.out_uid,
            b.sa_entry_type,
            b.is_deleted
     FROM ims_box_table b
     WHERE ${QC_HOLD_BOX_BASE_SQL}
     ORDER BY b.box_no_uid ASC`,
    [holdNum]
  );
};

/** QC hold header + boxes for out-entry scanning UI. */
export const findQcHoldDetailsForOutEntry = async (hold_id, forOutUid = null) => {
  const holdNum = Number(hold_id);
  if (!Number.isFinite(holdNum) || holdNum <= 0) return null;

  const [hold] = await dbQuery(
    `SELECT h.hold_id,
            h.packing_number,
            h.item_dcode,
            h.reason,
            h.approved,
            h.hold_data
     FROM ims_qc_hold_material h
     WHERE h.hold_id = $1
       AND h.is_deleted = false
     LIMIT 1`,
    [holdNum]
  );
  if (!hold) return null;

  const [liveStoreBoxes, packingAreaBoxCount] = await Promise.all([
    findInStoreBoxesOnQcHold(holdNum),
    countPackingAreaBoxesOnQcHold(holdNum),
  ]);
  const linked = forOutUid ? await findOutEntryLinkedBoxes(forOutUid) : [];
  const linkedSet = new Set((linked || []).map((b) => String(b.box_no_uid).trim()).filter(Boolean));

  const boxes = (liveStoreBoxes || []).map((b) => ({
    ...b,
    is_in_store: true,
    is_needs_scan: true,
    is_scanned: linkedSet.has(String(b.box_no_uid).trim()),
  }));

  for (const row of linked || []) {
    const uid = String(row.box_no_uid ?? "").trim();
    if (!uid || boxes.some((b) => String(b.box_no_uid).trim() === uid)) continue;
    boxes.push({
      box_uid: row.box_uid ?? null,
      box_no_uid: uid,
      packing_number: row.packing_number ?? hold.packing_number,
      qty: row.qty ?? 0,
      is_loose: row.is_loose === true || row.is_loose === 1,
      location_id: row.location_id ?? null,
      location_no: row.location_no ?? null,
      qc_hold_id: holdNum,
      is_in_store: true,
      is_needs_scan: false,
      is_scanned: true,
      is_released: true,
    });
  }

  boxes.sort((a, b) => {
    const locCmp = String(a.location_no ?? "").localeCompare(String(b.location_no ?? ""));
    if (locCmp !== 0) return locCmp;
    return String(a.box_no_uid).localeCompare(String(b.box_no_uid));
  });

  const storeBoxCount = boxes.filter((b) => b.is_needs_scan !== false && !b.is_released).length;

  return {
    hold_id: hold.hold_id,
    packing_number: hold.packing_number,
    item_dcode: hold.item_dcode,
    reason: hold.reason,
    approved: hold.approved,
    boxes,
    store_box_count: storeBoxCount,
    packing_area_box_count: packingAreaBoxCount,
    box_count: storeBoxCount + packingAreaBoxCount,
    hold_balance_qty: Number(hold.hold_data?.balance_qty ?? hold.hold_data?.qty ?? 0) || 0,
  };
};
