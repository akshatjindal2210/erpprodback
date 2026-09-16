import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { normalizeTrayType } from "../config/trayTypes.js";
import { isValidTrayStatus, normalizeTrayStatus, TRAY_HELD_SQL } from "../config/trayStatuses.js";
import { TRAY_OCC_JOIN, TRAY_POOL_EXPR } from "../lib/trayOccupancySql.js";

const ALLOWED_FILTER_FIELDS = ["id", "code", "type", "batch_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "code", "type", "serial_number", "batch_id", "created_at"];

const BATCH_JOIN = `LEFT JOIN ${T.TRAY_BATCH} tb ON tb.batch_id = t.batch_id`;
const APPROVED_EXPR = `COALESCE(tb.approved, false) AS approved`;
const NOT_DELETED_BATCH = `COALESCE(tb.is_deleted, false) = false`;

const DEFAULT_FIELDS = ["t.id", "t.code", "t.type", "t.serial_number", "t.batch_id",
  APPROVED_EXPR,
  "tb.approved_by", "tb.approved_at", "t.status",
  `${TRAY_POOL_EXPR} AS pool_status`,
  "tb.remark",
  "tb.created_at AS created_at", "tb.created_by AS created_by", 
  "t.updated_by", "t.updated_at",
  "tb.created_by AS created_by_name", "t.updated_by AS updated_by_name", "tb.approved_by AS approved_by_name",
];

export const TRAY_DEFAULT_FIELDS = DEFAULT_FIELDS;

function selectFields(fields = []) {
  if (!fields.length) return DEFAULT_FIELDS.join(", ");
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

export async function findTrays(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;

  const values = [];
  let i = 1;
  const conditions = [NOT_DELETED_BATCH];
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

    if (key === "code" || key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`t.${key} = $${i++}::text`);
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
      OR t.batch_id ILIKE $${idx}::text
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
  const { fields = [] } = options;
  const values = [];
  let i = 1;
  const conditions = [NOT_DELETED_BATCH];
  let statusFilter = "all";

  for (const [key, val] of Object.entries(filters || {})) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${i++}::text`);
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

    if (key === "code" || key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`t.${key} = $${i++}::text`);
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

export async function createTrayBatch({ type, quantity, created_by, approved = false, remark = null }) {
  const normalizedType = normalizeTrayType(type);
  const qty = Math.trunc(Number(quantity) || 0);
  const note = String(remark ?? "").trim() || null;

  if (!normalizedType) throw new Error("Tray type is required.");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Enter a number greater than 0.");

  return withTransaction(async (client) => {
    await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);

    const maxSerial = await getMaxSerialForType(client, normalizedType);
    const startSerial = maxSerial + 1;
    const endSerial = startSerial + qty - 1;
    const batchId = `${normalizedType}${startSerial}-${endSerial}`;
    const startCode = `${normalizedType}${startSerial}`;
    const endCode = `${normalizedType}${endSerial}`;

    const inserted = await client.query(
      `INSERT INTO ${T.TRAY_BATCH} (batch_id, remark, approved, created_by, created_at)
       VALUES ($1::text, $2::text, false, $3::text, NOW())
       RETURNING created_at`,
      [batchId, note, created_by ?? null],
    );

    if (approved) {
      await applyBatchApproval(client, batchId, {
        actor: created_by,
        approved: true,
        approvalTimestamp: inserted.rows?.[0]?.created_at ?? null,
      });
    }

    const insertRows = await client.query(
      `INSERT INTO ${T.TRAY_MASTER}
        (code, type, serial_number, batch_id, status, updated_by, updated_at)
       SELECT
        ($1::text || gs::text) AS code,
        $1::text AS type,
        gs AS serial_number,
        $2::text AS batch_id,
        'active' AS status,
        NULL::text AS updated_by,
        NULL::timestamp AS updated_at
       FROM generate_series($3::int, $4::int) AS gs
       RETURNING *`,
      [normalizedType, batchId, startSerial, endSerial],
    );

    return {
      batch: {
        batch_id: batchId,
        type: normalizedType,
        start_serial_number: startSerial,
        end_serial_number: endSerial,
        start_code: startCode,
        end_code: endCode,
        quantity: qty,
        remark: note,
      },
      trays: insertRows.rows || [],
    };
  });
}

export async function deleteTraysByIds(ids, actor = null) {
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  if (!idList.length) throw new Error("Select at least one tray.");

  return withTransaction(async (client) => {
    await assertTraysNotInUse(client, { ids: idList, action: "delete" });

    const { rows: existing } = await client.query(
      `SELECT id, batch_id, code FROM ${T.TRAY_MASTER} WHERE id = ANY($1::int[])`,
      [idList],
    );
    if (!existing.length) return { updated: 0, ids: [] };

    await client.query(`DELETE FROM ${T.TRAY_MASTER} WHERE id = ANY($1::int[])`, [idList]);

    const batchIds = [...new Set(existing.map((row) => String(row.batch_id || "").trim()).filter(Boolean))];
    for (const bid of batchIds) {
      await applyBatchUpdated(client, bid, actor);
      const { rows: remaining } = await client.query(
        `SELECT 1 FROM ${T.TRAY_MASTER} WHERE batch_id = $1 LIMIT 1`,
        [bid],
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
      `SELECT id, batch_id
       FROM ${T.TRAY_MASTER}
       WHERE id = $1
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
      `SELECT ${DEFAULT_FIELDS.join(", ")}
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

async function getMaxSerialForType(client, type) {
  const normalizedType = normalizeTrayType(type);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(serial_number), 0)::int AS max_serial
     FROM ${T.TRAY_MASTER}
     WHERE UPPER(TRIM(COALESCE(type, ''))) = $1`,
    [normalizedType],
  );
  return Number(rows?.[0]?.max_serial || 0);
}

async function loadBatchTrays(client, batch_id, { activeOnly = true } = {}) {
  const bid = String(batch_id || "").trim();
  const extra = activeOnly ? `AND t.status = 'active'` : "";
  const { rows } = await client.query(
    `SELECT t.*, COALESCE(tb.approved, false) AS approved
     FROM ${T.TRAY_MASTER} t
     ${BATCH_JOIN}
     WHERE t.batch_id = $1
       ${extra}
     ORDER BY t.serial_number ASC`,
    [bid],
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
    `UPDATE ${T.TRAY_MASTER}
     SET batch_id = $1
     WHERE batch_id = $2`,
    [to, from],
  );
  await client.query(
    `UPDATE ${T.TRAY_BATCH}
     SET batch_id = $1
     WHERE batch_id = $2`,
    [to, from],
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
    params.push(String(batchId).trim());
    cond.push(`t.batch_id = $${params.length}`);
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
  const minSerial = Number(trays[0].serial_number);
  const maxSerial = Number(trays[trays.length - 1].serial_number);
  return `${type}${minSerial}-${maxSerial}`;
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
      `SELECT * FROM ${T.TRAY_MASTER} WHERE id = $1 LIMIT 1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) return null;
    if (normalizeTrayStatus(existing.status) === status) return existing;
    if (status === "active") {
      await assertBatchApproved(client, existing.batch_id);
    } else {
      await assertTraysNotInUse(client, { ids: [Number(id)], action: "deactivate" });
    }

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET status = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, actor],
    );
    const row = rows[0] ?? null;
    if (row?.batch_id) {
      await applyBatchUpdated(client, row.batch_id, actor);
    }
    return row;
  });
}

export async function updateTrayBatchStatus(batch_id, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const bid = String(batch_id || "").trim();
  if (!bid) throw new Error("Batch is required.");
  const status = normalizeTrayStatus(nextStatus);

  return withTransaction(async (client) => {
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
      [bid, status, actor],
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
        `SELECT DISTINCT batch_id FROM ${T.TRAY_MASTER} WHERE id = ANY($1::int[])`,
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

    const batchIds = [...new Set(rows.map((row) => String(row.batch_id || "").trim()).filter(Boolean))];
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

export async function updateTrayBatch({ batch_id, type: nextType, quantity, approved, actor = null, remark = null }) {
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

    if (typeChanging) {
      changed = true;
      await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);
      let nextSerial = (await getMaxSerialForType(client, normalizedNextType)) + 1;
      for (const row of trays) {
        await client.query(
          `UPDATE ${T.TRAY_MASTER}
           SET type = $1::text,
               serial_number = $2::int,
               code = ($1::text || $2::int::text),
               updated_by = $3::text,
               updated_at = NOW()
           WHERE id = $4::int`,
          [normalizedNextType, nextSerial, actor, row.id],
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
          const startSerial = (await getMaxSerialForType(client, type)) + 1;
          const endSerial = startSerial + (qty - current) - 1;
          await client.query(
            `INSERT INTO ${T.TRAY_MASTER}
              (code, type, serial_number, batch_id, status, updated_by, updated_at)
             SELECT
              ($1::text || gs::text),
              $1::text,
              gs,
              $2::text,
              'active',
              NULL::text,
              NULL::timestamp
             FROM generate_series($3::int, $4::int) AS gs`,
            [type, nextBatchId, startSerial, endSerial],
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
  await assertTraysNotInUse(client, { batchId: bid, action: "delete" });
  const { rows } = await client.query(
    `UPDATE ${T.TRAY_MASTER}
     SET status = 'inactive', updated_by = $2, updated_at = NOW()
     WHERE batch_id = $1 AND status = 'active'
     RETURNING id`,
    [bid, actor],
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
  const { filters = {}, search, sort = {}, page = 1, limit = 100 } = options;
  const values = [];
  let idx = 1;
  const conditions = ["COALESCE(b.is_deleted, false) = false"];

  if (filters?.type) {
    values.push(normalizeTrayType(filters.type));
    conditions.push(`UPPER(TRIM(COALESCE(agg.type, ''))) = $${idx++}`);
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
        COUNT(*) FILTER (WHERE t.status = 'active')::int AS active_count,
        COUNT(*) FILTER (WHERE t.status = 'inactive')::int AS inactive_count,
        COUNT(*) FILTER (WHERE t.box_uid IS NOT NULL)::int AS in_use_count,
        COUNT(*)::int AS tray_count
      FROM ${T.TRAY_MASTER} t
      WHERE t.batch_id = b.batch_id
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
      CONCAT(agg.type, agg.start_serial::text) AS start_code,
      CONCAT(agg.type, agg.end_serial::text) AS end_code,
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
