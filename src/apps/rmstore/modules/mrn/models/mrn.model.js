import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { portalMrnCoilSql } from "../../coil/models/coil.model.js";

const TABLE = T.MRN;

const DEFAULT_FIELDS = [
  "m.uid", "m.mrn_no", "m.serial_no", "m.mrn_dt",
  "m.bill_no", "m.bill_dt", "m.acc_code", "m.acc_name",
  "m.item_dcode", "m.item_code", "m.item_desc",
  "m.heat_no", "m.remarks",
  "m.it_recp_qty", "m.it_lot_no", "m.it_unit", "m.fyid",
  "m.sticker_mode",
  "m.sticker_generated",
  "m.internal_create_user", "m.internal_create_date",
  "m.system_generate_user", "m.system_generate_date",
  "m.tc_file_path", "m.tc_file_name", "m.rmtc_file_path", "m.rmtc_file_name",
  "m.sticker_draft", "m.sticker_draft_at", "m.sticker_draft_by",
  "m.system_generate_user AS system_generate_user_name",
  "m.system_generate_user AS created_by_name",
  "m.system_generate_date AS created_at",
];

export const findMrnByUid = async (uid) => {
  if (!uid) return null;
  const [row] = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} m
     WHERE m.uid = $1
     LIMIT 1`,
    [String(uid)]
  );
  return row ?? null;
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
       WHERE m.mrn_no::text = $1 AND m.serial_no::text = $2
       LIMIT 1`,
      [composite[1], composite[2]]
    );
    if (row) return row;
  }

  if (/^\d+$/.test(k)) {
    const [row] = await dbQuery(
      `SELECT ${DEFAULT_FIELDS.join(", ")}
       FROM ${TABLE} m
       WHERE m.mrn_no::text = $1
       ORDER BY m.sticker_generated DESC, m.serial_no ASC NULLS LAST
       LIMIT 1`,
      [k]
    );
    if (row) return row;
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
  for (const row of rows || []) {
    map.set(String(row.uid), row);
  }
  return map;
};

export const findGeneratedMrns = async ({ search, page = 1, limit = 1000, from_date, to_date, permission = {} } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    "m.sticker_generated = true",
    `EXISTS (
      SELECT 1 FROM ${T.COIL_TABLE} c
      WHERE c.mrn_uid = m.uid
        AND c.is_deleted = false
        AND ${portalMrnCoilSql("c")}
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
      COALESCE(m.it_lot_no, '') ILIKE $${idx}
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
     ORDER BY m.mrn_dt DESC NULLS LAST, m.mrn_no DESC, m.serial_no ASC
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit };
};

export const insertMrn = async (data) => {
  const {
    uid, mrn_no, serial_no, mrn_dt, bill_no, bill_dt,
    acc_code, acc_name, item_dcode, item_code, item_desc,
    heat_no,
    it_recp_qty, it_lot_no, it_unit, fyid,
    internal_create_user, internal_create_date,
    system_generate_user, system_generate_date,
    sticker_generated = false,
  } = data;

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
     (uid, mrn_no, serial_no, mrn_dt, bill_no, bill_dt,
      acc_code, acc_name, item_dcode, item_code, item_desc, heat_no,
      it_recp_qty, it_lot_no, it_unit, fyid,
      internal_create_user, internal_create_date,
      system_generate_user, system_generate_date, sticker_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      String(uid), mrn_no ?? null, serial_no ?? null, mrn_dt ?? null, bill_no ?? null, bill_dt ?? null,
      acc_code ?? null, acc_name ?? null, item_dcode ?? null, item_code ?? null, item_desc ?? null,
      heat_no ?? null,
      it_recp_qty ?? null, it_lot_no ?? null, it_unit ?? null, fyid ?? null,
      internalUser, internalDate, systemUser, system_generate_date ?? null, !!sticker_generated,
    ]
  );
  return row;
};

/** Minimal MRN row built from a coil list/detail row (MRN join fields). */
export function mrnSnapshotFromCoil(coil, mrn_uid = null) {
  if (!coil) return null;
  const uid = String(mrn_uid || coil.mrn_uid || "").trim();
  if (!uid) return null;
  return {
    uid,
    mrn_no: coil.mrn_no ?? null,
    serial_no: coil.serial_no ?? null,
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
    it_recp_qty: coil.it_recp_qty ?? null,
    it_lot_no: coil.it_lot_no ?? null,
    it_unit: coil.it_unit ?? null,
    fyid: coil.fyid ?? null,
    sticker_generated: true,
  };
}

export const updateMrnStickerMeta = async (uid, { heat_no, remarks } = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET heat_no = COALESCE($2, heat_no),
         remarks = COALESCE($3, remarks)
     WHERE uid = $1
     RETURNING *`,
    [key, heat_no ?? null, remarks ?? null]
  );
  return row ?? null;
};

