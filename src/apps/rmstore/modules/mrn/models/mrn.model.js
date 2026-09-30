import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.MRN;

/** Portal sticker lifecycle: pending | draft | generate | approved | reject */
export const MRN_STICKER_STATUS = Object.freeze({
  PENDING: "pending",
  DRAFT: "draft",
  GENERATE: "generate",
  APPROVED: "approved",
  REJECT: "reject",
});

export function normalizeMrnStickerStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === MRN_STICKER_STATUS.DRAFT) return MRN_STICKER_STATUS.DRAFT;
  if (s === MRN_STICKER_STATUS.GENERATE || s === "generated") return MRN_STICKER_STATUS.GENERATE;
  if (s === MRN_STICKER_STATUS.APPROVED) return MRN_STICKER_STATUS.APPROVED;
  if (s === MRN_STICKER_STATUS.REJECT || s === "rejected") return MRN_STICKER_STATUS.REJECT;
  return MRN_STICKER_STATUS.PENDING;
}

export function isMrnStickerGeneratedStatus(status) {
  const s = normalizeMrnStickerStatus(status);
  return s === MRN_STICKER_STATUS.GENERATE || s === MRN_STICKER_STATUS.APPROVED;
}

export function isMrnStickerApprovedStatus(status) {
  return normalizeMrnStickerStatus(status) === MRN_STICKER_STATUS.APPROVED;
}

export function isMrnStickerRejectedStatus(status) {
  return normalizeMrnStickerStatus(status) === MRN_STICKER_STATUS.REJECT;
}

/** API row with qty/coil_no + legacy aliases + flags derived from sticker_status. */
export function decorateMrnDbRow(row) {
  if (!row) return null;
  const qty = row.qty ?? row.it_recp_qty ?? null;
  const coil_no = row.coil_no ?? row.it_lot_no ?? null;
  const sticker_status = normalizeMrnStickerStatus(row.sticker_status);
  const sticker_generated = isMrnStickerGeneratedStatus(sticker_status);
  const sticker_approved = isMrnStickerApprovedStatus(sticker_status);
  const sticker_rejected = isMrnStickerRejectedStatus(sticker_status);
  const sticker_by = row.sticker_by ?? null;
  const sticker_at = row.sticker_at ?? null;
  return {
    ...row,
    qty,
    coil_no,
    it_recp_qty: qty,
    it_lot_no: coil_no,
    itLotNo: coil_no,
    sticker_status,
    sticker_generated,
    sticker_approved,
    sticker_rejected,
    sticker_by,
    sticker_at,
    sticker_draft_by: sticker_status === MRN_STICKER_STATUS.DRAFT ? sticker_by : null,
    sticker_draft_at: sticker_status === MRN_STICKER_STATUS.DRAFT ? sticker_at : null,
    sticker_approved_by: sticker_approved ? sticker_by : null,
    sticker_approved_at: sticker_approved ? sticker_at : null,
    sticker_rejected_by: sticker_rejected ? sticker_by : null,
    sticker_rejected_at: sticker_rejected ? sticker_at : null,
    system_generate_user_name: row.system_generate_user_name ?? row.system_generate_user ?? null,
    created_by_name: row.created_by_name ?? row.system_generate_user ?? null,
    created_at: row.created_at ?? row.system_generate_date ?? null,
  };
}

function pickQty(data = {}) {
  return data.qty ?? data.it_recp_qty ?? null;
}

function pickCoilNo(data = {}) {
  return data.coil_no ?? data.it_lot_no ?? data.itLotNo ?? null;
}

const DEFAULT_FIELDS = [
  "m.uid", "m.mrn_no", "m.mrn_dt",
  "m.bill_no", "m.bill_dt", "m.acc_code", "m.acc_name",
  "m.item_dcode", "m.item_code", "m.item_desc",
  "m.heat_no", "m.remarks",
  "m.qty", "m.coil_no", "m.it_unit", "m.fyid",
  "m.sticker_mode",
  "m.sticker_status", "m.sticker_by", "m.sticker_at", "m.sticker_reject_uid",
  "m.internal_create_user", "m.internal_create_date",
  "m.system_generate_user", "m.system_generate_date",
  "m.tc_file_path", "m.rmtc_file_path",
  "m.sticker_draft",
  "NULLIF((regexp_match(m.uid, '_([0-9]+)$'))[1], '')::integer AS serial_no",
  "m.system_generate_user AS system_generate_user_name",
  "m.system_generate_user AS created_by_name",
  "m.system_generate_date AS created_at",
];

