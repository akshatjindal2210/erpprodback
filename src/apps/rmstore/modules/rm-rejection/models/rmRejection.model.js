import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.REJECTION;
const OUT_TABLE = T.OUT_ENTRY;
const COIL_TABLE = T.COIL_TABLE;
const SCANNED_COIL_TABLE = T.OUT_ENTRY_SCANNED_COIL;

/** True when an authorized RM Rejection Store Out exists for this register row. */
export const rejectionStoreOutApprovedSql = (qAlias = "q") => `EXISTS (
  SELECT 1 FROM ${OUT_TABLE} ox
  WHERE ox.is_deleted = false
    AND COALESCE(ox.approved, false) = true
    AND LOWER(COALESCE(ox.entry_type, 'store_out')) = 'rm_rejection'
    AND (
      ox.qc_reject_uid = ${qAlias}.qc_reject_uid
      OR (${qAlias}.out_uid IS NOT NULL AND ox.out_uid = ${qAlias}.out_uid)
    )
)`;

export async function hasApprovedRejectionStoreOut(qc_reject_uid) {
  const id = Number(qc_reject_uid);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [row] = await dbQuery(
    `SELECT 1 AS ok
     FROM ${OUT_TABLE} ox
     WHERE ox.is_deleted = false
       AND ox.qc_reject_uid = $1
       AND COALESCE(ox.approved, false) = true
       AND LOWER(COALESCE(ox.entry_type, 'store_out')) = 'rm_rejection'
     LIMIT 1`,
    [id]
  );
  return Boolean(row);
}

export async function attachRejectionCoils(rows = []) {
  if (!rows.length) return rows;

  const rejectIds = [...new Set(rows.map((r) => Number(r.qc_reject_uid)).filter((id) => id > 0))];
  const outIds = [...new Set(rows.map((r) => Number(r.out_uid)).filter((id) => id > 0))];

  const coilByReject = new Map();
  if (rejectIds.length) {
    const coilRows = await dbQuery(
      `SELECT c.rm_uid, c.coil_no_uid, c.qty, c.mrn_uid, m.heat_no AS heat_no, m.item_code AS item_code, m.item_desc AS item_desc, c.ipr_uid, c.qc_uid
       FROM ${COIL_TABLE} c
       LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
       WHERE c.is_deleted = false AND c.rm_uid = ANY($1::int[])
       ORDER BY c.coil_no_uid ASC`,
      [rejectIds]
    );
    for (const c of coilRows || []) {
      const id = Number(c.rm_uid);
      if (!coilByReject.has(id)) coilByReject.set(id, []);
      coilByReject.get(id).push({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        mrn_uid: c.mrn_uid || null,
        heat_no: c.heat_no,
        item_code: c.item_code,
        item_desc: c.item_desc || null,
        ipr_uid: c.ipr_uid ?? null,
        qc_uid: c.qc_uid ?? null,
      });
    }
  }

  const coilsByOut = new Map();
  if (outIds.length) {
    const scannedRows = await dbQuery(
      `SELECT s.out_uid, s.coil_no_uid, c.mrn_uid
       FROM ${SCANNED_COIL_TABLE} s
       LEFT JOIN ${COIL_TABLE} c ON c.coil_no_uid = s.coil_no_uid AND c.is_deleted = false
       WHERE s.out_uid = ANY($1::int[])
       ORDER BY s.coil_no_uid ASC`,
      [outIds]
    );
    for (const s of scannedRows || []) {
      const id = Number(s.out_uid);
      if (!coilsByOut.has(id)) coilsByOut.set(id, []);
      coilsByOut.get(id).push({
        coil_no_uid: String(s.coil_no_uid || "").trim(),
        mrn_uid: s.mrn_uid || null,
      });
    }
  }

  return rows.map((row) => {
    const rejectId = Number(row.qc_reject_uid);
    const outId = Number(row.out_uid);
    let coils = coilByReject.get(rejectId) || [];
    if (!coils.length) {
      coils = (coilsByOut.get(outId) || []).filter((c) => c.coil_no_uid);
    }
    const uids = coils.map((c) => String(c?.coil_no_uid || "").trim()).filter(Boolean);
    const coilIpr = coils.find((c) => c.ipr_uid != null)?.ipr_uid ?? null;
    const coilQc = coils.find((c) => c.qc_uid != null)?.qc_uid ?? null;
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
    const coilMrnUids = [
      ...new Set(coils.map((c) => String(c?.mrn_uid || "").trim()).filter(Boolean)),
    ];
    const coilItemDescs = [
      ...new Set(coils.map((c) => String(c?.item_desc || "").trim()).filter(Boolean)),
    ];
    const mrn_uid = row.mrn_uid || row.mrn_uids || (coilMrnUids.length ? coilMrnUids.join(" | ") : null);
    const item_descs = row.item_descs || (coilItemDescs.length ? coilItemDescs.join(" | ") : null);
    return {
      ...row,
      ipr_uid,
      qc_check_uid,
      rejection_origin,
      rejection_origin_label,
      coils,
      mrn_uid,
      mrn_uids: row.mrn_uids || mrn_uid,
      item_descs,
      item_desc: row.item_desc || item_descs,
      coil_no_uid: uids.length === 1 ? uids[0] : uids.length > 1 ? uids.join(", ") : null,
      coil_count: Math.max(Number(row.coil_count) || 0, uids.length),
    };
  });
}

