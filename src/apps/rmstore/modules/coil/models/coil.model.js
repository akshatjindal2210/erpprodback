import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { hasCoilJourneyFilter, appendCoilJourneyCondition } from "../../../lib/utils/logJourneyFilter.js";

const TABLE = T.COIL_TABLE;

/** IMS sticker-prefix coil UID: {prefix}_mrnno_serialno_totalno_colino e.g. 26_1001_3_10_03 */
export function formatCoilNoUid({ prefix, mrn_no, serial_no, total, index }) {
  const pfx = String(prefix ?? "").trim() || "0";
  const mrn = String(mrn_no ?? "").trim() || "0";
  const serial = String(serial_no ?? "").trim() || "0";
  const tb = String(Math.max(1, Number(total) || 1)).padStart(2, "0");
  const bi = String(Math.max(1, Number(index) || 1)).padStart(2, "0");
  return `${pfx}_${mrn}_${serial}_${tb}_${bi}`;
}

export const findCoils = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, sortBy = "coil_uid", order = "DESC" } = options;
  const values = [];
  let i = 1;
  const conditions = ["c.is_deleted = false"];
  const journeyMode = hasCoilJourneyFilter(filters);

  const status = filters.status != null && String(filters.status).trim() !== ""
    ? String(filters.status).trim().toLowerCase()
    : null;

  if (filters.coil_area === true || filters.coil_area === "true") {
    conditions.push("c.location_id IS NULL");
    conditions.push(`COALESCE(c.status, 'active') = 'active'`);
    // MRN stickers OR Stock Adjustment Add coils (no mrn_uid)
    conditions.push(`(
      NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL
      OR (c.sa_id IS NOT NULL AND COALESCE(c.sa_entry_type, '') = 'stock_in')
    )`);
  }
  if (filters.stored === true || filters.stored === "true") {
    conditions.push("c.location_id IS NOT NULL");
    conditions.push(`COALESCE(c.status, 'active') = 'active'`);
  }
  if (status) {
    values.push(status);
    conditions.push(`COALESCE(c.status, 'active') = $${i++}`);
  }
  if (filters.qc_reject_uid != null && filters.qc_reject_uid !== "") {
    values.push(Number(filters.qc_reject_uid));
    conditions.push(`c.qc_reject_uid = $${i++}`);
  }
  if (filters.out_uid != null && filters.out_uid !== "") {
    values.push(Number(filters.out_uid));
    conditions.push(`c.out_uid = $${i++}`);
  }
  if (filters.mrn_uid != null && filters.mrn_uid !== "") {
    values.push(String(filters.mrn_uid).trim());
    conditions.push(`c.mrn_uid = $${i++}`);
  }
  // legacy alias
  if (filters.mrn_id != null && filters.mrn_id !== "" && (filters.mrn_uid == null || filters.mrn_uid === "")) {
    values.push(String(filters.mrn_id).trim());
    conditions.push(`c.mrn_uid = $${i++}`);
  }
  if (filters.mrn_no != null && filters.mrn_no !== "") {
    values.push(String(filters.mrn_no).trim());
    conditions.push(`c.mrn_no::text = $${i++}`);
  }
  if (filters.heat_no != null && String(filters.heat_no).trim() !== "") {
    values.push(String(filters.heat_no).trim());
    conditions.push(`UPPER(trim(c.heat_no)) = UPPER(trim($${i++}))`);
  }
  if (filters.in_uid != null && filters.in_uid !== "") {
    values.push(Number(filters.in_uid));
    conditions.push(`c.in_uid = $${i++}`);
  }
  if (filters.location_id != null && filters.location_id !== "") {
    values.push(Number(filters.location_id));
    conditions.push(`c.location_id = $${i++}`);
  }
  if (filters.item_code != null && String(filters.item_code).trim() !== "") {
    values.push(String(filters.item_code).trim());
    conditions.push(`UPPER(trim(c.item_code)) = UPPER(trim($${i++}))`);
  }
  if (filters.item_dcode != null && filters.item_dcode !== "") {
    values.push(Number(filters.item_dcode));
    conditions.push(`c.item_dcode = $${i++}`);
  }

  if (journeyMode) {
    i = appendCoilJourneyCondition(conditions, values, filters.journey, i);
  } else {
    if (filters.from_date) {
      values.push(filters.from_date);
      conditions.push(`c.created_at >= $${i++}::timestamp`);
    }
    if (filters.to_date) {
      values.push(filters.to_date);
      conditions.push(`c.created_at <= $${i++}::timestamp`);
    }
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      c.coil_no_uid ILIKE $${idx} OR
      COALESCE(c.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(c.heat_no,'') ILIKE $${idx} OR
      COALESCE(c.item_code,'') ILIKE $${idx} OR
      COALESCE(c.item_desc,'') ILIKE $${idx} OR
      c.mrn_no::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} c ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const sort = [
    "coil_uid",
    "coil_no_uid",
    "created_at",
    "mrn_no",
    "heat_no",
    "item_code",
    "qty",
    "coil_index",
  ].includes(sortBy)
    ? sortBy
    : "coil_uid";
  const sortOrder = String(order).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(
    `SELECT c.*,
            lm.location_no,
            lm.rack_no,
            lm.row_no
     FROM ${TABLE} c
     LEFT JOIN ${T.MASTER_LOCATION} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     ${where}
     ORDER BY c.${sort} ${sortOrder}
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findCoilByUid = async (coil_no_uid) => {
  const [row] = await dbQuery(
    `SELECT c.*,
            lm.location_no,
            lm.rack_no,
            lm.row_no
     FROM ${TABLE} c
     LEFT JOIN ${T.MASTER_LOCATION} lm ON lm.location_id = c.location_id AND lm.is_deleted = false
     WHERE c.coil_no_uid = $1 AND c.is_deleted = false
     LIMIT 1`,
    [String(coil_no_uid || "").trim()]
  );
  return row ?? null;
};

export const findCoilsByUids = async (uids = []) => {
  const list = [...new Set((uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!list.length) return [];
  const placeholders = list.map((_, i) => `$${i + 1}`).join(", ");
  return dbQuery(
    `SELECT coil_no_uid, coil_uid, mrn_no, qty, heat_no, item_code, status
     FROM ${TABLE}
     WHERE is_deleted = false AND coil_no_uid IN (${placeholders})`,
    list
  );
};

export const countCoilsForMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE}
     WHERE mrn_uid = $1 AND is_deleted = false`,
    [uid]
  );
  return Number(row?.count || 0);
};