function mapRows(rows) {
  return (rows || []).map(decorateMrnDbRow);
}

function mapRow(row) {
  return decorateMrnDbRow(row);
}

export const findMrnByUid = async (uid) => {
  if (!uid) return null;
  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} m
     WHERE m.uid = $1
     LIMIT 1`,
    [String(uid)]
  );
  return mapRow(row);
};

/** Resolve local MRN by uid, `{mrn_no}_{serial_no}`, or plain mrn_no. */
export const findMrnByLookup = async (key) => {
  const k = String(key || "").trim();
  if (!k) return null;

  const byUid = await findMrnByUid(k);
  if (byUid) return byUid;

  const composite = k.match(/^(\d+)_(\d+)$/);
  if (composite) {
    const [row] = await dbQuery(
      `SELECT ${DEFAULT_FIELDS.join(", ")}
       FROM ${TABLE} m
       WHERE m.uid = $1 OR (m.mrn_no::text = $2 AND m.uid = $2 || '_' || $3)
       LIMIT 1`,
      [k, composite[1], composite[2]]
    );
    if (row) return mapRow(row);
  }

  if (/^\d+$/.test(k)) {
    const [row] = await dbQuery(
      `SELECT ${DEFAULT_FIELDS.join(", ")}
       FROM ${TABLE} m
       WHERE m.mrn_no::text = $1
       ORDER BY
         CASE COALESCE(m.sticker_status, 'pending')
           WHEN 'approved' THEN 3
           WHEN 'generate' THEN 2
           WHEN 'draft' THEN 1
           ELSE 0
         END DESC,
         m.uid ASC
       LIMIT 1`,
      [k]
    );
    if (row) return mapRow(row);
  }

  return null;
};

/** All MRN UIDs sharing the same mrn_no (for minus coil picker). */
export const findMrnUidsByMrnNo = async (mrn_no) => {
  if (mrn_no == null || String(mrn_no).trim() === "") return [];
  const rows = await dbQuery(
    `SELECT uid FROM ${TABLE} WHERE mrn_no::text = $1`,
    [String(mrn_no).trim()]
  );
  return (rows || []).map((r) => String(r.uid || "").trim()).filter(Boolean);
};

export const findAllActiveMrnByUid = async () => {
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} m`
  );
  const map = new Map();
  for (const row of mapRows(rows)) {
    map.set(String(row.uid), row);
  }
  return map;
};

