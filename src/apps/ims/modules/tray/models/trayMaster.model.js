import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { columnExists } from "../../../../../config/db/ensureDbColumns.js";
import { batchIdFromCodes, buildTrayCode, normalizeTrayLetter } from "../config/trayCode.js";
import { BIN_TYPE_SQL, IMS_TRAY_TYPE_SQL, normalizeTrayType } from "../config/trayTypes.js";
import { isValidTrayStatus, normalizeTrayStatus, TRAY_HELD_SQL } from "../config/trayStatuses.js";
import { TRAY_OCC_JOIN, TRAY_POOL_EXPR } from "../lib/trayOccupancySql.js";
import { normalizeTrayLookupCode } from "../utils/trayScanParse.js";

export const TRAY_BATCH_JOIN = `LEFT JOIN ${T.TRAY_BATCH} tb ON tb.id = t.batch_id`;
export const TRAY_BATCH_ID_EXPR = `tb.batch_id AS batch_id`;

const ALLOWED_FILTER_FIELDS = ["id", "code", "type", "letter", "category", "b_type", "class", "kind", "variant", "subtype", "material", "material_type", "batch_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "code", "type", "serial_number", "batch_id", "created_at"];

const BATCH_JOIN = TRAY_BATCH_JOIN;
const APPROVED_EXPR = `COALESCE(tb.approved, false) AS approved`;
const NOT_DELETED_BATCH = `COALESCE(tb.is_deleted, false) = false`;

/** Legacy DBs may still use `category` until v5.2.6 letter migration runs. */
let trayLetterSchemaReady = false;
let trayLetterSelectPair = "t.letter AS letter, t.letter AS class";
let trayLetterFilterExpr = "UPPER(BTRIM(COALESCE(t.letter, '')))";
let trayLetterDistinctExpr = "UPPER(BTRIM(COALESCE(t.letter::text, '')))";
let trayLetterRawExpr = "t.letter";
let trayLetterDbColumn = "letter";

export async function ensureTrayLetterSchema() {
  if (trayLetterSchemaReady) return;
  const hasLetter = await columnExists(dbQuery, T.TRAY_MASTER, "letter");
  if (hasLetter) {
    trayLetterSchemaReady = true;
    return;
  }
  if (await columnExists(dbQuery, T.TRAY_MASTER, "category")) {
    trayLetterSelectPair = "t.category AS letter, t.category AS class";
    trayLetterFilterExpr = "UPPER(BTRIM(COALESCE(t.category, '')))";
    trayLetterDistinctExpr = "UPPER(BTRIM(COALESCE(t.category::text, '')))";
    trayLetterRawExpr = "t.category";
    trayLetterDbColumn = "category";
  } else {
    trayLetterSelectPair = "NULL::varchar AS letter, NULL::varchar AS class";
    trayLetterFilterExpr = "''";
    trayLetterDistinctExpr = "''";
    trayLetterRawExpr = "NULL";
    trayLetterDbColumn = "letter";
  }
  trayLetterSchemaReady = true;
}

function buildDefaultFields() {
  return [
    "t.id",
    "t.code",
    "t.type",
    trayLetterSelectPair,
    "t.serial_number",
    TRAY_BATCH_ID_EXPR,
    "t.weight",
    APPROVED_EXPR,
    "tb.approved_by",
    "tb.approved_at",
    "t.status",
    `${TRAY_POOL_EXPR} AS pool_status`,
    "tb.remark",
    "tb.b_type AS b_type",
    "tb.created_at AS created_at",
    "tb.created_by AS created_by",
    "t.updated_by",
    "t.updated_at",
    "tb.created_by AS created_by_name",
    "t.updated_by AS updated_by_name",
    "tb.approved_by AS approved_by_name",
  ];
}

export const TRAY_DEFAULT_FIELDS = buildDefaultFields();

function selectFields(fields = []) {
  if (!fields.length) return buildDefaultFields().join(", ");
  return fields
    .map((f) => {
      const key = String(f || "").trim();
      if (key === "t.approved" || key === "approved") return APPROVED_EXPR;
      if (key === "t.created_by" || key === "created_by") return "tb.created_by AS created_by";
      if (key === "t.created_by AS created_by_name" || key === "created_by_name") {
        return "tb.created_by AS created_by_name";
      }
      if (key === "t.approved_by" || key === "approved_by") return "tb.approved_by";
      if (key === "t.approved_at" || key === "approved_at") return "tb.approved_at";
      if (key === "t.approved_by AS approved_by_name" || key === "approved_by_name") {
        return "tb.approved_by AS approved_by_name";
      }
      if (key === "t.created_at" || key === "created_at") return "tb.created_at AS created_at";
      if (key === "t.pool_status" || key === "pool_status") return `${TRAY_POOL_EXPR} AS pool_status`;
      if (key === "t.remark" || key === "remark") return "tb.remark";
      if (key === "t.batch_id" || key === "batch_id") return TRAY_BATCH_ID_EXPR;
      if (key === "t.weight" || key === "weight") return "t.weight";
      return key;
    })
    .join(", ");
}

function needsOccJoin(fields = []) {
  if (!fields.length) return true;
  return fields.some((f) => {
    const key = String(f || "").trim();
    return key === "t.pool_status" || key === "pool_status" || key.includes("pool_status");
  });
}

function fromSql(fields = [], withOcc = null) {
  const occ = withOcc == null ? needsOccJoin(fields) : withOcc;
  return `FROM ${T.TRAY_MASTER} t
     ${BATCH_JOIN}
     ${occ ? TRAY_OCC_JOIN : ""}`;
}

function pushStatusCondition(conditions, values, statusFilter, paramIndex) {
  let i = paramIndex;
  const raw = String(statusFilter || "").trim().toLowerCase();
  if (!raw || raw === "all") return i;
  if (raw === "not_deleted") return i;
  const normalized = normalizeTrayStatus(statusFilter);
  if (normalized === "inactive") {
    conditions.push(`TRIM(COALESCE(t.status, '')) IN ${TRAY_HELD_SQL}`);
    return i;
  }
  values.push(normalized);
  conditions.push(`TRIM(COALESCE(t.status, '')) = $${i++}::text`);
  return i;
}

function coerceApproved(val) {
  return val === true || String(val).toLowerCase() === "true";
}

function pushTypeScope(conditions, scope, { batchAgg = false } = {}) {
  const raw = String(scope || "").trim().toLowerCase();
  if (!raw || raw === "all") return;
  const expr = batchAgg
    ? `UPPER(TRIM(COALESCE(agg.type, '')))`
    : `UPPER(TRIM(COALESCE(t.type, '')))`;
  if (raw === "ims") conditions.push(`${expr} IN ${IMS_TRAY_TYPE_SQL}`);
  else if (raw === "bin") conditions.push(`${expr} IN ${BIN_TYPE_SQL}`);
}

export async function findTrays(options = {}) {
  await ensureTrayLetterSchema();
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], typeScope } = options;

  const values = [];
  let i = 1;
  const conditions = [NOT_DELETED_BATCH];
  pushTypeScope(conditions, typeScope);
  let statusFilter = "all";

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`tb.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`tb.created_at <= $${i++}`);
      continue;
    }

    if (key === "type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${i++}::text`);
      continue;
    }

    if (key === "letter" || key === "category" || key === "class") {
      const letter = normalizeTrayLetter(val);
      if (!letter) continue;
      values.push(letter);
      conditions.push(`${trayLetterFilterExpr} = $${i++}::text`);
      continue;
    }

    if (key === "b_type" || key === "kind" || key === "variant" || key === "subtype" || key === "material" || key === "material_type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(tb.b_type, ''))) = $${i++}::text`);
      continue;
    }

    if (key === "status") {
      const raw = String(val).trim().toLowerCase();
      statusFilter = raw === "all" ? "all" : String(val).trim();
      continue;
    }

    if (key === "id") {
      values.push(Number(val));
      conditions.push(`t.id = $${i++}::int`);
      continue;
    }

    if (key === "code") {
      values.push(normalizeTrayLookupCode(val));
      conditions.push(`t.code = $${i++}::text`);
      continue;
    }

    if (key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`tb.batch_id = $${i++}::text`);
      continue;
    }

    if (key === "approved") {
      if (String(val).trim().toLowerCase() === "all") continue;
      values.push(coerceApproved(val));
      conditions.push(`COALESCE(tb.approved, false) = $${i++}::boolean`);
      continue;
    }

    values.push(val);
    conditions.push(`t.${key} = $${i++}`);
  }

  i = pushStatusCondition(conditions, values, statusFilter, i);

  if (search) {
    const idx = i++;
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      t.code ILIKE $${idx}::text
      OR t.type ILIKE $${idx}::text
      OR tb.batch_id ILIKE $${idx}::text
      OR t.serial_number::text ILIKE $${idx}::text
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count ${fromSql(fields, false)} ${where}`,
    values,
  );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "serial_number";
  const sortOrder = String(sort.order || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
  const sortExpr =
    sortByField === "created_at"
      ? `tb.created_at ${sortOrder}`
      : sortByField === "batch_id"
        ? `tb.batch_id ${sortOrder}`
        : sortByField === "serial_number"
          ? `t.type ASC, t.serial_number ${sortOrder}`
          : `t.${sortByField} ${sortOrder}`;

  const rows = await dbQuery(
    `SELECT ${selectFields(fields)}
     ${fromSql(fields)}
     ${where}
     ORDER BY ${sortExpr}
     LIMIT $${values.length + 1}::int OFFSET $${values.length + 2}::int`,
    [...values, safeLimit, offset],
  );

  return {
    data: rows,
    total: Number(count || 0),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count || 0) / safeLimit),
  };
}

export async function findTray(filters = {}, options = {}) {
  await ensureTrayLetterSchema();
  const { fields = [], typeScope } = options;
  const values = [];
  let i = 1;
  const conditions = [NOT_DELETED_BATCH];
  pushTypeScope(conditions, typeScope);
  let statusFilter = "all";

  for (const [key, val] of Object.entries(filters || {})) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${i++}::text`);
      continue;
    }

    if (key === "letter" || key === "category" || key === "class") {
      const letter = normalizeTrayLetter(val);
      if (!letter) continue;
      values.push(letter);
      conditions.push(`${trayLetterFilterExpr} = $${i++}::text`);
      continue;
    }

    if (key === "b_type" || key === "kind" || key === "variant" || key === "subtype" || key === "material" || key === "material_type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(tb.b_type, ''))) = $${i++}::text`);
      continue;
    }

    if (key === "status") {
      const raw = String(val).trim().toLowerCase();
      statusFilter = raw === "all" ? "all" : String(val).trim();
      continue;
    }

    if (key === "id") {
      values.push(Number(val));
      conditions.push(`t.id = $${i++}::int`);
      continue;
    }

    if (key === "code") {
      values.push(normalizeTrayLookupCode(val));
      conditions.push(`t.code = $${i++}::text`);
      continue;
    }

    if (key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`tb.batch_id = $${i++}::text`);
      continue;
    }

    if (key === "approved") {
      if (String(val).trim().toLowerCase() === "all") continue;
      values.push(coerceApproved(val));
      conditions.push(`COALESCE(tb.approved, false) = $${i++}::boolean`);
      continue;
    }

    values.push(val);
    conditions.push(`t.${key} = $${i++}`);
  }

  i = pushStatusCondition(conditions, values, statusFilter, i);

  const [row] = await dbQuery(
    `SELECT ${selectFields(fields)}
     ${fromSql(fields)}
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values,
  );
  return row ?? null;
}

export async function findDistinctBinMaterials({ search } = {}) {
  const searchVal = search != null && String(search).trim() !== "" ? `%${normalizeTrayType(search)}%` : null;
  const params = searchVal ? [searchVal] : [];
  const rows = await dbQuery(
    `SELECT DISTINCT UPPER(BTRIM(COALESCE(b.b_type::text, ''))) AS b_type
     FROM ${T.TRAY_BATCH} b
     LEFT JOIN LATERAL (
       SELECT MIN(t.type) AS type
       FROM ${T.TRAY_MASTER} t
       WHERE t.batch_id = b.id
     ) agg ON true
     WHERE COALESCE(b.is_deleted, false) = false
       AND UPPER(BTRIM(COALESCE(agg.type::text, ''))) IN ${BIN_TYPE_SQL}
       AND NULLIF(BTRIM(COALESCE(b.b_type::text, '')), '') IS NOT NULL
       ${searchVal ? `AND UPPER(BTRIM(COALESCE(b.b_type::text, ''))) ILIKE $1` : ""}
     ORDER BY b_type ASC
     LIMIT 80`,
    params,
  );
  const fromDb = (rows || []).map((r) => String(r.b_type ?? "").trim()).filter(Boolean);
  const merged = [...new Set(fromDb)].sort();
  if (!searchVal) return merged;
  const needle = normalizeTrayType(search);
  return merged.filter((tag) => tag.includes(needle));
}

export async function findDistinctBinCategories({ search } = {}) {
  await ensureTrayLetterSchema();
  const searchVal = search != null && String(search).trim() !== "" ? `%${normalizeTrayLetter(search) || normalizeTrayType(search)}%` : null;
  const params = searchVal ? [searchVal] : [];
  const rows = await dbQuery(
    `SELECT DISTINCT ${trayLetterDistinctExpr} AS letter
     FROM ${T.TRAY_MASTER} t
     INNER JOIN ${T.TRAY_BATCH} b ON b.id = t.batch_id
     WHERE COALESCE(b.is_deleted, false) = false
       AND UPPER(BTRIM(COALESCE(t.type::text, ''))) IN ${BIN_TYPE_SQL}
       AND NULLIF(BTRIM(${trayLetterDistinctExpr}), '') IS NOT NULL
       ${searchVal ? `AND ${trayLetterDistinctExpr} ILIKE $1` : ""}
     ORDER BY letter ASC
     LIMIT 80`,
    params,
  );
  const fromDb = (rows || []).map((r) => String(r.letter ?? "").trim()).filter(Boolean);
  const merged = [...new Set(fromDb)].sort();
  if (!searchVal) return merged;
  const needle = normalizeTrayLetter(search) || normalizeTrayType(search);
  return merged.filter((tag) => tag.includes(needle));
}

export async function createTrayBatch({
  type,
  quantity,
  created_by,
  approved = false,
  remark = null,
  letter = null,
  category = null,
  class: trayClass = null,
  b_type: batchBType = null,
  kind = null,
  variant = null,
  subtype = null,
  material_type = null,
  material = null,
}) {
  await ensureTrayLetterSchema();
  const normalizedType = normalizeTrayType(type);
  const normalizedLetter = normalizeTrayLetter(letter ?? category ?? trayClass);
  const bTypeRaw = batchBType ?? kind ?? variant ?? subtype ?? material_type ?? material;
  /** `ims_tray_batch.b_type` = Plastic/Iron. Tray type FG/RM/PRD → `ims_tray_master.type`. */
  const normalizedBType =
    bTypeRaw != null && String(bTypeRaw).trim() !== "" ? normalizeTrayType(bTypeRaw) : null;
  const qty = Math.trunc(Number(quantity) || 0);
  const note = String(remark ?? "").trim() || null;

  if (!normalizedType) throw new Error("Tray type is required.");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Enter a number greater than 0.");

  return withTransaction(async (client) => {
    await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);

    const maxSerial = await getMaxSerial(client, normalizedType, normalizedLetter);
    const startSerial = maxSerial + 1;
    const endSerial = startSerial + qty - 1;
    const startCode = buildTrayCode(normalizedType, normalizedLetter, startSerial);
    const endCode = buildTrayCode(normalizedType, normalizedLetter, endSerial);
    const batchId = batchIdFromCodes(startCode, endCode);

    const inserted = await client.query(
      `INSERT INTO ${T.TRAY_BATCH} (batch_id, b_type, remark, approved, created_by, created_at)
       VALUES ($1::text, $2::text, $3::text, false, $4::text, NOW())
       RETURNING id, created_at`,
      [batchId, normalizedBType || null, note, created_by ?? null],
    );
    const batchUid = Number(inserted.rows?.[0]?.id);

    if (approved) {
      await applyBatchApproval(client, batchId, {
        actor: created_by,
        approved: true,
        approvalTimestamp: inserted.rows?.[0]?.created_at ?? null,
      });
    }

    const codes = [];
    const serials = [];
    for (let s = startSerial; s <= endSerial; s += 1) {
      serials.push(s);
      codes.push(buildTrayCode(normalizedType, normalizedLetter, s));
    }

    const insertRows = await client.query(
      `INSERT INTO ${T.TRAY_MASTER}
        (code, type, ${trayLetterDbColumn}, serial_number, batch_id, status, updated_by, updated_at)
       SELECT
        pair.code,
        $1::text,
        $2::text,
        pair.serial,
        $3::int,
        'active',
        NULL::text,
        NULL::timestamp
       FROM unnest($4::text[], $5::int[]) AS pair(code, serial)
       RETURNING *`,
      [normalizedType, normalizedLetter, batchUid, codes, serials],
    );

    return {
      batch: {
        batch_id: batchId,
        type: normalizedType,
        letter: normalizedLetter,
        class: normalizedLetter,
        b_type: normalizedBType,
        start_serial_number: startSerial,
        end_serial_number: endSerial,
        start_code: startCode,
        end_code: endCode,
        quantity: qty,
        remark: note,
      },
      trays: (insertRows.rows || []).map((row) => ({ ...row, batch_id: batchId })),
    };
  });
}

/** Next serials + codes (not persisted) — production bin batch form preview. */
export async function previewTrayBatchCodes({ type, quantity, letter = null, category = null, class: trayClass = null }) {
  await ensureTrayLetterSchema();
  const normalizedType = normalizeTrayType(type);
  const normalizedLetter = normalizeTrayLetter(letter ?? category ?? trayClass);
  const qty = Math.trunc(Number(quantity) || 0);
  if (!normalizedType || !Number.isFinite(qty) || qty <= 0) {
    return { batch_id: null, start_code: null, end_code: null, quantity: 0, bins: [] };
  }

  const letterCol = trayLetterDbColumn;
  const maxRows = await dbQuery(
    normalizedLetter
      ? `SELECT COALESCE(MAX(serial_number::int), 0)::int AS max_serial
         FROM ${T.TRAY_MASTER}
         WHERE UPPER(TRIM(COALESCE(type, ''))) = $1
           AND UPPER(BTRIM(COALESCE(${letterCol}, ''))) = $2`
      : `SELECT COALESCE(MAX(serial_number::int), 0)::int AS max_serial
         FROM ${T.TRAY_MASTER}
         WHERE UPPER(TRIM(COALESCE(type, ''))) = $1
           AND (${letterCol} IS NULL OR BTRIM(${letterCol}) = '')`,
    normalizedLetter ? [normalizedType, normalizedLetter] : [normalizedType],
  );
  const startSerial = Number(maxRows?.[0]?.max_serial || 0) + 1;
  const endSerial = startSerial + qty - 1;
  const startCode = buildTrayCode(normalizedType, normalizedLetter, startSerial);
  const endCode = buildTrayCode(normalizedType, normalizedLetter, endSerial);
  const batchId = batchIdFromCodes(startCode, endCode);
  const bins = [];
  for (let s = startSerial; s <= endSerial; s += 1) {
    bins.push({ code: buildTrayCode(normalizedType, normalizedLetter, s), serial_number: s });
  }

  return {
    batch_id: batchId,
    letter: normalizedLetter,
    class: normalizedLetter,
    start_code: startCode,
    end_code: endCode,
    quantity: qty,
    bins,
  };
}

export async function deleteTraysByIds(ids, actor = null) {
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  if (!idList.length) throw new Error("Select at least one tray.");

  return withTransaction(async (client) => {
    await assertTraysNotInUse(client, { ids: idList, action: "delete" });

    const { rows: existing } = await client.query(
      `SELECT t.id, t.batch_id AS batch_uid, t.code, tb.batch_id AS batch_code
       FROM ${T.TRAY_MASTER} t
       ${BATCH_JOIN}
       WHERE t.id = ANY($1::int[])`,
      [idList],
    );
    if (!existing.length) return { updated: 0, ids: [] };

    await client.query(`DELETE FROM ${T.TRAY_MASTER} WHERE id = ANY($1::int[])`, [idList]);

    const batches = new Map();
    for (const row of existing) {
      const uid = Number(row.batch_uid);
      const bid = String(row.batch_code || "").trim();
      if (!uid || !bid || batches.has(uid)) continue;
      batches.set(uid, bid);
    }
    for (const [uid, bid] of batches) {
      await applyBatchUpdated(client, bid, actor);
      const { rows: remaining } = await client.query(
        `SELECT 1 FROM ${T.TRAY_MASTER} WHERE batch_id = $1 LIMIT 1`,
        [uid],
      );
      if (!remaining.length) {
        await client.query(
          `UPDATE ${T.TRAY_BATCH}
           SET is_deleted = true, deleted_by = $2, deleted_at = NOW(), updated_by = $2, updated_at = NOW()
           WHERE batch_id = $1
             AND COALESCE(is_deleted, false) = false`,
          [bid, actor ?? null],
        );
      }
    }

    return { updated: existing.length, ids: existing.map((row) => row.id) };
  });
}

export async function deleteTrayById(id, actor = null) {
  const result = await deleteTraysByIds([id], actor);
  return result.updated ? { id: result.ids[0] } : null;
}

export async function updateTrayApprovalById(id, approved, actor = null) {
  const trayId = Number(id);
  if (!Number.isInteger(trayId) || trayId <= 0) return null;
  const boolApproved = Boolean(approved);

  return withTransaction(async (client) => {
    const { rows: trays } = await client.query(
      `SELECT t.id, tb.batch_id
       FROM ${T.TRAY_MASTER} t
       ${BATCH_JOIN}
       WHERE t.id = $1
       LIMIT 1`,
      [trayId],
    );
    const tray = trays?.[0];
    if (!tray) return null;

    const bid = String(tray.batch_id || "").trim();
    if (!bid) return null;

    await client.query(
      `UPDATE ${T.TRAY_BATCH}
       SET approved = $2::boolean,
           approved_by = CASE WHEN $2::boolean THEN $3::text ELSE NULL END,
           approved_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
       WHERE batch_id = $1::text
         AND COALESCE(is_deleted, false) = false`,
      [bid, boolApproved, actor],
    );

    const { rows } = await client.query(
      `SELECT ${buildDefaultFields().join(", ")}
       ${fromSql()}
       WHERE t.id = $1
       LIMIT 1`,
      [trayId],
    );
    return rows?.[0] ?? null;
  });
}

async function applyBatchApproval(client, batchId, { actor, approved, approvalTimestamp = null } = {}) {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  if (approved === true) {
    await client.query(
      `UPDATE ${T.TRAY_BATCH}
       SET approved = true,
           approved_by = $2,
           approved_at = COALESCE($3::timestamp, NOW())
       WHERE batch_id = $1
         AND COALESCE(is_deleted, false) = false`,
      [bid, actor ?? null, approvalTimestamp],
    );
    return;
  }
  if (approved === false) {
    await client.query(
      `UPDATE ${T.TRAY_BATCH}
       SET approved = false,
           approved_by = NULL,
           approved_at = NULL
       WHERE batch_id = $1
         AND COALESCE(is_deleted, false) = false`,
      [bid],
    );
  }
}

async function applyBatchUpdated(client, batchId, actor) {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  await client.query(
    `UPDATE ${T.TRAY_BATCH}
     SET updated_by = $2, updated_at = NOW()
     WHERE batch_id = $1
       AND COALESCE(is_deleted, false) = false`,
    [bid, actor ?? null],
  );
}

async function applyBatchRemark(client, batchId, remark, actor = null, { stampUpdated = false } = {}) {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  const text = String(remark ?? "").trim() || null;
  if (stampUpdated) {
    await client.query(
      `UPDATE ${T.TRAY_BATCH}
       SET remark = $2::text, updated_by = $3::text, updated_at = NOW()
       WHERE batch_id = $1::text
         AND COALESCE(is_deleted, false) = false`,
      [bid, text, actor ?? null],
    );
    return;
  }
  await client.query(
    `UPDATE ${T.TRAY_BATCH}
     SET remark = $2::text
     WHERE batch_id = $1::text
       AND COALESCE(is_deleted, false) = false`,
    [bid, text],
  );
}

async function getMaxSerial(client, type, letter = null) {
  await ensureTrayLetterSchema();
  const normalizedType = normalizeTrayType(type);
  const normalizedLetter = normalizeTrayLetter(letter);
  const letterCol = trayLetterDbColumn;
  const { rows } = await client.query(
    normalizedLetter
      ? `SELECT COALESCE(MAX(serial_number::int), 0)::int AS max_serial
         FROM ${T.TRAY_MASTER}
         WHERE UPPER(TRIM(COALESCE(type, ''))) = $1
           AND UPPER(BTRIM(COALESCE(${letterCol}, ''))) = $2`
      : `SELECT COALESCE(MAX(serial_number::int), 0)::int AS max_serial
         FROM ${T.TRAY_MASTER}
         WHERE UPPER(TRIM(COALESCE(type, ''))) = $1
           AND (${letterCol} IS NULL OR BTRIM(${letterCol}) = '')`,
    normalizedLetter ? [normalizedType, normalizedLetter] : [normalizedType],
  );
  return Number(rows?.[0]?.max_serial || 0);
}

async function resolveBatchUid(client, batchId) {
  const bid = String(batchId || "").trim();
  if (!bid) return null;
  const { rows } = await client.query(
    `SELECT id FROM ${T.TRAY_BATCH}
     WHERE batch_id = $1
       AND COALESCE(is_deleted, false) = false
     LIMIT 1`,
    [bid],
  );
  const uid = Number(rows?.[0]?.id);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

async function loadBatchTrays(client, batch_id, { activeOnly = true } = {}) {
  await ensureTrayLetterSchema();
  const batchUid = await resolveBatchUid(client, batch_id);
  if (!batchUid) return [];
  const extra = activeOnly ? `AND t.status = 'active'` : "";
  const { rows } = await client.query(
    `SELECT t.id, t.code, t.type, ${trayLetterSelectPair}, t.serial_number, t.status, t.box_uid, t.updated_by, t.updated_at,
            tb.batch_id, COALESCE(tb.approved, false) AS approved
     FROM ${T.TRAY_MASTER} t
     ${BATCH_JOIN}
     WHERE t.batch_id = $1
       ${extra}
     ORDER BY t.serial_number ASC`,
    [batchUid],
  );
  return rows;
}

async function getBatchApproved(client, batch_id) {
  const { rows } = await client.query(
    `SELECT COALESCE(approved, false) AS approved
     FROM ${T.TRAY_BATCH}
     WHERE batch_id = $1
       AND COALESCE(is_deleted, false) = false
     LIMIT 1`,
    [String(batch_id || "").trim()],
  );
  return rows?.[0]?.approved === true;
}

async function renameBatch(client, oldId, newId, actor = null) {
  const from = String(oldId || "").trim();
  const to = String(newId || "").trim();
  if (!from || !to || from === to) return to || from;
  await client.query(
    `UPDATE ${T.TRAY_BATCH}
     SET batch_id = $1,
         updated_by = $3::text,
         updated_at = NOW()
     WHERE batch_id = $2
       AND COALESCE(is_deleted, false) = false`,
    [to, from, actor ?? null],
  );
  return to;
}

function inUseBlockedMessage(action, rows) {
  const codes = [...new Set(rows.map((row) => row.code).filter(Boolean))].slice(0, 8).join(", ");
  const verb = action === "delete" ? "delete" : "deactivate";
  return `Cannot ${verb}. Tray ${codes || "selected"} is already in use.`;
}

async function assertTraysNotInUse(client, { ids, batchId, action }) {
  const params = [];
  const cond = ["t.box_uid IS NOT NULL"];
  if (ids?.length) {
    params.push(ids);
    cond.push(`t.id = ANY($${params.length}::int[])`);
  }
  if (batchId) {
    const batchUid = await resolveBatchUid(client, batchId);
    if (!batchUid) return;
    params.push(batchUid);
    cond.push(`t.batch_id = $${params.length}::int`);
  }
  if (!ids?.length && !batchId) return;
  const { rows } = await client.query(
    `SELECT t.code FROM ${T.TRAY_MASTER} t WHERE ${cond.join(" AND ")} LIMIT 8`,
    params,
  );
  if (rows.length) throw new Error(inUseBlockedMessage(action, rows));
}

function nextBatchId(type, trays) {
  if (!trays.length) return "";
  const startCode = String(trays[0]?.code || "").trim();
  const endCode = String(trays[trays.length - 1]?.code || "").trim();
  if (startCode && endCode) return batchIdFromCodes(startCode, endCode);
  const cat = normalizeTrayLetter(trays[0]?.letter ?? trays[0]?.class);
  const minSerial = Number(trays[0].serial_number);
  const maxSerial = Number(trays[trays.length - 1].serial_number);
  return batchIdFromCodes(buildTrayCode(type, cat, minSerial), buildTrayCode(type, cat, maxSerial));
}

async function assertBatchApproved(client, batchId) {
  const approved = await getBatchApproved(client, batchId);
  if (!approved) {
    throw new Error("Approve the batch first. Trays become active after authorization.");
  }
}

export async function updateTrayStatusById(id, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const status = normalizeTrayStatus(nextStatus);

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      `SELECT t.status, tb.batch_id AS batch_code
       FROM ${T.TRAY_MASTER} t
       ${BATCH_JOIN}
       WHERE t.id = $1
       LIMIT 1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) return null;
    if (normalizeTrayStatus(existing.status) === status) {
      const { rows: same } = await client.query(
        `SELECT ${buildDefaultFields().join(", ")} ${fromSql()} WHERE t.id = $1 LIMIT 1`,
        [id],
      );
      return same[0] ?? null;
    }
    const batchCode = String(existing.batch_code || "").trim();
    if (status === "active") {
      await assertBatchApproved(client, batchCode);
    } else {
      await assertTraysNotInUse(client, { ids: [Number(id)], action: "deactivate" });
    }

    await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET status = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, actor],
    );
    if (batchCode) await applyBatchUpdated(client, batchCode, actor);

    const { rows } = await client.query(
      `SELECT ${buildDefaultFields().join(", ")} ${fromSql()} WHERE t.id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  });
}

export async function updateTrayBatchStatus(batch_id, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const bid = String(batch_id || "").trim();
  if (!bid) throw new Error("Batch is required.");
  const status = normalizeTrayStatus(nextStatus);

  return withTransaction(async (client) => {
    const batchUid = await resolveBatchUid(client, bid);
    if (!batchUid) throw new Error("Batch not found.");

    if (status === "active") {
      await assertBatchApproved(client, bid);
    } else {
      await assertTraysNotInUse(client, { batchId: bid, action: "deactivate" });
    }
    let where = `batch_id = $1`;
    if (status === "active") where += ` AND status IN ${TRAY_HELD_SQL}`;
    else where += ` AND status = 'active'`;

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET status = $2, updated_by = $3, updated_at = NOW()
       WHERE ${where}
       RETURNING id, batch_id`,
      [batchUid, status, actor],
    );

    await applyBatchUpdated(client, bid, actor);

    return {
      updated: rows.length,
      ids: rows.map((row) => row.id),
      batch_id: bid,
      status,
    };
  });
}

