import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.IN_PROCESS_REQUEST;

export const IPR_REQUEST_TYPE = {
  REJECTION: "rejection",
  STORE_IN: "store_in",
  CONSUME: "consume",
};

export const IPR_DOWNSTREAM = {
  NONE: null,
  PENDING_STORE_OUT: "pending_store_out",
  PENDING_STORE_IN: "pending_store_in",
  CONSUMED: "consumed",
  STORE_OUT_DONE: "store_out_done",
};

const SELECT_COLS = `r.*,
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name`;

const KNOWN_REQUEST_TYPES = new Set(Object.values(IPR_REQUEST_TYPE));

export function normalizeRequestType(value) {
  const type = String(value || "").trim();
  return KNOWN_REQUEST_TYPES.has(type) ? type : IPR_REQUEST_TYPE.REJECTION;
}

/** Consume needs no queue — approval takes the coils out of stock directly. */
export function resolveDownstream(requestType, approved) {
  if (!approved) return IPR_DOWNSTREAM.NONE;
  const type = normalizeRequestType(requestType);
  if (type === IPR_REQUEST_TYPE.STORE_IN) return IPR_DOWNSTREAM.PENDING_STORE_IN;
  if (type === IPR_REQUEST_TYPE.CONSUME) return IPR_DOWNSTREAM.CONSUMED;
  return IPR_DOWNSTREAM.PENDING_STORE_OUT;
}

function jsonArray(raw) {
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

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v == null || v === "" ? null : String(v));

function uniqueJoin(values, sep = " | ") {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    if (raw == null || raw === "") continue;
    const s = String(raw).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out.join(sep) : null;
}

export function normalizeCoils(coils) {
  return jsonArray(coils)
    .filter((c) => c?.coil_no_uid)
    .map((c) => {
      const qty = num(c.qty);
      const original = c.original_qty != null ? num(c.original_qty) : qty;
      const remaining = c.remaining_qty != null ? num(c.remaining_qty) : original;
      return {
        coil_no_uid: String(c.coil_no_uid),
        qty,
        original_qty: original,
        remaining_qty: remaining,
        consumed_qty: c.consumed_qty != null ? num(c.consumed_qty) : Math.max(0, original - remaining),
        item_code: str(c.item_code),
        item_desc: str(c.item_desc),
        heat_no: str(c.heat_no),
        mrn_uid: str(c.mrn_uid),
        mrn_no: c.mrn_no ?? null,
        location_id: c.location_id ?? null,
        location_no: str(c.location_no),
        status: str(c.status),
        source: str(c.source),
        is_seed_scan: Boolean(c.is_seed_scan),
      };
    });
}

export function normalizeProposedCoils(coils) {
  return jsonArray(coils)
    .filter((c) => c && (c.coil_no_uid || c.temp_id) && num(c.qty) > 0)
    .map((c, i) => ({
      temp_id: str(c.temp_id) || `proposed-${i + 1}`,
      coil_no_uid: str(c.coil_no_uid),
      qty: num(c.qty),
      item_code: str(c.item_code),
      item_desc: str(c.item_desc),
      heat_no: str(c.heat_no),
      mrn_uid: str(c.mrn_uid),
      mrn_no: c.mrn_no ?? null,
      from_coil_uid: str(c.from_coil_uid) || str(c.coil_no_uid),
    }));
}

