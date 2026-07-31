import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.REJECTION;
const OUT_TABLE = T.OUT_ENTRY;
const COIL_TABLE = T.COIL_TABLE;
const SCANNED_COIL_TABLE = T.OUT_ENTRY_SCANNED_COIL;

export async function attachRejectionCoils(rows = []) {
  if (!rows.length) return rows;

  const rejectIds = [...new Set(rows.map((r) => Number(r.qc_reject_uid)).filter((id) => id > 0))];
  const outIds = [...new Set(rows.map((r) => Number(r.out_uid)).filter((id) => id > 0))];

  const coilByReject = new Map();
  if (rejectIds.length) {
    const coilRows = await dbQuery(
      `SELECT qc_reject_uid, coil_no_uid, qty, heat_no, item_code, ipr_uid, qc_check_uid
       FROM ${COIL_TABLE}
       WHERE is_deleted = false AND qc_reject_uid = ANY($1::int[])
       ORDER BY coil_no_uid ASC`,
      [rejectIds]
    );
    for (const c of coilRows || []) {
      const id = Number(c.qc_reject_uid);
      if (!coilByReject.has(id)) coilByReject.set(id, []);
      coilByReject.get(id).push({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        heat_no: c.heat_no,
        item_code: c.item_code,
        ipr_uid: c.ipr_uid ?? null,
        qc_check_uid: c.qc_check_uid ?? null,
      });
    }
  }

  const uidsByOut = new Map();
  if (outIds.length) {
    const scannedRows = await dbQuery(
      `SELECT out_uid, coil_no_uid
       FROM ${SCANNED_COIL_TABLE}
       WHERE out_uid = ANY($1::int[])
       ORDER BY coil_no_uid ASC`,
      [outIds]
    );
    for (const s of scannedRows || []) {
      const id = Number(s.out_uid);
      if (!uidsByOut.has(id)) uidsByOut.set(id, []);
      uidsByOut.get(id).push(String(s.coil_no_uid || "").trim());
    }
  }

  return rows.map((row) => {
    const rejectId = Number(row.qc_reject_uid);
    const outId = Number(row.out_uid);
    let coils = coilByReject.get(rejectId) || [];
    if (!coils.length) {
      const scanned = (uidsByOut.get(outId) || []).filter(Boolean);
      coils = scanned.map((uid) => ({ coil_no_uid: uid }));
    }
    const uids = coils.map((c) => String(c?.coil_no_uid || "").trim()).filter(Boolean);
    const coilIpr = coils.find((c) => c.ipr_uid != null)?.ipr_uid ?? null;
    const coilQc = coils.find((c) => c.qc_check_uid != null)?.qc_check_uid ?? null;
    const ipr_uid = row.ipr_uid ?? coilIpr ?? null;
    const qc_check_uid = row.qc_check_uid ?? coilQc ?? null;
    let rejection_origin = null;
    const sourceSep = " · ";
    let rejection_origin_label = null;
    if (ipr_uid != null) {
      rejection_origin = "in_process";
      rejection_origin_label = `In-Process${sourceSep}IPR-${ipr_uid}`;
    } else if (qc_check_uid != null) {
      rejection_origin = "qc_check";
      rejection_origin_label = `QC Fail${sourceSep}QC-${qc_check_uid}`;
    } else if (Number.isFinite(rejectId) && rejectId > 0) {
      rejection_origin = "register";
      rejection_origin_label = `Register${sourceSep}REJECT-${rejectId}`;
    } else {
      rejection_origin_label = "Manual";
    }
    return {
      ...row,
      ipr_uid,
      qc_check_uid,
      rejection_origin,
      rejection_origin_label,
      coils,
      coil_no_uid: uids.length === 1 ? uids[0] : uids.length > 1 ? uids.join(", ") : null,
      coil_count: Math.max(Number(row.coil_count) || 0, uids.length),
    };
  });
}

export const findQcRejections = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["q.is_deleted = false"];

  if (filters.register_complete === true || filters.register_complete === "true") {
    conditions.push(`COALESCE(TRIM(q.bill_no), '') <> ''`);
  }
  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`q.approved = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`q.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`q.created_at <= $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(q.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(q.heat_nos,'') ILIKE $${idx} OR
      COALESCE(q.item_codes,'') ILIKE $${idx} OR
      COALESCE(q.reason,'') ILIKE $${idx} OR
      COALESCE(q.remarks,'') ILIKE $${idx}
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
            q.approved_by AS approved_by_name,
            COALESCE(o.approved, false) AS store_out_approved,
            o.scan_complete,
            EXISTS (
              SELECT 1 FROM ${OUT_TABLE} ox
              WHERE ox.is_deleted = false
                AND (
                  (q.out_uid IS NOT NULL AND ox.out_uid = q.out_uid)
                  OR (ox.qc_reject_uid IS NOT NULL AND ox.qc_reject_uid = q.qc_reject_uid)
                )
            ) AS store_out_started
     FROM ${TABLE} q
     LEFT JOIN ${OUT_TABLE} o ON o.out_uid = q.out_uid AND o.is_deleted = false
     ${where}
     ORDER BY q.qc_reject_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const data = await attachRejectionCoils(rows || []);

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const findQcRejection = async (qc_reject_uid) => {
  const id = Number(qc_reject_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT q.*,
            q.created_by AS created_by_name,
            q.approved_by AS approved_by_name,
            COALESCE(o.approved, false) AS store_out_approved,
            o.scan_complete,
            EXISTS (
              SELECT 1 FROM ${OUT_TABLE} ox
              WHERE ox.is_deleted = false
                AND (
                  (q.out_uid IS NOT NULL AND ox.out_uid = q.out_uid)
                  OR (ox.qc_reject_uid IS NOT NULL AND ox.qc_reject_uid = q.qc_reject_uid)
                )
            ) AS store_out_started
     FROM ${TABLE} q
     LEFT JOIN ${OUT_TABLE} o ON o.out_uid = q.out_uid AND o.is_deleted = false
     WHERE q.qc_reject_uid = $1 AND q.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row ?? null;
};

export const insertQcRejection = async (data) => {
  const {
    ipr_uid,
    mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count, reason, remarks, created_by,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (ipr_uid, mrn_refs, heat_nos, item_codes, qtys, total_qty, coil_count, reason, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      ipr_uid ?? null,
      mrn_refs ?? null, heat_nos ?? null, item_codes ?? null, qtys ?? null,
      total_qty ?? 0, coil_count ?? 0, reason ?? null, remarks ?? null, created_by,
    ]
  );
  return row;
};

export const updateQcRejection = async (qc_reject_uid, fields = {}) => {
  const allowed = [
    "remarks",
    "reason",
    "out_uid",
    "bill_no",
    "approved",
    "approved_by",
    "approved_at",
    "updated_by",
    "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findQcRejection(qc_reject_uid);
  const values = Object.values(safe);
  values.push(Number(qc_reject_uid));
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE qc_reject_uid = $${keys.length + 1} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

export const softDeleteQcRejection = async (qc_reject_uid, deleted_by) => {
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE qc_reject_uid = $1 AND is_deleted = false`,
    [Number(qc_reject_uid), deleted_by ?? null]
  );
};