export const findGeneratedMrns = async ({ search, page = 1, limit = 1000, from_date, to_date, permission = {}, approved_only = true } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    approved_only
      ? `m.sticker_status = '${MRN_STICKER_STATUS.APPROVED}'`
      : `m.sticker_status IN ('${MRN_STICKER_STATUS.GENERATE}', '${MRN_STICKER_STATUS.APPROVED}')`,
    `EXISTS (
      SELECT 1 FROM ${T.COIL_TABLE} c
      WHERE c.mrn_uid = m.uid
        AND c.sa_id IS NULL
        AND NULLIF(TRIM(c.mrn_uid::text), '') IS NOT NULL
        AND LOWER(COALESCE(c.sa_entry_type, '')) <> 'production_return'
    )`,
  ];

  if (permission?.can_view_days > 0) {
    conditions.push(`m.mrn_dt >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (from_date) {
    values.push(from_date);
    conditions.push(`m.mrn_dt >= $${i++}::timestamp`);
  }
  if (to_date) {
    values.push(to_date);
    conditions.push(`m.mrn_dt <= $${i++}::timestamp`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      m.uid ILIKE $${idx} OR
      m.mrn_no::text ILIKE $${idx} OR
      COALESCE(m.bill_no, '') ILIKE $${idx} OR
      COALESCE(m.item_code, '') ILIKE $${idx} OR
      COALESCE(m.acc_name, '') ILIKE $${idx} OR
      COALESCE(m.coil_no, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} m ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} m
     ${where}
     ORDER BY m.mrn_dt DESC NULLS LAST, m.mrn_no DESC, m.uid ASC
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );

  return { data: mapRows(rows), total, page: safePage, limit: safeLimit };
};

export const insertMrn = async (data) => {
  const {
    uid, mrn_no, mrn_dt, bill_no, bill_dt,
    acc_code, acc_name, item_dcode, item_code, item_desc,
    heat_no,
    it_unit, fyid,
    internal_create_user, internal_create_date,
    system_generate_user, system_generate_date,
    sticker_status,
    sticker_generated = false,
  } = data;

  const qty = pickQty(data);
  const coil_no = pickCoilNo(data);
  const status = sticker_status
    ? normalizeMrnStickerStatus(sticker_status)
    : sticker_generated
      ? MRN_STICKER_STATUS.GENERATE
      : MRN_STICKER_STATUS.PENDING;

  const internalUser =
    internal_create_user != null && String(internal_create_user).trim() !== ""
      ? String(internal_create_user).trim()
      : null;
  const internalDate =
    internal_create_date != null && String(internal_create_date).trim() !== ""
      ? String(internal_create_date).trim()
      : null;
  const systemUser =
    system_generate_user != null && String(system_generate_user).trim() !== ""
      ? String(system_generate_user).trim()
      : null;

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
     (uid, mrn_no, mrn_dt, bill_no, bill_dt,
      acc_code, acc_name, item_dcode, item_code, item_desc, heat_no,
      qty, coil_no, it_unit, fyid,
      internal_create_user, internal_create_date,
      system_generate_user, system_generate_date, sticker_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      String(uid), mrn_no ?? null, mrn_dt ?? null, bill_no ?? null, bill_dt ?? null,
      acc_code ?? null, acc_name ?? null, item_dcode ?? null, item_code ?? null, item_desc ?? null,
      heat_no ?? null,
      qty ?? null, coil_no ?? null, it_unit ?? null, fyid ?? null,
      internalUser, internalDate, systemUser, system_generate_date ?? null, status,
    ]
  );
  return mapRow(row);
};

/** Minimal MRN row built from a coil list/detail row (MRN join fields). */
export function mrnSnapshotFromCoil(coil, mrn_uid = null) {
  if (!coil) return null;
  const uid = String(mrn_uid || coil.mrn_uid || "").trim();
  if (!uid) return null;
  const qty = coil.qty ?? coil.it_recp_qty ?? null;
  const coil_no = coil.coil_no ?? coil.it_lot_no ?? null;
  return {
    uid,
    mrn_no: coil.mrn_no ?? null,
    mrn_dt: coil.mrn_dt ?? null,
    bill_no: coil.bill_no ?? null,
    bill_dt: coil.bill_dt ?? null,
    acc_code: coil.acc_code ?? null,
    acc_name: coil.acc_name ?? null,
    item_dcode: coil.item_dcode ?? null,
    item_code: coil.item_code ?? null,
    item_desc: coil.item_desc ?? null,
    heat_no: coil.heat_no ?? null,
    remarks: coil.remarks ?? null,
    qty,
    coil_no,
    it_recp_qty: qty,
    it_lot_no: coil_no,
    it_unit: coil.it_unit ?? null,
    fyid: coil.fyid ?? null,
    sticker_status: MRN_STICKER_STATUS.APPROVED,
    sticker_generated: true,
    sticker_approved: true,
  };
}

export const updateMrnStickerMeta = async (uid, { heat_no, remarks } = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET heat_no = COALESCE($2::text, heat_no),
         remarks = COALESCE($3::text, remarks)
     WHERE uid = $1
     RETURNING *`,
    [key, heat_no ?? null, remarks ?? null]
  );
  return mapRow(row);
};

/** Copy coil_no → heat_no when heat_no is blank (SA stub / ERP lot rows). */
export const syncMrnHeatFromLot = async (uid, preferredHeat = null) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const heat = preferredHeat != null ? String(preferredHeat).trim() || null : null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET heat_no = COALESCE(
           NULLIF(TRIM($2::text), ''),
           NULLIF(TRIM(heat_no), ''),
           NULLIF(TRIM(coil_no), '')
         ),
         coil_no = COALESCE(NULLIF(TRIM(coil_no), ''), NULLIF(TRIM($2::text), ''))
     WHERE uid = $1
       AND (
         NULLIF(TRIM(COALESCE(heat_no, '')), '') IS NULL
         OR NULLIF(TRIM(COALESCE(coil_no, '')), '') IS NULL
       )
     RETURNING *`,
    [key, heat]
  );
  return mapRow(row);
};

export const setMrnStickerGenerated = async (uid, { user, at, sticker_mode } = {}) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.GENERATE}',
         sticker_by = COALESCE($2::text, sticker_by),
         sticker_at = COALESCE($3::timestamptz, NOW()),
         sticker_reject_uid = NULL,
         system_generate_user = COALESCE($2::text, system_generate_user),
         system_generate_date = COALESCE($3::timestamptz, NOW()),
         sticker_mode = COALESCE($4::text, sticker_mode),
         sticker_draft = NULL
     WHERE uid = $1
     RETURNING *`,
    [String(uid), user ?? null, at ?? null, sticker_mode ?? null]
  );
  return mapRow(row);
};