export async function updateTrayStatusByIds(ids, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const status = normalizeTrayStatus(nextStatus);
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  if (!idList.length) throw new Error("Select at least one tray.");

  return withTransaction(async (client) => {
    if (status === "active") {
      const { rows: batchRows } = await client.query(
        `SELECT DISTINCT tb.batch_id
         FROM ${T.TRAY_MASTER} t
         ${BATCH_JOIN}
         WHERE t.id = ANY($1::int[])`,
        [idList],
      );
      for (const row of batchRows) {
        await assertBatchApproved(client, row.batch_id);
      }
    } else {
      await assertTraysNotInUse(client, { ids: idList, action: "deactivate" });
    }
    let where = `id = ANY($1::int[])`;
    if (status === "active") where += ` AND status IN ${TRAY_HELD_SQL}`;
    else where += ` AND status = 'active'`;

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET status = $2, updated_by = $3, updated_at = NOW()
       WHERE ${where}
       RETURNING id, batch_id`,
      [idList, status, actor],
    );

    const { rows: batchRows } = await client.query(
      `SELECT DISTINCT tb.batch_id
       FROM ${T.TRAY_MASTER} t
       ${BATCH_JOIN}
       WHERE t.id = ANY($1::int[])`,
      [rows.map((row) => row.id)],
    );
    const batchIds = [...new Set(batchRows.map((row) => String(row.batch_id || "").trim()).filter(Boolean))];
    for (const nextBid of batchIds) {
      await applyBatchUpdated(client, nextBid, actor);
    }

    return {
      updated: rows.length,
      ids: rows.map((row) => row.id),
      status,
    };
  });
}

export async function updateTrayBatch({
  batch_id,
  type: nextType,
  b_type: nextBType,
  class: nextClass,
  kind: nextKind,
  variant: nextVariant,
  subtype: nextSubtype,
  material_type: nextMaterialType,
  material: nextMaterial,
  quantity,
  approved,
  actor = null,
  remark = null,
}) {
  const bid = String(batch_id || "").trim();
  if (!bid) throw new Error("Batch is required.");

  return withTransaction(async (client) => {
    let trays = await loadBatchTrays(client, bid);
    if (!trays.length) throw new Error("Batch not found");

    let type = trays[0].type;
    let changed = false;
    let nextBatchId = bid;
    const wasApproved = await getBatchApproved(client, bid);
    const incomingApproved = approved === undefined || approved === null ? undefined : Boolean(approved);

    const normalizedNextType = nextType ? normalizeTrayType(nextType) : null;
    const typeChanging = Boolean(normalizedNextType && normalizedNextType !== normalizeTrayType(type));
    let qtyChanging = false;
    if (quantity !== undefined && quantity !== null) {
      const qty = Math.trunc(Number(quantity));
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("Enter a whole number greater than 0.");
      qtyChanging = qty !== trays.length;
    }
    const businessChanged = typeChanging || qtyChanging;

    if (businessChanged && wasApproved) {
      await applyBatchApproval(client, bid, { actor, approved: false });
    }

    const batchLetter = normalizeTrayLetter(trays[0]?.letter ?? trays[0]?.class);

    if (typeChanging) {
      changed = true;
      await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);
      let nextSerial = (await getMaxSerial(client, normalizedNextType, batchLetter)) + 1;
      for (const row of trays) {
        const code = buildTrayCode(normalizedNextType, batchLetter, nextSerial);
        await client.query(
          `UPDATE ${T.TRAY_MASTER}
           SET type = $1::text,
               letter = $2::text,
               serial_number = $3::int,
               code = $4::text,
               updated_by = $5::text,
               updated_at = NOW()
           WHERE id = $6::int`,
          [normalizedNextType, batchLetter, nextSerial, code, actor, row.id],
        );
        nextSerial += 1;
      }
      type = normalizedNextType;
      trays = await loadBatchTrays(client, bid);
      nextBatchId = await renameBatch(client, bid, nextBatchIdFromType(type, trays), actor);
      trays = await loadBatchTrays(client, nextBatchId);
    }

    if (quantity !== undefined && quantity !== null) {
      const qty = Math.trunc(Number(quantity));
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("Enter a whole number greater than 0.");
      const current = trays.length;

      if (qty !== current) {
        changed = true;
        if (qty > current) {
          await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);
          const startSerial = (await getMaxSerial(client, type, batchLetter)) + 1;
          const endSerial = startSerial + (qty - current) - 1;
          const batchUid = await resolveBatchUid(client, nextBatchId);
          if (!batchUid) throw new Error("Batch not found.");
          const codes = [];
          const serials = [];
          for (let s = startSerial; s <= endSerial; s += 1) {
            serials.push(s);
            codes.push(buildTrayCode(type, batchLetter, s));
          }
          await client.query(
            `INSERT INTO ${T.TRAY_MASTER}
              (code, type, ${trayLetterDbColumn}, serial_number, batch_id, status, updated_by, updated_at)
             SELECT
              pair.code,
              $1::text,
              $2::text,
              pair.serial,
              $3::int,
              'active',
              NULL::text,
              NULL::timestamp
             FROM unnest($4::text[], $5::int[]) AS pair(code, serial)`,
            [type, batchLetter, batchUid, codes, serials],
          );
        } else {
          const removeIds = trays.slice(qty).map((row) => row.id);
          await assertTraysNotInUse(client, { ids: removeIds, action: "deactivate" });
          await client.query(
            `UPDATE ${T.TRAY_MASTER}
             SET status = 'inactive', updated_by = $2, updated_at = NOW()
             WHERE id = ANY($1::int[])`,
            [removeIds, actor],
          );
        }

        trays = await loadBatchTrays(client, nextBatchId);
        nextBatchId = await renameBatch(client, nextBatchId, nextBatchIdFromType(type, trays), actor);
      }
    }

    const targetBatchId = nextBatchId || bid;

    if (businessChanged) {
      await applyBatchUpdated(client, targetBatchId, actor);
      changed = true;
    }

    if (incomingApproved === true && (!wasApproved || businessChanged)) {
      await applyBatchApproval(client, targetBatchId, { actor, approved: true });
      changed = true;
    } else if (incomingApproved === false && wasApproved) {
      await applyBatchApproval(client, targetBatchId, { actor, approved: false });
      changed = true;
    }

    if (remark !== undefined && remark !== null) {
      await applyBatchRemark(client, targetBatchId, remark, actor, { stampUpdated: !businessChanged });
      changed = true;
    }

    const bTypeRaw = nextBType ?? nextClass ?? nextKind ?? nextVariant ?? nextSubtype ?? nextMaterialType ?? nextMaterial;
    if (bTypeRaw !== undefined && bTypeRaw !== null && String(bTypeRaw).trim() !== "") {
      const normalizedBType = normalizeTrayType(bTypeRaw);
      await client.query(
        `UPDATE ${T.TRAY_BATCH} SET b_type = $1::text WHERE batch_id = $2::text`,
        [normalizedBType, targetBatchId],
      );
      changed = true;
    }

    trays = await loadBatchTrays(client, targetBatchId);
    const finalBatchId = nextBatchId || bid;

    return {
      changed,
      batch_id: finalBatchId,
      quantity: trays.length,
      type,
      start_serial_number: trays[0]?.serial_number ?? null,
      end_serial_number: trays[trays.length - 1]?.serial_number ?? null,
      start_code: trays[0]?.code ?? null,
      end_code: trays[trays.length - 1]?.code ?? null,
      ids: trays.map((row) => row.id),
    };
  });
}

function nextBatchIdFromType(type, trays) {
  return nextBatchId(type, trays);
}

export async function deleteTrayBatch(batch_id, actor = null) {
  const bid = String(batch_id || "").trim();
  return withTransaction(async (client) => {
  const batchUid = await resolveBatchUid(client, bid);
  if (!batchUid) throw new Error("Batch not found.");

  await assertTraysNotInUse(client, { batchId: bid, action: "delete" });
  const { rows } = await client.query(
    `UPDATE ${T.TRAY_MASTER}
     SET status = 'inactive', updated_by = $2, updated_at = NOW()
     WHERE batch_id = $1 AND status = 'active'
     RETURNING id`,
    [batchUid, actor],
  );
  await client.query(
    `UPDATE ${T.TRAY_BATCH}
     SET is_deleted = true,
         deleted_by = $2,
         deleted_at = NOW(),
         updated_by = $2,
         updated_at = NOW()
     WHERE batch_id = $1
       AND COALESCE(is_deleted, false) = false`,
    [bid, actor],
  );
  return { updated: rows.length, ids: rows.map((row) => row.id) };
  });
}

export async function findTrayBatches(options = {}) {
  await ensureTrayLetterSchema();
  const { filters = {}, search, sort = {}, page = 1, limit = 100, typeScope } = options;
  const values = [];
  let idx = 1;
  const conditions = ["COALESCE(b.is_deleted, false) = false"];
  pushTypeScope(conditions, typeScope, { batchAgg: true });

  if (filters?.type) {
    values.push(normalizeTrayType(filters.type));
    conditions.push(`UPPER(TRIM(COALESCE(agg.type, ''))) = $${idx++}`);
  }
  const bTypeFilter = filters?.b_type ?? filters?.kind ?? filters?.variant ?? filters?.subtype ?? filters?.material_type ?? filters?.material;
  if (bTypeFilter) {
    values.push(normalizeTrayType(bTypeFilter));
    conditions.push(`UPPER(TRIM(COALESCE(b.b_type, ''))) = $${idx++}`);
  }
  const codeClassFilter = filters?.letter ?? filters?.category ?? filters?.class;
  if (codeClassFilter) {
    const letter = normalizeTrayLetter(codeClassFilter);
    if (letter) {
      values.push(letter);
      conditions.push(`UPPER(BTRIM(COALESCE(agg.code_letter, ''))) = $${idx++}`);
    }
  }
  if (filters?.status && filters.status !== "all") {
    const raw = String(filters.status).trim().toLowerCase();
    if (raw === "inactive") {
      conditions.push(`COALESCE(agg.active_count, 0) = 0`);
    } else if (raw === "active" || raw === "not_deleted") {
      conditions.push(`COALESCE(agg.active_count, 0) > 0`);
    }
  }

  if (filters?.approved !== undefined && filters?.approved !== null && filters?.approved !== "all") {
    values.push(coerceApproved(filters.approved));
    conditions.push(`b.approved = $${idx++}::boolean`);
  }
  if (filters?.batch_id && filters.batch_id !== "all") {
    values.push(String(filters.batch_id).trim());
    conditions.push(`b.batch_id = $${idx++}`);
  }

  if (search) {
    const sidx = idx++;
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      b.batch_id ILIKE $${sidx}::text
      OR agg.type ILIKE $${sidx}::text
      OR (COALESCE(agg.type, '') || COALESCE(agg.start_serial::text, '')) ILIKE $${sidx}::text
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const aggJoin = `
    LEFT JOIN LATERAL (
      SELECT
        MIN(t.type) AS type,
        MIN(t.serial_number)::int AS start_serial,
        MAX(t.serial_number)::int AS end_serial,
        (SELECT t2.code FROM ${T.TRAY_MASTER} t2 WHERE t2.batch_id = b.id ORDER BY t2.serial_number ASC, t2.id ASC LIMIT 1) AS start_code,
        (SELECT t2.code FROM ${T.TRAY_MASTER} t2 WHERE t2.batch_id = b.id ORDER BY t2.serial_number DESC, t2.id DESC LIMIT 1) AS end_code,
        COUNT(*) FILTER (WHERE t.status = 'active')::int AS active_count,
        COUNT(*) FILTER (WHERE t.status = 'inactive')::int AS inactive_count,
        COUNT(*) FILTER (WHERE t.box_uid IS NOT NULL)::int AS in_use_count,
        COUNT(*)::int AS tray_count,
        MIN(NULLIF(BTRIM(${trayLetterRawExpr}::text), '')) AS code_letter
      FROM ${T.TRAY_MASTER} t
      WHERE t.batch_id = b.id
    ) agg ON true`;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM ${T.TRAY_BATCH} b ${aggJoin} ${where}`,
    values,
  );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const sortBy = String(sort.by || "created_at");
  const order = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const orderExpr = sortBy === "batch_id" ? "b.batch_id" : sortBy === "type" ? "agg.type" : "b.created_at";

  const rows = await dbQuery(
    `SELECT
      b.batch_id,
      agg.type,
      agg.start_serial AS start_serial_number,
      agg.end_serial AS end_serial_number,
      agg.start_code,
      agg.end_code,
      COALESCE(agg.tray_count, 0)::int AS tray_count,
      CASE WHEN COALESCE(b.approved, false) THEN COALESCE(agg.active_count, 0) ELSE 0 END::int AS active_count,
      COALESCE(agg.inactive_count, 0)::int AS inactive_count,
      COALESCE(agg.in_use_count, 0)::int AS in_use_count,
      0::int AS deleted_count,
      CASE WHEN COALESCE(b.approved, false) THEN COALESCE(agg.tray_count, 0) ELSE 0 END::int AS approved_count,
      CASE WHEN COALESCE(b.approved, false) THEN 0 ELSE COALESCE(agg.tray_count, 0) END::int AS pending_count,
      b.created_at,
      b.created_by AS created_by_name,
      b.updated_at,
      b.updated_by AS updated_by_name,
      b.approved,
      b.approved_at,
      b.approved_by AS approved_by_name,
      b.remark,
      b.b_type,
      agg.code_letter AS letter,
      agg.code_letter AS class,
      CASE
        WHEN NOT COALESCE(b.approved, false) THEN 'pending'
        WHEN COALESCE(agg.active_count, 0) > 0 THEN 'active'
        ELSE 'inactive'
      END AS status
    FROM ${T.TRAY_BATCH} b
    ${aggJoin}
    ${where}
    ORDER BY ${orderExpr} ${order}
    LIMIT $${values.length + 1}::int OFFSET $${values.length + 2}::int`,
    [...values, safeLimit, offset],
  );

  return {
    data: rows,
    total: Number(count || 0),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count || 0) / safeLimit),
  };
}