export const insertBulkCoils = async (rows = []) => {
  const created = [];
  for (const r of rows) {
    const [row] = await dbQuery(
      `INSERT INTO ${TABLE}
       (coil_no_uid, mrn_uid, mrn_no, serial_no, heat_no, item_dcode, item_code, item_desc,
        acc_code, acc_name, qty, coil_index, total_coils, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        r.coil_no_uid, r.mrn_uid ?? r.uid ?? null, r.mrn_no, r.serial_no ?? null, r.heat_no,
        r.item_dcode, r.item_code, r.item_desc, r.acc_code, r.acc_name,
        r.qty, r.coil_index, r.total_coils,
        r.remarks ?? null, r.created_by,
      ]
    );
    created.push(row);
  }
  return created;
};

export const updateCoilsAfterInward = async (in_uid, location_id, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = $1,
         in_uid = $2,
         updated_by = $3,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($4::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
       AND (
         location_id IS NULL
         OR in_uid = $2
       )`,
    [location_id, in_uid, userName ?? null, coil_no_uids]
  );
};

/** Return coils to Coil Area when a Store-In is deleted. */
export const clearCoilsForInward = async (in_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE in_uid = $1
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'`,
    [Number(in_uid), userName ?? null]
  );
};

/** Clear QC check link on coil(s) so they return to Pending / Unapproved queue. */
export const clearCoilQcLink = async (coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET qc_check_uid = NULL,
         qc_check_status = NULL,
         updated_by = $1,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($2::text[])
       AND is_deleted = false`,
    [userName ?? null, uids]
  );
};

/** Link coil(s) to a QC Check header and set qc_check_status. */
export const linkCoilsToQcCheck = async (qc_check_uid, coil_no_uids = [], qc_check_status, userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET qc_check_uid = $1,
         qc_check_status = $2,
         updated_by = $3,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($4::text[])
       AND is_deleted = false`,
    [qc_check_uid, qc_check_status ?? null, userName ?? null, coil_no_uids]
  );
};

/** Mark coils QC-rejected (leave store / coil area). */
export const updateCoilsAfterQcReject = async (qc_reject_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         qc_reject_uid = $1,
         out_uid = NULL,
         status = 'rejected',
         qc_check_status = COALESCE(qc_check_status, 'failed'),
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'`,
    [qc_reject_uid, userName ?? null, coil_no_uids]
  );
};