export const setMrnStickerApproved = async (uid, { user, at } = {}) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.APPROVED}',
         sticker_by = COALESCE($2::text, sticker_by),
         sticker_at = COALESCE($3::timestamptz, NOW())
     WHERE uid = $1
       AND sticker_status = '${MRN_STICKER_STATUS.GENERATE}'
     RETURNING *`,
    [String(uid), user ?? null, at ?? null]
  );
  return mapRow(row);
};

export const setMrnStickerRejected = async (uid, { reject_uid, user, at } = {}) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.REJECT}',
         sticker_reject_uid = COALESCE($2::int, sticker_reject_uid),
         sticker_by = COALESCE($3::text, sticker_by),
         sticker_at = COALESCE($4::timestamptz, NOW())
     WHERE uid = $1
     RETURNING *`,
    [String(uid), reject_uid ?? null, user ?? null, at ?? null]
  );
  return mapRow(row);
};

export const clearMrnStickerRejected = async (uid) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.PENDING}',
         sticker_reject_uid = NULL,
         sticker_by = NULL,
         sticker_at = NULL,
         sticker_draft = NULL
     WHERE uid = $1
       AND sticker_status = '${MRN_STICKER_STATUS.REJECT}'
     RETURNING *`,
    [key]
  );
  return mapRow(row);
};

export const clearMrnStickerRejectedByRejectUid = async (qc_reject_uid) => {
  const id = Number(qc_reject_uid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.PENDING}',
         sticker_reject_uid = NULL,
         sticker_by = NULL,
         sticker_at = NULL,
         sticker_draft = NULL
     WHERE sticker_reject_uid = $1
       AND sticker_status = '${MRN_STICKER_STATUS.REJECT}'
     RETURNING *`,
    [id]
  );
  return mapRow(row);
};

export const saveMrnStickerDraft = async (uid, { draft, user, at } = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const draftJson =
    draft == null
      ? null
      : typeof draft === "string"
        ? draft
        : JSON.stringify(draft);
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_draft = $2::jsonb,
         sticker_status = '${MRN_STICKER_STATUS.DRAFT}',
         sticker_by = COALESCE($3::text, sticker_by),
         sticker_at = COALESCE($4::timestamptz, NOW())
     WHERE uid = $1
       AND COALESCE(sticker_status, 'pending') IN ('pending', 'draft')
     RETURNING *`,
    [key, draftJson, user != null ? String(user) : null, at ?? null]
  );
  return mapRow(row);
};

export const clearMrnStickerDraft = async (uid) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_draft = NULL,
         sticker_status = CASE
           WHEN sticker_status = '${MRN_STICKER_STATUS.DRAFT}' THEN '${MRN_STICKER_STATUS.PENDING}'
           ELSE sticker_status
         END,
         sticker_by = CASE
           WHEN sticker_status = '${MRN_STICKER_STATUS.DRAFT}' THEN NULL
           ELSE sticker_by
         END,
         sticker_at = CASE
           WHEN sticker_status = '${MRN_STICKER_STATUS.DRAFT}' THEN NULL
           ELSE sticker_at
         END
     WHERE uid = $1
     RETURNING *`,
    [key]
  );
  return mapRow(row);
};

export const resetMrnStickerGenerated = async (uid) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_status = '${MRN_STICKER_STATUS.PENDING}',
         sticker_by = NULL,
         sticker_at = NULL,
         sticker_reject_uid = NULL,
         system_generate_user = NULL,
         system_generate_date = NULL,
         sticker_mode = NULL,
         sticker_draft = NULL
     WHERE uid = $1
     RETURNING *`,
    [String(uid)]
  );
  return mapRow(row);
};

/** Permanently remove local MRN row (after coils/QC are gone). */
export const hardDeleteMrnByUid = async (uid) => {
  const key = String(uid || "").trim();
  if (!key) return false;
  const rows = await dbQuery(
    `DELETE FROM ${TABLE} WHERE uid = $1 RETURNING uid`,
    [key]
  );
  return Array.isArray(rows) && rows.length > 0;
};

/** Store TC / RMTC paths once on the MRN (not on each coil). */
export const updateMrnDocs = async (uid, docs = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET tc_file_path = COALESCE($2::text, tc_file_path),
         rmtc_file_path = COALESCE($3::text, rmtc_file_path)
     WHERE uid = $1
     RETURNING *`,
    [
      key,
      docs.tc_file_path ?? null,
      docs.rmtc_file_path ?? null,
    ]
  );
  return mapRow(row);
};
