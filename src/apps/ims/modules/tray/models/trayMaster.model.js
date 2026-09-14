import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { normalizeTrayType } from "../config/trayTypes.js";
import { isValidTrayStatus, normalizeTrayStatus, TRAY_HELD_SQL } from "../config/trayStatuses.js";

const ALLOWED_FILTER_FIELDS = ["id", "code", "type", "batch_id", "status", "approved", "from_date", "to_date"];
const ALLOWED_SORT_FIELDS = ["id", "code", "type", "serial_number", "batch_id", "created_at"];

/** Audit cols store user name snapshot (not live user id). */
const DEFAULT_FIELDS = [
  "t.id",
  "t.code",
  "t.type",
  "t.serial_number",
  "t.batch_id",
  "t.approved",
  "t.approved_by",
  "t.approved_at",
  "t.status",
  "t.remark",
  "t.created_by",
  "t.created_at",
  "t.updated_by",
  "t.updated_at",
  "t.deleted_by",
  "t.deleted_at",
  "t.created_by AS created_by_name",
  "t.updated_by AS updated_by_name",
  "t.approved_by AS approved_by_name",
  "t.deleted_by AS deleted_by_name",
];

export const TRAY_DEFAULT_FIELDS = DEFAULT_FIELDS;

function pushStatusCondition(conditions, values, statusFilter, paramIndex) {
  let i = paramIndex;
  const raw = String(statusFilter || "").trim().toLowerCase();
  if (!raw || raw === "all") return i;
  if (raw === "not_deleted") {
    conditions.push(`TRIM(COALESCE(t.status, '')) <> 'deleted'`);
    return i;
  }
  const normalized = normalizeTrayStatus(statusFilter);
  if (normalized === "inactive") {
    conditions.push(`TRIM(COALESCE(t.status, '')) IN ${TRAY_HELD_SQL}`);
    return i;
  }
  values.push(normalized);
  conditions.push(`TRIM(COALESCE(t.status, '')) = $${i++}`);
  return i;
}

function coerceApproved(val) {
  return val === true || String(val).toLowerCase() === "true";
}