/**
 * All incomplete rejection register rows (no bill_no yet) — single source for RM Rejection Pending.
 * Stage: awaiting_authorization | awaiting_store_out | awaiting_bill
 */
function classifyIncompleteRejection(row) {
  const approved = row.approved === true || row.approved === "t";
  const storeOutApproved =
    row.out_uid != null &&
    (row.store_out_approved === true || row.store_out_approved === "t");
  if (storeOutApproved) return "awaiting_bill";
  if (approved) return "awaiting_store_out";
  return "awaiting_authorization";
}

function mapIncompleteRejectionRow(row) {
  const pending_source = classifyIncompleteRejection(row);
  return {
    qc_reject_uid: row.qc_reject_uid,
    out_uid: row.out_uid ?? null,
    ipr_uid: row.ipr_uid ?? null,
    pending_source,
    pending_type: pending_source,
    is_virtual_pending: false,
    scan_complete: row.scan_complete,
    store_out_approved: row.store_out_approved,
    mrn_no: row.mrn_refs,
    mrn_refs: row.mrn_refs,
    heat_no: row.heat_nos,
    heat_nos: row.heat_nos,
    item_code: row.item_codes,
    item_codes: row.item_codes,
    qty: row.total_qty,
    total_qty: row.total_qty,
    coil_count: row.coil_count,
    reason: row.reason,
    failure_reason: row.reason,
    remarks: row.remarks,
    approved: row.approved,
    approved_by: row.approved_by,
    approved_by_name: row.approved_by_name,
    approved_at: row.approved_at,
    inspected_by:
      pending_source === "awaiting_authorization" ? row.created_by : row.approved_by || row.created_by,
    inspected_by_name:
      pending_source === "awaiting_authorization"
        ? row.created_by_name
        : row.approved_by_name || row.created_by_name,
    inspected_at:
      pending_source === "awaiting_bill"
        ? row.store_out_approved_at || row.approved_at
        : pending_source === "awaiting_store_out"
          ? row.out_created_at || row.approved_at
          : row.created_at,
    created_at: row.created_at,
    created_by_name: row.created_by_name,
  };
}

export const findIncompleteRejectionRegisters = async (options = {}) => {
  const { search, page = 1, limit = 5000 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "q.is_deleted = false",
    `COALESCE(TRIM(q.bill_no), '') = ''`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(q.mrn_refs,'') ILIKE $${idx} OR
      COALESCE(q.heat_nos,'') ILIKE $${idx} OR
      COALESCE(q.item_codes,'') ILIKE $${idx} OR
      COALESCE(q.reason,'') ILIKE $${idx} OR
      COALESCE(q.remarks,'') ILIKE $${idx} OR
      q.qc_reject_uid::text ILIKE $${idx} OR
      COALESCE(q.out_uid::text,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${COIL_TABLE} c
        WHERE c.is_deleted = false AND c.qc_reject_uid = q.qc_reject_uid
          AND COALESCE(c.coil_no_uid,'') ILIKE $${idx}
      ) OR
      EXISTS (
        SELECT 1 FROM ${SCANNED_COIL_TABLE} s
        WHERE s.out_uid = q.out_uid AND COALESCE(s.coil_no_uid,'') ILIKE $${idx}
      )
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const fromClause = `
    FROM ${TABLE} q
    LEFT JOIN ${OUT_TABLE} o ON o.out_uid = q.out_uid AND o.is_deleted = false`;

  const countRes = await dbQuery(`SELECT COUNT(*)::int AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 5000));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT q.*,
            q.created_by AS created_by_name,
            q.approved_by AS approved_by_name,
            COALESCE(o.approved, false) AS store_out_approved,
            o.scan_complete,
            o.created_at AS out_created_at,
            o.approved_at AS store_out_approved_at
     ${fromClause}
     ${where}
     ORDER BY COALESCE(o.approved_at, o.created_at, q.approved_at, q.created_at) DESC NULLS LAST,
              q.qc_reject_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const data = await attachRejectionCoils((rows || []).map(mapIncompleteRejectionRow));

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 1 };
};