/** Copy it_lot_no → heat_no when heat_no is blank (SA stub / ERP lot rows). */
export const syncMrnHeatFromLot = async (uid, preferredHeat = null) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const heat = preferredHeat != null ? String(preferredHeat).trim() || null : null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET heat_no = COALESCE(
           NULLIF(TRIM($2::text), ''),
           NULLIF(TRIM(heat_no), ''),
           NULLIF(TRIM(it_lot_no), '')
         ),
         it_lot_no = COALESCE(NULLIF(TRIM(it_lot_no), ''), NULLIF(TRIM($2::text), ''))
     WHERE uid = $1
       AND (
         NULLIF(TRIM(COALESCE(heat_no, '')), '') IS NULL
         OR NULLIF(TRIM(COALESCE(it_lot_no, '')), '') IS NULL
       )
     RETURNING *`,
    [key, heat]
  );
  return row ?? null;
};

export const setMrnStickerGenerated = async (uid, { user, at, sticker_mode } = {}) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_generated = true,
         system_generate_user = COALESCE($2::text, system_generate_user),
         system_generate_date = COALESCE($3::timestamptz, NOW()),
         sticker_mode = COALESCE($4::text, sticker_mode),
         sticker_draft = NULL,
         sticker_draft_at = NULL,
         sticker_draft_by = NULL
     WHERE uid = $1
     RETURNING *`,
    [String(uid), user ?? null, at ?? null, sticker_mode ?? null]
  );
  return row ?? null;
};

export const saveMrnStickerDraft = async (uid, { draft, user, at } = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_draft = $2::jsonb,
         sticker_draft_at = COALESCE($3::timestamptz, NOW()),
         sticker_draft_by = COALESCE($4::text, sticker_draft_by)
     WHERE uid = $1
     RETURNING *`,
    [key, draft ?? null, at ?? null, user ?? null]
  );
  return row ?? null;
};

export const clearMrnStickerDraft = async (uid) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_draft = NULL,
         sticker_draft_at = NULL,
         sticker_draft_by = NULL
     WHERE uid = $1
     RETURNING *`,
    [key]
  );
  return row ?? null;
};

export const resetMrnStickerGenerated = async (uid) => {
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET sticker_generated = false,
         system_generate_user = NULL,
         system_generate_date = NULL,
         sticker_mode = NULL,
         sticker_draft = NULL,
         sticker_draft_at = NULL,
         sticker_draft_by = NULL
     WHERE uid = $1
     RETURNING *`,
    [String(uid)]
  );
  return row ?? null;
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

/** Store TC / RMTC once on the MRN (not on each coil). */
export const updateMrnDocs = async (uid, docs = {}) => {
  const key = String(uid || "").trim();
  if (!key) return null;
  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET tc_file_path = COALESCE($2, tc_file_path),
         tc_file_name = COALESCE($3, tc_file_name),
         rmtc_file_path = COALESCE($4, rmtc_file_path),
         rmtc_file_name = COALESCE($5, rmtc_file_name)
     WHERE uid = $1
     RETURNING *`,
    [
      key,
      docs.tc_file_path ?? null,
      docs.tc_file_name ?? null,
      docs.rmtc_file_path ?? null,
      docs.rmtc_file_name ?? null,
    ]
  );
  return row ?? null;
};