/** Attach the derived qty/count fields the list + modal render from. */
export function summarizeRow(row) {
  if (!row) return null;
  const request_type = normalizeRequestType(row.request_type);
  const coils = normalizeCoils(row.coils);
  const previousRaw = jsonArray(row.previous_coils);
  const previous_coils = normalizeCoils(previousRaw.length ? previousRaw : coils);
  const proposed_coils = normalizeProposedCoils(row.proposed_coils);

  const scannedRaw = jsonArray(row.scanned_coil_uids);
  const scanned_coil_uids = scannedRaw.length ? scannedRaw : coils.map((c) => c.coil_no_uid);

  const previous_qty = previous_coils.reduce((s, c) => s + num(c.original_qty ?? c.qty), 0);
  const isStoreIn = request_type === IPR_REQUEST_TYPE.STORE_IN;
  const isConsume = request_type === IPR_REQUEST_TYPE.CONSUME;
  const isRejection = request_type === IPR_REQUEST_TYPE.REJECTION;
  const rejection_type = row.rejection_type === "lot" ? "lot" : "coil";
  const isLotRejection = isRejection && rejection_type === "lot";
  const total_qty = isStoreIn
    ? proposed_coils.length
      ? proposed_coils.reduce((s, c) => s + num(c.qty), 0)
      : coils.reduce((s, c) => s + num(c.remaining_qty ?? c.qty), 0)
    : coils.reduce((s, c) => s + num(c.qty), 0);

  const mrnNos = coils.map((c) => c.mrn_no).filter((n) => n != null && n !== "");
  const heatNos = coils.map((c) => c.heat_no).filter(Boolean);
  const itemCodes = coils.map((c) => c.item_code).filter(Boolean);

  const resolved_item_code =
    row.item_code || itemCodes[0] || proposed_coils[0]?.item_code || null;
  const resolved_item_desc =
    row.item_desc || coils[0]?.item_desc || proposed_coils[0]?.item_desc || null;
  const resolved_mrn_no = row.mrn_no ?? mrnNos[0] ?? null;
  const resolved_heat_no = row.heat_no || heatNos[0] || null;
  const lot_label = isLotRejection && row.lot_no ? String(row.lot_no).trim() : null;

  let mrn_label = null;
  if (lot_label) {
    mrn_label = lot_label;
  } else if (resolved_mrn_no != null) {
    mrn_label = String(resolved_mrn_no);
  } else {
    mrn_label = uniqueJoin(mrnNos) || str(row.mrn_uid);
  }

  const heat_label = resolved_heat_no || uniqueJoin(heatNos);

  const firstCoilUid = coils[0]?.coil_no_uid || str(row.seed_coil_uid);

  return {
    ...row,
    request_type,
    rejection_type,
    coils,
    previous_coils,
    proposed_coils,
    scanned_coil_uids,
    coil_count: isStoreIn && proposed_coils.length ? proposed_coils.length : coils.length,
    previous_coil_count: previous_coils.length,
    total_qty,
    previous_qty,
    // Consume is whole-coil, so everything scanned counts as used.
    consumed_qty: isStoreIn
      ? Math.max(0, previous_qty - total_qty)
      : isConsume
        ? total_qty
        : 0,
    item_code: resolved_item_code,
    item_desc: resolved_item_desc,
    mrn_no: resolved_mrn_no,
    heat_no: resolved_heat_no,
    mrn_label,
    heat_label,
    lot_label,
    coil_label:
      coils.length === 1
        ? firstCoilUid
        : coils.length > 1
          ? `${coils.length} coils`
          : null,
  };
}

export const findInProcessRequests = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false"];

  if (filters.request_type && filters.request_type !== "all") {
    values.push(normalizeRequestType(filters.request_type));
    conditions.push(`r.request_type = $${i++}`);
  }
  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`r.approved = $${i++}`);
  }
  if (filters.downstream) {
    values.push(String(filters.downstream));
    conditions.push(`r.downstream = $${i++}`);
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
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      COALESCE(r.item_code,'') ILIKE $${idx} OR
      COALESCE(r.item_desc,'') ILIKE $${idx} OR
      COALESCE(r.reason,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.lot_no,'') ILIKE $${idx} OR
      COALESCE(r.heat_no,'') ILIKE $${idx} OR
      COALESCE(r.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(r.mrn_no::text,'') ILIKE $${idx} OR
      COALESCE(r.seed_coil_uid,'') ILIKE $${idx} OR
      COALESCE(r.created_by,'') ILIKE $${idx} OR
      COALESCE(r.coils::text,'') ILIKE $${idx} OR
      COALESCE(r.proposed_coils::text,'') ILIKE $${idx} OR
      r.ipr_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT ${SELECT_COLS}
     FROM ${TABLE} r
     ${where}
     ORDER BY r.ipr_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows.map(summarizeRow),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
};

export const findInProcessRequest = async (ipr_uid) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ${SELECT_COLS}
     FROM ${TABLE} r
     WHERE r.ipr_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row ? summarizeRow(row) : null;
};