/** Restore QC-rejected coils to Coil Area — clear QC link so they reappear as virtual pending. */
export const clearCoilsForQcReject = async (qc_reject_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET qc_reject_uid = NULL,
         qc_check_uid = NULL,
         qc_check_status = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE qc_reject_uid = $1 AND is_deleted = false AND status = 'rejected'`,
    [Number(qc_reject_uid), userName ?? null]
  );
};

/**
 * In-process consumption — coils fully used at the machine leave stock.
 * Only active coils move, so a repeated approve cannot double-consume.
 */
export const markCoilsConsumed = async (ipr_uid, coil_no_uids = [], userName) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         ipr_uid = $1,
         status = 'consumed',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
     RETURNING coil_no_uid, qty, mrn_no`,
    [Number(ipr_uid), userName ?? null, uids]
  );
  return rows ?? [];
};

/** Undo a consume request — its coils return to the Coil Area as active. */
export const revertCoilsConsumed = async (ipr_uid, userName) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return [];
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET ipr_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE ipr_uid = $1 AND is_deleted = false AND status = 'consumed'
     RETURNING coil_no_uid, qty, mrn_no`,
    [id, userName ?? null]
  );
  return rows ?? [];
};

/** Store Out — remove coils from location. */
export const updateCoilsAfterStoreOut = async (out_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         out_uid = $1,
         status = 'out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND location_id IS NOT NULL
       AND COALESCE(status, 'active') = 'active'`,
    [out_uid, userName ?? null, coil_no_uids]
  );
};

/**
 * RM Rejection Store Out — link rejection + out in one step.
 * Allows coils still in Coil Area (no location) or In Store.
 */
export const updateCoilsAfterRejectionStoreOut = async (out_uid, qc_reject_uid, coil_no_uids = [], userName) => {
  if (!coil_no_uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET location_id = NULL,
         in_uid = NULL,
         out_uid = $1,
         qc_reject_uid = $2,
         status = 'out',
         qc_check_status = COALESCE(qc_check_status, 'failed'),
         updated_by = $3,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($4::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'`,
    [out_uid, qc_reject_uid, userName ?? null, coil_no_uids]
  );
};

/** Restore Store-Out coils to Coil Area. */
export const clearCoilsForStoreOut = async (out_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = NULL,
         status = 'active',
         updated_by = $2,
         updated_at = NOW()
     WHERE out_uid = $1 AND is_deleted = false AND status = 'out'`,
    [Number(out_uid), userName ?? null]
  );
};

/**
 * Undo RM Rejection Store Out — keep rejection link, restore coil as rejected.
 */
export const clearCoilsForRejectionStoreOut = async (out_uid, userName) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET out_uid = NULL,
         status = 'rejected',
         updated_by = $2,
         updated_at = NOW()
     WHERE out_uid = $1 AND is_deleted = false AND status = 'out'`,
    [Number(out_uid), userName ?? null]
  );
};

export const incrementCoilDownloadCount = async (coil_no_uids = []) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET download_count = COALESCE(download_count, 0) + 1,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[]) AND is_deleted = false`,
    [uids]
  );
};

/** Coils already Store-In'd for this MRN (cannot cancel stickers). */
export const countStoreInCoilsForMrn = async (mrn_uid) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS cnt
     FROM ${TABLE}
     WHERE mrn_uid = $1 AND is_deleted = false AND location_id IS NOT NULL`,
    [uid]
  );
  return Number(row?.cnt || 0);
};