export async function findTrays(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [] } = options;

  const values = [];
  let i = 1;
  const conditions = ["1=1"];
  // Default: hide soft-deleted (same idea as is_deleted = false elsewhere).
  let statusFilter = "active";

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "from_date") {
      values.push(val);
      conditions.push(`t.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`t.created_at <= $${i++}`);
      continue;
    }

    if (key === "type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${i++}`);
      continue;
    }

    if (key === "status") {
      const raw = String(val).trim().toLowerCase();
      statusFilter = raw === "all" ? "all" : String(val).trim();
      continue;
    }

    if (key === "code" || key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`TRIM(COALESCE(t.${key}, '')) = $${i++}`);
      continue;
    }

    if (key === "approved") {
      if (String(val).trim().toLowerCase() === "all") continue;
      values.push(coerceApproved(val));
      conditions.push(`t.approved = $${i++}`);
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
      t.code ILIKE $${idx}
      OR t.type ILIKE $${idx}
      OR t.batch_id ILIKE $${idx}
      OR t.serial_number::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM ${T.TRAY_MASTER} t ${where}`,
    values,
  );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "id";
  const sortOrder = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

  const rows = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${T.TRAY_MASTER} t
     ${where}
     ORDER BY t.${sortByField} ${sortOrder}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
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
  const conditions = ["1=1"];
  // Single-row lookup: include deleted so callers can detect "already deleted".
  let statusFilter = "all";

  for (const [key, val] of Object.entries(filters || {})) {
    if (val === undefined || val === null || val === "") continue;
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;

    if (key === "type") {
      values.push(normalizeTrayType(val));
      conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${i++}`);
      continue;
    }

    if (key === "status") {
      const raw = String(val).trim().toLowerCase();
      statusFilter = raw === "all" ? "all" : String(val).trim();
      continue;
    }

    if (key === "code" || key === "batch_id") {
      values.push(String(val).trim());
      conditions.push(`TRIM(COALESCE(t.${key}, '')) = $${i++}`);
      continue;
    }

    if (key === "approved") {
      if (String(val).trim().toLowerCase() === "all") continue;
      values.push(coerceApproved(val));
      conditions.push(`t.approved = $${i++}`);
      continue;
    }

    values.push(val);
    conditions.push(`t.${key} = $${i++}`);
  }

  i = pushStatusCondition(conditions, values, statusFilter, i);

  const [row] = await dbQuery(
    `SELECT ${fields.length ? fields.join(", ") : DEFAULT_FIELDS.join(", ")}
     FROM ${T.TRAY_MASTER} t
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    values,
  );
  return row ?? null;
}

export async function createTrayBatch({ type, quantity, created_by }) {
  const normalizedType = normalizeTrayType(type);
  const qty = Math.trunc(Number(quantity) || 0);

  if (!normalizedType) throw new Error("type required");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("quantity must be a positive number");

  return withTransaction(async (client) => {
    await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);

    const maxSerial = await getMaxSerialForType(client, normalizedType);
    const startSerial = maxSerial + 1;
    const endSerial = startSerial + qty - 1;
    const batchId = `${normalizedType}${startSerial}-${endSerial}`;
    const startCode = `${normalizedType}${startSerial}`;
    const endCode = `${normalizedType}${endSerial}`;

    const insertRows = await client.query(
      `INSERT INTO ${T.TRAY_MASTER}
        (code, type, serial_number, batch_id, approved, status, created_by)
       SELECT
        CONCAT($1::text, gs)::text AS code,
        $1::text AS type,
        gs AS serial_number,
        $2::text AS batch_id,
        false AS approved,
        'active' AS status,
        $3::text AS created_by
       FROM generate_series($4::int, $5::int) AS gs
       RETURNING *`,
      [normalizedType, batchId, created_by ?? null, startSerial, endSerial],
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
      },
      trays: insertRows.rows || [],
    };
  });
}

function normalizeTrayRemark(value, required = false) {
  const remark = String(value ?? "").trim();
  if (required && !remark) throw new Error("Remark is required");
  return remark || null;
}

function assertRemarkForStatus(status, remark) {
  const normalized = normalizeTrayStatus(status);
  if (normalized === "inactive" || normalized === "deleted") {
    return normalizeTrayRemark(remark, true);
  }
  return null;
}

export async function deleteTrayById(id, actor = null, remark = null) {
  const statusRemark = normalizeTrayRemark(remark, true);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET status = 'deleted',
           remark = $3,
           deleted_by = $2,
           deleted_at = NOW(),
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $1
         AND status <> 'deleted'
       RETURNING *`,
      [id, actor, statusRemark],
    );
    const row = rows[0] ?? null;
    if (!row) return null;

    // Keep batch_id range in sync with remaining active trays.
    const remaining = await loadActiveBatchTrays(client, row.batch_id);
    if (remaining.length) {
      await syncBatchIdForTrays(client, remaining, actor);
    }
    return row;
  });
}

export async function updateTrayApprovalById(id, approved, actor = null) {
  const [row] = await dbQuery(
    `UPDATE ${T.TRAY_MASTER}
     SET approved = $2,
         approved_by = CASE WHEN $2 = true THEN $3 ELSE NULL END,
         approved_at = CASE WHEN $2 = true THEN NOW() ELSE NULL END
     WHERE id = $1
       AND status <> 'deleted'
     RETURNING *`,
    [id, Boolean(approved), actor],
  );
  return row ?? null;
}