export async function updateTrayWeight(id, weight, actor = null) {
  await ensureTrayLetterSchema();
  const trayId = Number(id);
  if (!Number.isInteger(trayId) || trayId <= 0) return null;
  const w =
    weight === null || weight === undefined || String(weight).trim() === ""
      ? null
      : Number(weight);
  if (w !== null && (!Number.isFinite(w) || w < 0)) {
    throw new Error("Weight must be a non-negative number.");
  }
  await dbQuery(
    `UPDATE ${T.TRAY_MASTER} SET weight = $2, updated_by = $3, updated_at = NOW() WHERE id = $1`,
    [trayId, w, actor],
  );
  const [row] = await dbQuery(
    `SELECT ${buildDefaultFields().join(", ")} ${fromSql([], false)} WHERE t.id = $1 LIMIT 1`,
    [trayId],
  );
  return row ?? null;
}

export async function updateTrayWeightsBulk(updates = [], actor = null) {
  const list = (Array.isArray(updates) ? updates : []).filter((u) => Number(u?.id) > 0);
  if (!list.length) throw new Error("Select at least one row.");
  return withTransaction(async (client) => {
    for (const u of list) {
      const trayId = Number(u.id);
      const w =
        u.weight === null || u.weight === undefined || String(u.weight).trim() === ""
          ? null
          : Number(u.weight);
      if (w !== null && (!Number.isFinite(w) || w < 0)) {
        throw new Error("Weight must be a non-negative number.");
      }
      await client.query(
        `UPDATE ${T.TRAY_MASTER} SET weight = $2, updated_by = $3, updated_at = NOW() WHERE id = $1`,
        [trayId, w, actor],
      );
    }
    return { updated: list.length, ids: list.map((u) => Number(u.id)) };
  });
}