/** Soft-delete all coil stickers for an MRN (Cancel stickers). */
export const softDeleteCoilsByMrn = async (mrn_uid, deleted_by = null) => {
  const uid = String(mrn_uid || "").trim();
  if (!uid) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
     WHERE mrn_uid = $1 AND is_deleted = false
     RETURNING coil_uid`,
    [uid, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Soft-delete specific coils by coil_no_uid (partial generate rollback). */
export const softDeleteCoilsByCoilNoUids = async (coil_no_uids = [], deleted_by = null) => {
  const uids = (coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!uids.length) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
     WHERE coil_no_uid = ANY($1::text[]) AND is_deleted = false
     RETURNING coil_uid`,
    [uids, deleted_by]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Format SA coil UID: SA_{adjId}_{total}_{index} e.g. SA_12_05_01 */
export function formatStockAdjustmentCoilUid(adjustmentId, total, index) {
  const adj = String(Math.max(1, Number(adjustmentId) || 1));
  const tb = String(Math.max(1, Number(total) || 1)).padStart(2, "0");
  const bi = String(Math.max(1, Number(index) || 1)).padStart(2, "0");
  return `SA_${adj}_${tb}_${bi}`;
}

/** Insert coils created by Stock Adjustment Add (approve). */
export const insertStockAdjustmentAddCoils = async ({
  adjustmentId,
  coilCount,
  perCoilQty,
  item_dcode,
  item_code,
  item_desc,
  heat_no,
  acc_code,
  acc_name,
  mrn_uid,
  mrn_no,
  remarks,
  userName,
}) => {
  const n = Math.max(0, Number(coilCount) || 0);
  const qty = Number(perCoilQty);
  if (n < 1 || !Number.isFinite(qty) || qty <= 0) return [];

  const mrnUid = mrn_uid != null ? String(mrn_uid).trim() || null : null;
  const mrnNoRaw = mrn_no != null && String(mrn_no).trim() !== "" ? Number(mrn_no) : null;
  const mrnNo = Number.isFinite(mrnNoRaw) ? mrnNoRaw : null;

  const created = [];
  for (let i = 1; i <= n; i++) {
    const coil_no_uid = formatStockAdjustmentCoilUid(adjustmentId, n, i);
    const [row] = await dbQuery(
      `INSERT INTO ${TABLE}
       (coil_no_uid, mrn_uid, mrn_no, heat_no, item_dcode, item_code, item_desc,
        acc_code, acc_name, qty, coil_index, total_coils, remarks,
        sa_id, sa_entry_type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'stock_in','active',$15)
       RETURNING *`,
      [
        coil_no_uid,
        mrnUid,
        mrnNo,
        heat_no ?? null,
        item_dcode ?? null,
        item_code ?? null,
        item_desc ?? null,
        acc_code ?? null,
        acc_name ?? null,
        qty,
        i,
        n,
        remarks ?? null,
        Number(adjustmentId),
        userName ?? null,
      ]
    );
    created.push(row);
  }
  return created;
};

/** Soft-delete coils created by an Add adjustment. */
export const softDeleteStockAdjustmentAddCoils = async (adjustmentId, userName) => {
  const adjId = Number(adjustmentId);
  if (!Number.isFinite(adjId) || adjId <= 0) return 0;
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true,
         deleted_by = $2,
         deleted_at = NOW(),
         updated_by = $2,
         updated_at = NOW()
     WHERE sa_id = $1
       AND sa_entry_type = 'stock_in'
       AND is_deleted = false
     RETURNING coil_uid`,
    [adjId, userName ?? null]
  );
  return Array.isArray(rows) ? rows.length : 0;
};

/** Mark active coils as SA minus (out of stock). Keeps location for revert. */
export const markCoilsStockAdjustmentOut = async (adjustmentId, coil_no_uids = [], userName) => {
  const uids = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uids.length) return [];
  return dbQuery(
    `UPDATE ${TABLE}
     SET status = 'out',
         sa_id = $1,
         sa_entry_type = 'stock_out',
         updated_by = $2,
         updated_at = NOW()
     WHERE coil_no_uid = ANY($3::text[])
       AND is_deleted = false
       AND COALESCE(status, 'active') = 'active'
     RETURNING *`,
    [Number(adjustmentId), userName ?? null, uids]
  );
};

/** Undo SA minus — restore coils to active. */
export const clearStockAdjustmentMinusMarks = async (adjustmentId, coil_no_uids = [], userName) => {
  const adjId = Number(adjustmentId);
  const uids = [...new Set((coil_no_uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  const conditions = ["is_deleted = false", "sa_entry_type = 'stock_out'"];
  const values = [userName ?? null];
  let i = 2;

  if (Number.isFinite(adjId) && adjId > 0) {
    values.push(adjId);
    conditions.push(`sa_id = $${i++}`);
  }
  if (uids.length) {
    values.push(uids);
    conditions.push(`coil_no_uid = ANY($${i++}::text[])`);
  } else if (!(Number.isFinite(adjId) && adjId > 0)) {
    return [];
  }

  return dbQuery(
    `UPDATE ${TABLE}
     SET status = 'active',
         sa_id = NULL,
         sa_entry_type = NULL,
         updated_by = $1,
         updated_at = NOW()
     WHERE ${conditions.join(" AND ")}
     RETURNING *`,
    values
  );
};

export const findCoilsBySaId = async (adjustmentId, sa_entry_type = null) => {
  const adjId = Number(adjustmentId);
  if (!Number.isFinite(adjId) || adjId <= 0) return [];
  const values = [adjId];
  let sql = `SELECT * FROM ${TABLE}
             WHERE sa_id = $1 AND is_deleted = false`;
  if (sa_entry_type) {
    values.push(String(sa_entry_type));
    sql += ` AND sa_entry_type = $2`;
  }
  sql += ` ORDER BY coil_index ASC NULLS LAST, coil_no_uid ASC`;
  return dbQuery(sql, values);
};