async function getMaxSerialForType(client, type) {
  const normalizedType = normalizeTrayType(type);
  // Include deleted rows — unique (type, serial_number) must never reuse serials.
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(serial_number), 0)::int AS max_serial
     FROM ${T.TRAY_MASTER}
     WHERE UPPER(TRIM(COALESCE(type, ''))) = $1`,
    [normalizedType],
  );
  return Number(rows?.[0]?.max_serial || 0);
}

async function loadActiveBatchTrays(client, batch_id) {
  const { rows } = await client.query(
    `SELECT *
     FROM ${T.TRAY_MASTER}
     WHERE TRIM(COALESCE(batch_id, '')) = $1
       AND TRIM(COALESCE(status, '')) <> 'deleted'
     ORDER BY serial_number ASC`,
    [String(batch_id || "").trim()],
  );
  return rows;
}

function buildStatusUpdateSql(nextStatus) {
  const status = normalizeTrayStatus(nextStatus);
  if (status === "active") {
    return {
      status,
      setSql: `status = $STATUS$, remark = NULL, deleted_by = NULL, deleted_at = NULL, updated_by = $ACTOR$, updated_at = NOW()`,
      needsRemark: false,
    };
  }
  if (status === "inactive") {
    return {
      status,
      setSql: `status = $STATUS$, remark = $REMARK$, deleted_by = NULL, deleted_at = NULL, updated_by = $ACTOR$, updated_at = NOW()`,
      needsRemark: true,
    };
  }
  return {
    status,
    setSql: `status = $STATUS$, remark = $REMARK$, deleted_by = $ACTOR$, deleted_at = NOW(), updated_by = $ACTOR$, updated_at = NOW()`,
    needsRemark: true,
  };
}

function bindStatusUpdate(meta, status, actor, remark) {
  const statusRemark = meta.needsRemark ? assertRemarkForStatus(status, remark) : null;
  if (meta.needsRemark) {
    return {
      setSql: meta.setSql.replace(/\$STATUS\$/g, "$2").replace(/\$REMARK\$/g, "$3").replace(/\$ACTOR\$/g, "$4"),
      params: [status, statusRemark, actor],
    };
  }
  return {
    setSql: meta.setSql.replace(/\$STATUS\$/g, "$2").replace(/\$ACTOR\$/g, "$3"),
    params: [status, actor],
  };
}

export async function updateTrayStatusById(id, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const meta = buildStatusUpdateSql(nextStatus);
  const { setSql, params } = bindStatusUpdate(meta, meta.status, actor, remark);

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      `SELECT * FROM ${T.TRAY_MASTER} WHERE id = $1 LIMIT 1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) return null;
    const current = normalizeTrayStatus(existing.status);
    if (current === meta.status) return existing;
    if (current === "deleted") throw new Error("Deleted tray cannot be changed");

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET ${setSql}
       WHERE id = $1
       RETURNING *`,
      [id, ...params],
    );
    const row = rows[0] ?? null;
    if (!row || meta.status !== "deleted") return row;

    const remaining = await loadActiveBatchTrays(client, row.batch_id);
    if (remaining.length) {
      await syncBatchIdForTrays(client, remaining, actor);
    }
    return row;
  });
}

export async function updateTrayBatchStatus(batch_id, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const bid = String(batch_id || "").trim();
  if (!bid) throw new Error("batch_id required");
  const meta = buildStatusUpdateSql(nextStatus);
  const { setSql, params } = bindStatusUpdate(meta, meta.status, actor, remark);

  return withTransaction(async (client) => {
    let where = `TRIM(COALESCE(batch_id, '')) = $1`;
    if (meta.status === "active") {
      where += ` AND TRIM(COALESCE(status, '')) IN ${TRAY_HELD_SQL}`;
    } else if (meta.status === "inactive") {
      where += ` AND TRIM(COALESCE(status, '')) = 'active'`;
    } else if (meta.status === "deleted") {
      where += ` AND TRIM(COALESCE(status, '')) <> 'deleted'`;
    }

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET ${setSql}
       WHERE ${where}
       RETURNING id, batch_id`,
      [bid, ...params],
    );

    if (meta.status === "deleted" && rows.length) {
      const remaining = await loadActiveBatchTrays(client, bid);
      if (remaining.length) {
        await syncBatchIdForTrays(client, remaining, actor);
      }
    }

    return {
      updated: rows.length,
      ids: rows.map((row) => row.id),
      batch_id: bid,
      status: meta.status,
    };
  });
}