export const findQcRejections = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  let i = 1;
  const conditions = ["q.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`q.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

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
      COALESCE(q.item_descs,'') ILIKE $${idx} OR
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
            q.updated_by AS updated_by_name,
            ${rejectionStoreOutApprovedSql("q")} AS store_out_approved,
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
            q.updated_by AS updated_by_name,
            ${rejectionStoreOutApprovedSql("q")} AS store_out_approved,
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
    mrn_refs, mrn_uids, heat_nos, item_codes, item_descs, qtys, total_qty, coil_count, reason, remarks, created_by,
  } = data;
  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (ipr_uid, mrn_refs, mrn_uids, heat_nos, item_codes, item_descs, qtys, total_qty, coil_count, reason, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      ipr_uid ?? null,
      mrn_refs ?? null, mrn_uids ?? null, heat_nos ?? null, item_codes ?? null, item_descs ?? null, qtys ?? null,
      total_qty ?? 0, coil_count ?? 0, reason ?? null, remarks ?? null, created_by,
    ]
  );
  return row;
};

export const updateQcRejection = async (qc_reject_uid, fields = {}) => {
  const allowed = ["remarks", "reason", "out_uid", "bill_no", "mrn_refs", "mrn_uids", "qtys", "total_qty", "coil_count", "item_codes", "item_descs", "heat_nos", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findQcRejection(qc_reject_uid);
  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(safe);
  values.push(Number(qc_reject_uid));
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE qc_reject_uid = $${nextIndex} AND is_deleted = false
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
 * Incomplete rejection register rows (no bill_no yet) — single source for RM Rejection Pending.
 * Stage: awaiting_store_out | awaiting_bill
 * Register approval is skipped; Store Out scan/authorize is the gate.
 */
function classifyIncompleteRejection(row) {
  const storeOutApproved =
    row.out_uid != null &&
    (row.store_out_approved === true || row.store_out_approved === "t");
  if (storeOutApproved) return "awaiting_bill";
  return "awaiting_store_out";
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
    mrn_uid: row.mrn_uids || row.mrn_uid || null,
    mrn_uids: row.mrn_uids || row.mrn_uid || null,
    heat_no: row.heat_nos,
    heat_nos: row.heat_nos,
    item_code: row.item_codes,
    item_codes: row.item_codes,
    item_desc: row.item_descs || row.item_desc || null,
    item_descs: row.item_descs || row.item_desc || null,
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
    inspected_by: row.approved_by || row.created_by,
    inspected_by_name: row.approved_by_name || row.created_by_name,
    inspected_at:
      pending_source === "awaiting_bill"
        ? row.store_out_approved_at || row.approved_at || row.created_at
        : row.out_created_at || row.approved_at || row.created_at,
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
      COALESCE(q.item_descs,'') ILIKE $${idx} OR
      COALESCE(q.reason,'') ILIKE $${idx} OR
      COALESCE(q.remarks,'') ILIKE $${idx} OR
      q.qc_reject_uid::text ILIKE $${idx} OR
      COALESCE(q.out_uid::text,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${COIL_TABLE} c
        WHERE c.is_deleted = false AND c.rm_uid = q.qc_reject_uid
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
            ${rejectionStoreOutApprovedSql("q")} AS store_out_approved,
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