/** Distinct reasons used before, newest first — powers the reason suggest field. */
export const findInProcessReasons = async ({ search, request_type } = {}) => {
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false", "COALESCE(TRIM(r.reason), '') <> ''"];

  if (request_type && request_type !== "all") {
    values.push(normalizeRequestType(request_type));
    conditions.push(`r.request_type = $${i++}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`r.reason ILIKE $${i++}`);
  }

  return dbQuery(
    `SELECT TRIM(r.reason) AS reason,
            MAX(COALESCE(r.updated_at, r.created_at)) AS last_used_at
     FROM ${TABLE} r
     WHERE ${conditions.join(" AND ")}
     GROUP BY TRIM(r.reason)
     ORDER BY last_used_at DESC NULLS LAST
     LIMIT 100`,
    values
  );
};

const WRITABLE = [
  "request_type", "rejection_type", "reason", "remarks",
  "lot_no", "mrn_uid", "mrn_no", "heat_no", "item_code", "item_desc",
  "seed_coil_uid", "coils", "previous_coils", "proposed_coils", "scanned_coil_uids",
  "downstream", "approved", "approved_by", "approved_at",
  "created_by", "updated_by", "updated_at",
];
const JSON_COLS = new Set(["coils", "previous_coils", "proposed_coils", "scanned_coil_uids"]);

export const insertInProcessRequest = async (data = {}) => {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const key of WRITABLE) {
    if (data[key] === undefined) continue;
    cols.push(key);
    placeholders.push(JSON_COLS.has(key) ? `$${i++}::jsonb` : `$${i++}`);
    values.push(JSON_COLS.has(key) ? JSON.stringify(data[key] || []) : data[key]);
  }

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (${cols.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    values
  );
  return row;
};

export const updateInProcessRequest = async (ipr_uid, fields = {}) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return null;

  const sets = [];
  const values = [];
  let i = 1;
  for (const key of WRITABLE) {
    if (fields[key] === undefined) continue;
    sets.push(JSON_COLS.has(key) ? `${key} = $${i++}::jsonb` : `${key} = $${i++}`);
    values.push(JSON_COLS.has(key) ? JSON.stringify(fields[key] || []) : fields[key]);
  }
  if (!sets.length) return findInProcessRequest(id);

  values.push(id);
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${sets.join(", ")}
     WHERE ipr_uid = $${i} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

/**
 * Approved in-process rejections waiting in RM Rejection Pending (before Store Out).
 */
export const findInProcessRejectionsPendingRejection = async (options = {}) => {
  const { search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "r.is_deleted = false",
    "r.approved = true",
    `r.request_type = '${IPR_REQUEST_TYPE.REJECTION}'`,
    `r.downstream = '${IPR_DOWNSTREAM.PENDING_STORE_OUT}'`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(r.reason,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.lot_no,'') ILIKE $${idx} OR
      COALESCE(r.heat_no,'') ILIKE $${idx} OR
      COALESCE(r.item_code,'') ILIKE $${idx} OR
      COALESCE(r.item_desc,'') ILIKE $${idx} OR
      COALESCE(r.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(r.seed_coil_uid,'') ILIKE $${idx} OR
      COALESCE(r.coils::text,'') ILIKE $${idx} OR
      r.ipr_uid::text ILIKE $${idx} OR
      r.mrn_no::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT r.*
     FROM ${TABLE} r
     ${where}
     ORDER BY r.ipr_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const data = (rows || []).map((raw) => {
    const row = summarizeRow(raw);
    const coils = row?.coils || [];
    const mrnSet = new Set();
    const heatSet = new Set();
    const itemSet = new Set();
    for (const c of coils) {
      if (c.mrn_no != null) mrnSet.add(String(c.mrn_no));
      if (c.heat_no) heatSet.add(c.heat_no);
      if (c.item_code) itemSet.add(c.item_code);
    }
    const first = coils[0] || {};
    return {
      ipr_uid: row.ipr_uid,
      pending_source: "in_process",
      pending_type: row.rejection_type === "lot" ? "lot" : "coil",
      is_virtual_pending: true,
      qc_reject_uid: null,
      qc_check_uid: null,
      coil_no_uid: coils.length === 1 ? first.coil_no_uid : null,
      mrn_no: row.mrn_no ?? first.mrn_no ?? null,
      mrn_refs: [...mrnSet].join(" | ") || (row.lot_no != null ? String(row.lot_no) : null),
      heat_nos: [...heatSet].join(" | ") || row.heat_no || first.heat_no || null,
      item_code: row.item_code || first.item_code || null,
      item_codes: [...itemSet].join(" | ") || row.item_code || first.item_code || null,
      qty: row.total_qty ?? 0,
      total_qty: row.total_qty ?? 0,
      coil_count: row.coil_count ?? coils.length,
      reason: row.reason || null,
      failure_reason: row.reason || null,
      remarks: row.remarks || null,
      rejection_type: row.rejection_type || "coil",
      inspected_by: row.approved_by || row.created_by || null,
      inspected_by_name: row.approved_by || row.created_by || null,
      inspected_at: row.approved_at || row.created_at || null,
      approved: false,
      coils,
    };
  });

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const softDeleteInProcessRequest = async (ipr_uid, deleted_by = null) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE ipr_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};