export async function updateTrayStatusByIds(ids, nextStatus, actor = null, remark = null) {
  if (!isValidTrayStatus(nextStatus)) throw new Error("Invalid tray status");
  const meta = buildStatusUpdateSql(nextStatus);
  const { setSql, params } = bindStatusUpdate(meta, meta.status, actor, remark);
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  if (!idList.length) throw new Error("At least one tray id required");

  return withTransaction(async (client) => {
    let where = `id = ANY($1::int[]) AND TRIM(COALESCE(status, '')) <> 'deleted'`;
    if (meta.status === "active") {
      where += ` AND TRIM(COALESCE(status, '')) IN ${TRAY_HELD_SQL}`;
    } else if (meta.status === "inactive") {
      where += ` AND TRIM(COALESCE(status, '')) = 'active'`;
    }

    const { rows } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET ${setSql}
       WHERE ${where}
       RETURNING id, batch_id`,
      [idList, ...params],
    );

    if (meta.status === "deleted" && rows.length) {
      const batchIds = [...new Set(rows.map((row) => String(row.batch_id || "").trim()).filter(Boolean))];
      for (const bid of batchIds) {
        const remaining = await loadActiveBatchTrays(client, bid);
        if (remaining.length) {
          await syncBatchIdForTrays(client, remaining, actor);
        }
      }
    }

    return {
      updated: rows.length,
      ids: rows.map((row) => row.id),
      status: meta.status,
    };
  });
}

async function syncBatchIdForTrays(client, trays, actor = null) {
  if (!trays.length) return null;
  const type = trays[0].type;
  const minSerial = Number(trays[0].serial_number);
  const maxSerial = Number(trays[trays.length - 1].serial_number);
  const newBatchId = `${type}${minSerial}-${maxSerial}`;
  const ids = trays.map((row) => row.id);
  await client.query(
    `UPDATE ${T.TRAY_MASTER}
     SET batch_id = $1,
         updated_by = $2,
         updated_at = NOW()
     WHERE id = ANY($3::int[])`,
    [newBatchId, actor, ids],
  );
  return newBatchId;
}

export async function updateTrayBatch({ batch_id, type: nextType, quantity, approved, actor = null }) {
  const bid = String(batch_id || "").trim();
  if (!bid) throw new Error("batch_id required");

  return withTransaction(async (client) => {
    let trays = await loadActiveBatchTrays(client, bid);
    if (!trays.length) throw new Error("Batch not found");

    let type = trays[0].type;
    let changed = false;
    let nextBatchId = bid;

    const normalizedNextType = nextType ? normalizeTrayType(nextType) : null;
    if (normalizedNextType && normalizedNextType !== normalizeTrayType(type)) {
      if (trays.some((row) => row.approved)) {
        throw new Error("Cannot change type while authorized trays exist. Save as pending first.");
      }
      changed = true;
      await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);
      let nextSerial = (await getMaxSerialForType(client, normalizedNextType)) + 1;
      for (const row of trays) {
        await client.query(
          `UPDATE ${T.TRAY_MASTER}
           SET type = $1,
               serial_number = $2,
               code = CONCAT($1::text, $2::text),
               updated_by = $3,
               updated_at = NOW()
           WHERE id = $4
             AND status <> 'deleted'`,
          [normalizedNextType, nextSerial, actor, row.id],
        );
        nextSerial += 1;
      }
      type = normalizedNextType;
      trays = await loadActiveBatchTrays(client, bid);
      nextBatchId = (await syncBatchIdForTrays(client, trays, actor)) || bid;
      trays = await loadActiveBatchTrays(client, nextBatchId);
    }

    if (quantity !== undefined && quantity !== null) {
      const qty = Math.trunc(Number(quantity));
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("quantity must be a positive whole number");
      const current = trays.length;

      if (qty !== current) {
        changed = true;
        if (qty > current) {
          await client.query(`LOCK TABLE ${T.TRAY_MASTER} IN SHARE ROW EXCLUSIVE MODE`);
          const startSerial = (await getMaxSerialForType(client, type)) + 1;
          const endSerial = startSerial + (qty - current) - 1;
          await client.query(
            `INSERT INTO ${T.TRAY_MASTER}
              (code, type, serial_number, batch_id, approved, status, created_by)
             SELECT
              CONCAT($1::text, gs)::text AS code,
              $1::text AS type,
              gs AS serial_number,
              $2::text AS batch_id,
              false AS approved,
              'active' AS status,
              $3::text AS created_by
             FROM generate_series($4::int, $5::int) AS gs`,
            [type, nextBatchId, actor, startSerial, endSerial],
          );
        } else {
          const toRemove = trays.slice(qty);
          if (toRemove.some((row) => row.approved)) {
            throw new Error("Cannot reduce quantity while authorized trays exist. Move batch or trays to pending first.");
          }
          const removeIds = toRemove.map((row) => row.id);
          await client.query(
            `UPDATE ${T.TRAY_MASTER}
             SET status = 'deleted',
                 deleted_by = $2,
                 deleted_at = NOW(),
                 updated_by = $2,
                 updated_at = NOW()
             WHERE id = ANY($1::int[])
               AND status <> 'deleted'`,
            [removeIds, actor],
          );
        }

        trays = await loadActiveBatchTrays(client, nextBatchId);
        nextBatchId = (await syncBatchIdForTrays(client, trays, actor)) || nextBatchId;
        if (nextBatchId !== bid) {
          trays = await loadActiveBatchTrays(client, nextBatchId);
        }
      }
    }

    if (approved !== undefined && approved !== null) {
      const boolApproved = Boolean(approved);
      const targetBatchId = nextBatchId || bid;
      const { rows } = await client.query(
        `UPDATE ${T.TRAY_MASTER}
         SET approved = $2,
             approved_by = CASE WHEN $2 = true THEN $3 ELSE NULL END,
             approved_at = CASE WHEN $2 = true THEN NOW() ELSE NULL END
         WHERE TRIM(COALESCE(batch_id, '')) = $1
           AND status <> 'deleted'
           AND approved <> $2
         RETURNING id`,
        [targetBatchId, boolApproved, actor],
      );
      if (rows.length) changed = true;
    }

    trays = await loadActiveBatchTrays(client, nextBatchId || bid);

    return {
      changed,
      batch_id: nextBatchId || bid,
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

export async function deleteTrayBatch(batch_id, actor = null, remark = null) {
  const statusRemark = normalizeTrayRemark(remark, true);
  const rows = await dbQuery(
    `UPDATE ${T.TRAY_MASTER}
     SET status = 'deleted',
         remark = $3,
         deleted_by = $2,
         deleted_at = NOW(),
         updated_by = $2,
         updated_at = NOW()
     WHERE TRIM(COALESCE(batch_id, '')) = $1
       AND status <> 'deleted'
     RETURNING id`,
    [String(batch_id || "").trim(), actor, statusRemark],
  );
  return { updated: rows.length, ids: rows.map((row) => row.id) };
}

export async function findTrayBatches(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 100 } = options;
  const values = [];
  let idx = 1;
  const conditions = ["1=1"];
  let statusFilter = "active";

  if (filters?.type) {
    values.push(normalizeTrayType(filters.type));
    conditions.push(`UPPER(TRIM(COALESCE(t.type, ''))) = $${idx++}`);
  }
  if (filters?.status && filters.status !== "all") {
    statusFilter = String(filters.status).trim();
  } else if (String(filters?.status || "").toLowerCase() === "all") {
    statusFilter = "all";
  }
  idx = pushStatusCondition(conditions, values, statusFilter, idx);

  if (filters?.approved !== undefined && filters?.approved !== null && filters?.approved !== "all") {
    values.push(coerceApproved(filters.approved));
    conditions.push(`t.approved = $${idx++}`);
  }
  if (filters?.batch_id && filters.batch_id !== "all") {
    values.push(String(filters.batch_id).trim());
    conditions.push(`TRIM(COALESCE(t.batch_id, '')) = $${idx++}`);
  }

  if (search) {
    const sidx = idx++;
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      t.batch_id ILIKE $${sidx}
      OR t.type ILIKE $${sidx}
      OR CONCAT(t.type, t.serial_number)::text ILIKE $${sidx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*)::int AS count
     FROM (
       SELECT t.batch_id
       FROM ${T.TRAY_MASTER} t
       ${where}
       GROUP BY t.batch_id
     ) b`,
    values,
  );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const sortBy = String(sort.by || "created_at");
  const order = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const orderExpr = sortBy === "batch_id" ? "batch_id" : sortBy === "type" ? "type" : "created_at";

  const rows = await dbQuery(
    `SELECT
      t.batch_id,
      MAX(t.type) AS type,
      MIN(t.serial_number)::int AS start_serial_number,
      MAX(t.serial_number)::int AS end_serial_number,
      CONCAT(MAX(t.type), MIN(t.serial_number)) AS start_code,
      CONCAT(MAX(t.type), MAX(t.serial_number)) AS end_code,
      COUNT(*)::int AS tray_count,
      COUNT(*) FILTER (WHERE TRIM(COALESCE(t.status, '')) = 'active')::int AS active_count,
      COUNT(*) FILTER (WHERE TRIM(COALESCE(t.status, '')) IN ('inactive', 'discard'))::int AS inactive_count,
      COUNT(*) FILTER (WHERE TRIM(COALESCE(t.status, '')) = 'deleted')::int AS deleted_count,
      COUNT(*) FILTER (WHERE t.approved = true)::int AS approved_count,
      COUNT(*) FILTER (WHERE t.approved = false)::int AS pending_count,
      MIN(t.created_at) AS created_at,
      (ARRAY_AGG(t.created_by ORDER BY t.created_at ASC NULLS LAST) FILTER (WHERE t.created_by IS NOT NULL))[1] AS created_by_name,
      MAX(t.updated_at) AS updated_at,
      (ARRAY_AGG(t.updated_by ORDER BY t.updated_at DESC NULLS LAST) FILTER (WHERE t.updated_by IS NOT NULL))[1] AS updated_by_name,
      MAX(t.approved_at) AS approved_at,
      (ARRAY_AGG(t.approved_by ORDER BY t.approved_at DESC NULLS LAST) FILTER (WHERE t.approved_by IS NOT NULL))[1] AS approved_by_name
    FROM ${T.TRAY_MASTER} t
    ${where}
    GROUP BY t.batch_id
    ORDER BY ${orderExpr} ${order}
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
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
