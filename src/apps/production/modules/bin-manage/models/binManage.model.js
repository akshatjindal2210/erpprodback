import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES, PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { BIN_TYPE_SQL } from "../../../../ims/modules/tray/config/trayTypes.js";
import { normalizeTrayScanCode } from "../../../../ims/modules/tray/utils/trayScanParse.js";

const TM = IMS_TABLES.TRAY_MASTER;
const TYPES = new Set(["assign", "transfer", "relieve", "location"]);
const MODES = new Set(["partial", "full"]);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const binCode = (v) => String(v ?? "").trim().toUpperCase();
const binId = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const jcKey = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};
const numQty = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ACTIVE_BIN = `COALESCE(LOWER(TRIM(t.status)), 'active') = 'active'
  AND UPPER(TRIM(COALESCE(t.type, ''))) IN ${BIN_TYPE_SQL}`;

async function loadBinById(id, { forUpdate = false, client = null } = {}) {
  const key = binId(id);
  if (!key) return null;
  const lock = forUpdate ? " FOR UPDATE" : "";
  const sql = `SELECT t.id, t.code, t.type, t.status, t.pjobcardno, t.qty, t.lid, t.box_uid
     FROM ${TM} t
     WHERE t.id = $1 AND ${ACTIVE_BIN}${lock}`;
  if (client?.query) {
    const { rows } = await client.query(sql, [key]);
    return rows[0] || null;
  }
  const [row] = await dbQuery(sql, [key]);
  return row || null;
}

async function loadBinByCode(code, { forUpdate = false, client = null } = {}) {
  const key = binCode(code);
  if (!key) return null;
  const lock = forUpdate ? " FOR UPDATE" : "";
  const sql = `SELECT t.id, t.code, t.type, t.status, t.pjobcardno, t.qty, t.lid, t.box_uid
     FROM ${TM} t
     WHERE UPPER(TRIM(t.code)) = $1 AND ${ACTIVE_BIN}${lock}`;
  if (client?.query) {
    const { rows } = await client.query(sql, [key]);
    return rows[0] || null;
  }
  const [row] = await dbQuery(sql, [key]);
  return row || null;
}

async function insertRegister(client, row) {
  const q = client?.query ? client.query.bind(client) : dbQuery;
  const { rows } = await q(
    `INSERT INTO ${T.BIN_MANAGE} (
       type, mode, start_bin, end_bin,
       pjobcardno, qty, data, remark, created_by, updated_by, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9,NOW())
     RETURNING id, type, mode, start_bin, end_bin, pjobcardno, qty, data, remark, created_by, created_at, updated_by, updated_at`,
    [
      row.type,
      row.mode || null,
      row.start_bin || null,
      row.end_bin,
      row.pjobcardno || null,
      row.qty,
      JSON.stringify(row.data || {}),
      row.remark || null,
      row.actor || null,
    ]
  );
  return rows[0];
}

async function setBinLive(client, { id, pjobcardno, qty, lid, actor, clear = false }) {
  const q = client.query.bind(client);
  if (clear) {
    await q(
      `UPDATE ${TM}
       SET pjobcardno = NULL, qty = NULL, updated_by = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, actor]
    );
    return;
  }
  await q(
    `UPDATE ${TM}
     SET pjobcardno = COALESCE($2, pjobcardno),
         qty = $3,
         lid = COALESCE($4, lid),
         updated_by = $5, updated_at = NOW()
     WHERE id = $1`,
    [id, pjobcardno || null, qty, lid ?? null, actor]
  );
}

/** Scan / lookup a PRD bin — accepts plain code, id, or tray/bin QR payload. */
export async function scanBin(raw) {
  const key = normalizeTrayScanCode(raw) || binCode(raw);
  if (!key) throw httpError(400, "Invalid bin scan.");
  const bin = /^\d+$/.test(key) ? await loadBinById(key) : await loadBinByCode(key);
  if (!bin) throw httpError(404, "Bin not found. Use an active Production bin.");
  return {
    id: Number(bin.id),
    code: bin.code,
    type: bin.type,
    pjobcardno: bin.pjobcardno || null,
    qty: bin.qty != null ? Number(bin.qty) : 0,
    lid: bin.lid != null ? Number(bin.lid) : null,
    occupied: Boolean(bin.pjobcardno) || Number(bin.qty) > 0,
  };
}

/**
 * Assign JC into end_bin.
 * - Normal: add qty (> 0).
 * - setup: true → link JC (+ optional machine/stage) with no qty move.
 *   Used by Bin Manage “set” before production; qty comes later from manpower / entry.
 */
export async function assignBin(input = {}) {
  const endId = binId(input.end_bin);
  const jc = jcKey(input.pjobcardno);
  const setup = input.setup === true || input.setup === 1 || String(input.setup || "").toLowerCase() === "true";
  const q = numQty(input.qty);
  if (!endId) throw httpError(400, "End bin is required.");
  if (!jc) throw httpError(400, "Job card is required.");
  if (!setup && !(q > 0)) throw httpError(400, "Qty must be greater than 0.");

  return withTransaction(async (client) => {
    const bin = await loadBinById(endId, { forUpdate: true, client });
    if (!bin) throw httpError(404, "Bin not found.");
    const curJc = jcKey(bin.pjobcardno);
    const curQty = Number(bin.qty) || 0;
    if (curJc && curJc !== jc) {
      throw httpError(409, `Bin already holds JC ${curJc}. Relieve or transfer first.`);
    }
    const addQty = setup ? 0 : q;
    const nextQty = curQty + addQty;
    const lid = input.lid != null ? Number(input.lid) : bin.lid;
    const machine = Number(input.machine) > 0 ? Number(input.machine) : null;
    const stage = Number(input.stage) > 0 ? Number(input.stage) : null;
    const binRole = String(input.bin_role || (setup ? "end" : "")).trim().toLowerCase() || null;
    const isStartRole = binRole === "start";
    await setBinLive(client, { id: bin.id, pjobcardno: jc, qty: nextQty, lid, actor: input.actor });
    // Schema: end_bin NOT NULL. Start role → also fill start_bin; End role → end_bin only.
    const saved = await insertRegister(client, {
      type: "assign",
      start_bin: isStartRole ? Number(bin.id) : null,
      end_bin: Number(bin.id),
      pjobcardno: jc,
      qty: addQty,
      remark: input.remark || null,
      actor: input.actor,
      data: {
        balance_qty: nextQty,
        code: bin.code,
        ...(isStartRole ? { start_code: bin.code } : { end_code: bin.code }),
        ...(lid != null ? { lid } : {}),
        ...(setup ? { setup: true } : {}),
        ...(machine ? { machine } : {}),
        ...(stage ? { stage } : {}),
        ...(binRole ? { bin_role: binRole } : {}),
      },
    });
    return { ...saved, balance_qty: nextQty };
  });
}

/** Transfer qty: start_bin → end_bin. setup: true → link both bins to JC, no qty move. */
export async function transferBin(input = {}) {
  const mode = MODES.has(String(input.mode || "").toLowerCase()) ? String(input.mode).toLowerCase() : "partial";
  const setup = input.setup === true || input.setup === 1 || String(input.setup || "").toLowerCase() === "true";
  const startId = binId(input.start_bin);
  const endId = binId(input.end_bin);
  if (!startId || !endId) throw httpError(400, "Start bin and end bin are required.");
  if (startId === endId) throw httpError(400, "Start and end bin must be different.");

  return withTransaction(async (client) => {
    const from = await loadBinById(startId, { forUpdate: true, client });
    if (!from) throw httpError(404, "Start bin not found.");
    const to = await loadBinById(endId, { forUpdate: true, client });
    if (!to) throw httpError(404, "End bin not found.");

    const machine = Number(input.machine) > 0 ? Number(input.machine) : null;
    const stage = Number(input.stage) > 0 ? Number(input.stage) : null;

    if (setup) {
      const jc = jcKey(input.pjobcardno) || jcKey(from.pjobcardno) || jcKey(to.pjobcardno);
      if (!jc) throw httpError(400, "Job card is required.");
      const fromJc = jcKey(from.pjobcardno);
      const toJc = jcKey(to.pjobcardno);
      if (fromJc && fromJc !== jc) throw httpError(409, `Start bin holds JC ${fromJc}.`);
      if (toJc && toJc !== jc) throw httpError(409, `End bin holds JC ${toJc}.`);
      const fromQty = Number(from.qty) || 0;
      const toQty = Number(to.qty) || 0;
      await setBinLive(client, { id: from.id, pjobcardno: jc, qty: fromQty, lid: from.lid, actor: input.actor });
      await setBinLive(client, { id: to.id, pjobcardno: jc, qty: toQty, lid: to.lid, actor: input.actor });
      const saved = await insertRegister(client, {
        type: "transfer",
        mode: "partial",
        start_bin: Number(from.id),
        end_bin: Number(to.id),
        pjobcardno: jc,
        qty: 0,
        remark: input.remark || null,
        actor: input.actor,
        data: {
          setup: true,
          start_balance: fromQty,
          end_balance: toQty,
          start_code: from.code,
          end_code: to.code,
          ...(machine ? { machine } : {}),
          ...(stage ? { stage } : {}),
          bin_role: "from_to",
        },
      });
      return { ...saved, start_balance: fromQty, end_balance: toQty };
    }

    const fromJc = jcKey(from.pjobcardno);
    const fromQty = Number(from.qty) || 0;
    if (!fromJc || !(fromQty > 0)) throw httpError(400, "Start bin has no JC qty to transfer.");

    const moveQty = mode === "full" ? fromQty : numQty(input.qty);
    if (!(moveQty > 0)) throw httpError(400, "Transfer qty must be greater than 0.");
    if (moveQty > fromQty) throw httpError(400, `Only ${fromQty} available on start bin.`);

    const toJc = jcKey(to.pjobcardno);
    if (toJc && toJc !== fromJc) {
      throw httpError(409, `End bin holds JC ${toJc}. Relieve it first.`);
    }

    const left = fromQty - moveQty;
    if (left > 0) {
      await setBinLive(client, { id: from.id, pjobcardno: fromJc, qty: left, actor: input.actor });
    } else {
      await setBinLive(client, { id: from.id, actor: input.actor, clear: true });
    }

    const toNext = (Number(to.qty) || 0) + moveQty;
    await setBinLive(client, {
      id: to.id,
      pjobcardno: fromJc,
      qty: toNext,
      lid: to.lid,
      actor: input.actor,
    });

    const saved = await insertRegister(client, {
      type: "transfer",
      mode,
      start_bin: Number(from.id),
      end_bin: Number(to.id),
      pjobcardno: fromJc,
      qty: moveQty,
      remark: input.remark || null,
      actor: input.actor,
      data: {
        start_balance: left > 0 ? left : 0,
        end_balance: toNext,
        start_code: from.code,
        end_code: to.code,
      },
    });
    return { ...saved, start_balance: left > 0 ? left : 0, end_balance: toNext };
  });
}

/** Relieve — clear JC/qty from end_bin (tray_master.id). */
export async function relieveBin(input = {}) {
  const endId = binId(input.end_bin);
  if (!endId) throw httpError(400, "End bin is required.");

  return withTransaction(async (client) => {
    const bin = await loadBinById(endId, { forUpdate: true, client });
    if (!bin) throw httpError(404, "Bin not found.");
    const curJc = jcKey(bin.pjobcardno);
    const curQty = Number(bin.qty) || 0;
    if (!curJc && !(curQty > 0)) throw httpError(400, "Bin is already empty.");

    const relieveQty = input.qty != null ? numQty(input.qty) : curQty;
    if (!(relieveQty > 0)) throw httpError(400, "Relieve qty must be greater than 0.");
    if (relieveQty > curQty) throw httpError(400, `Only ${curQty} on bin.`);

    const left = curQty - relieveQty;
    if (left > 0) {
      await setBinLive(client, { id: bin.id, pjobcardno: curJc, qty: left, actor: input.actor });
    } else {
      await setBinLive(client, { id: bin.id, actor: input.actor, clear: true });
    }

    const saved = await insertRegister(client, {
      type: "relieve",
      end_bin: Number(bin.id),
      pjobcardno: curJc,
      qty: relieveQty,
      remark: input.remark || null,
      actor: input.actor,
      data: { balance_qty: left > 0 ? left : 0, code: bin.code },
    });
    return { ...saved, balance_qty: left > 0 ? left : 0 };
  });
}

/** Set end_bin lid on tray_master; snapshot in data. */
export async function assignBinLocation(input = {}) {
  const endId = binId(input.end_bin);
  const lid = Number(input.lid);
  if (!endId) throw httpError(400, "End bin is required.");
  if (!(lid > 0)) throw httpError(400, "Location is required.");

  return withTransaction(async (client) => {
    const bin = await loadBinById(endId, { forUpdate: true, client });
    if (!bin) throw httpError(404, "Bin not found.");
    let locationNo = String(input.location_no || "").trim() || null;
    if (!locationNo) {
      const { rows: locRows } = await client.query(
        `SELECT location_no FROM ${IMS_TABLES.LOCATION_MASTER}
         WHERE location_id = $1 LIMIT 1`,
        [lid]
      );
      locationNo = locRows[0]?.location_no ? String(locRows[0].location_no).trim() : null;
    }
    await client.query(
      `UPDATE ${TM} SET lid = $2, updated_by = $3, updated_at = NOW() WHERE id = $1`,
      [bin.id, lid, input.actor]
    );
    const saved = await insertRegister(client, {
      type: "location",
      end_bin: Number(bin.id),
      pjobcardno: jcKey(bin.pjobcardno),
      qty: bin.qty != null ? Number(bin.qty) : null,
      remark: input.remark || null,
      actor: input.actor,
      data: { lid, code: bin.code, ...(locationNo ? { location_no: locationNo } : {}) },
    });
    return { ...saved, lid, location_no: locationNo };
  });
}

export async function listBinManage({ page = 1, limit = 100, type = null, search = null, from_date = null, to_date = null } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;
  const where = ["m.is_deleted = false"];
  const vals = [];
  let i = 1;

  if (type && TYPES.has(String(type).toLowerCase())) {
    where.push(`m.type = $${i++}`);
    vals.push(String(type).toLowerCase());
  }
  if (from_date) {
    where.push(`m.created_at::date >= $${i++}::date`);
    vals.push(from_date);
  }
  if (to_date) {
    where.push(`m.created_at::date <= $${i++}::date`);
    vals.push(to_date);
  }
  if (search && String(search).trim()) {
    where.push(
      `(m.pjobcardno ILIKE $${i} OR m.remark ILIKE $${i}
        OR m.data->>'code' ILIKE $${i} OR m.data->>'start_code' ILIKE $${i} OR m.data->>'end_code' ILIKE $${i}
        OR m.start_bin::text ILIKE $${i} OR m.end_bin::text ILIKE $${i})`
    );
    vals.push(`%${String(search).trim()}%`);
    i++;
  }

  const locTable = IMS_TABLES.LOCATION_MASTER;
  const rows = await dbQuery(
    `SELECT m.*,
            COALESCE(NULLIF(TRIM(m.data->>'location_no'), ''), loc.location_no) AS location_no,
            COUNT(*) OVER()::int AS _total
     FROM ${T.BIN_MANAGE} m
     LEFT JOIN ${locTable} loc
       ON loc.location_id = CASE
            WHEN COALESCE(TRIM(m.data->>'lid'), '') ~ '^[0-9]+$'
            THEN (TRIM(m.data->>'lid'))::int
            ELSE NULL
          END
     WHERE ${where.join(" AND ")}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${i++} OFFSET $${i++}`,
    [...vals, safeLimit, offset]
  );
  const total = Number(rows[0]?._total) || 0;
  return {
    data: rows.map(({ _total, ...r }) => {
      const data = r.data && typeof r.data === "object" ? { ...r.data } : {};
      if (r.location_no && !data.location_no) data.location_no = r.location_no;
      return {
        ...r,
        id: Number(r.id),
        start_bin: r.start_bin != null ? Number(r.start_bin) : null,
        end_bin: r.end_bin != null ? Number(r.end_bin) : null,
        qty: r.qty != null ? Number(r.qty) : null,
        location_no: r.location_no || data.location_no || null,
        data,
      };
    }),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}

export async function getBinManage(id) {
  const rowId = Number(id);
  if (!(rowId > 0)) throw httpError(400, "id is required.");
  const [row] = await dbQuery(
    `SELECT m.* FROM ${T.BIN_MANAGE} m WHERE m.id = $1 AND m.is_deleted = false`,
    [rowId]
  );
  if (!row) throw httpError(404, "Register row not found.");
  return {
    ...row,
    id: Number(row.id),
    start_bin: row.start_bin != null ? Number(row.start_bin) : null,
    end_bin: row.end_bin != null ? Number(row.end_bin) : null,
    qty: row.qty != null ? Number(row.qty) : null,
    data: row.data && typeof row.data === "object" ? row.data : {},
  };
}

/**
 * Update register row.
 * - assign (esp. setup): bin / Start|End / machine / JC / remark
 * - location: bin / lid / remark
 * - transfer / relieve: remark only (qty moves stay immutable here)
 */
export async function updateBinManage(input = {}) {
  const rowId = Number(input.id);
  if (!(rowId > 0)) throw httpError(400, "id is required.");
  const actor = input.actor || null;

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      `SELECT * FROM ${T.BIN_MANAGE} WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [rowId]
    );
    const existing = existingRows[0];
    if (!existing) throw httpError(404, "Register row not found.");
    const type = String(existing.type || "").toLowerCase();
    const prevData = existing.data && typeof existing.data === "object" ? existing.data : {};
    const remark = input.remark !== undefined ? String(input.remark || "").trim() || null : existing.remark;

    if (type === "assign") {
      const binIdNew = binId(input.end_bin ?? input.bin_id ?? existing.end_bin);
      if (!binIdNew) throw httpError(400, "Bin is required.");
      const jc = jcKey(input.pjobcardno !== undefined ? input.pjobcardno : existing.pjobcardno);
      if (!jc) throw httpError(400, "Job card is required.");
      const binRole = String(input.bin_role || prevData.bin_role || "end").trim().toLowerCase();
      const isStartRole = binRole === "start";
      const machine =
        input.machine !== undefined
          ? Number(input.machine) > 0
            ? Number(input.machine)
            : null
          : prevData.machine != null
            ? Number(prevData.machine)
            : null;
      const stage =
        input.stage !== undefined
          ? Number(input.stage) > 0
            ? Number(input.stage)
            : null
          : prevData.stage != null
            ? Number(prevData.stage)
            : null;
      const setup = prevData.setup === true || input.setup === true;

      const bin = await loadBinById(binIdNew, { forUpdate: true, client });
      if (!bin) throw httpError(404, "Bin not found.");
      const curJc = jcKey(bin.pjobcardno);
      if (curJc && curJc !== jc) {
        throw httpError(409, `Bin already holds JC ${curJc}. Relieve or transfer first.`);
      }

      const oldBinId = Number(existing.end_bin) || Number(existing.start_bin);
      if (setup && oldBinId && oldBinId !== Number(bin.id)) {
        const old = await loadBinById(oldBinId, { forUpdate: true, client });
        if (old && jcKey(old.pjobcardno) === jcKey(existing.pjobcardno) && !(Number(old.qty) > 0)) {
          // Only free old bin if no other active setup row still points at it.
          const { rows: otherSetup } = await client.query(
            `SELECT id FROM ${T.BIN_MANAGE}
             WHERE is_deleted = false AND id <> $1 AND type = 'assign'
               AND (end_bin = $2 OR start_bin = $2)
               AND pjobcardno IS NOT DISTINCT FROM $3
               AND COALESCE(data->>'setup', '') = 'true'
             LIMIT 1`,
            [rowId, oldBinId, existing.pjobcardno]
          );
          if (!otherSetup.length) {
            await setBinLive(client, { id: old.id, actor, clear: true });
          }
        }
      }
      const keepQty = Number(bin.qty) || 0;
      await setBinLive(client, {
        id: bin.id,
        pjobcardno: jc,
        qty: keepQty,
        lid: bin.lid,
        actor,
      });

      const nextData = {
        ...prevData,
        balance_qty: keepQty,
        code: bin.code,
        setup: setup || prevData.setup === true,
        bin_role: binRole,
      };
      delete nextData.end_code;
      delete nextData.start_code;
      if (isStartRole) nextData.start_code = bin.code;
      else nextData.end_code = bin.code;
      if (machine) nextData.machine = machine;
      else delete nextData.machine;
      if (stage) nextData.stage = stage;
      else delete nextData.stage;

      const { rows } = await client.query(
        `UPDATE ${T.BIN_MANAGE}
         SET start_bin = $2, end_bin = $3, pjobcardno = $4, remark = $5, data = $6::jsonb,
             updated_by = $7, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          rowId,
          isStartRole ? Number(bin.id) : null,
          Number(bin.id),
          jc,
          remark,
          JSON.stringify(nextData),
          actor,
        ]
      );
      const saved = rows[0];
      return {
        ...saved,
        id: Number(saved.id),
        start_bin: saved.start_bin != null ? Number(saved.start_bin) : null,
        end_bin: saved.end_bin != null ? Number(saved.end_bin) : null,
        qty: saved.qty != null ? Number(saved.qty) : null,
      };
    }

    if (type === "location") {
      const binIdNew = binId(input.end_bin ?? input.bin_id ?? existing.end_bin);
      const lid = Number(input.lid ?? prevData.lid);
      if (!binIdNew) throw httpError(400, "Bin is required.");
      if (!(lid > 0)) throw httpError(400, "Location is required.");
      const bin = await loadBinById(binIdNew, { forUpdate: true, client });
      if (!bin) throw httpError(404, "Bin not found.");
      let locationNo = String(input.location_no || "").trim() || prevData.location_no || null;
      if (!locationNo || Number(prevData.lid) !== lid) {
        const { rows: locRows } = await client.query(
          `SELECT location_no FROM ${IMS_TABLES.LOCATION_MASTER}
           WHERE location_id = $1 LIMIT 1`,
          [lid]
        );
        if (locRows[0]?.location_no) locationNo = String(locRows[0].location_no).trim();
      }
      await client.query(
        `UPDATE ${TM} SET lid = $2, updated_by = $3, updated_at = NOW() WHERE id = $1`,
        [bin.id, lid, actor]
      );
      const nextData = {
        ...prevData,
        lid,
        code: bin.code,
        ...(locationNo ? { location_no: locationNo } : {}),
      };
      const { rows } = await client.query(
        `UPDATE ${T.BIN_MANAGE}
         SET end_bin = $2, remark = $3, data = $4::jsonb, updated_by = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [rowId, Number(bin.id), remark, JSON.stringify(nextData), actor]
      );
      const saved = rows[0];
      return {
        ...saved,
        id: Number(saved.id),
        end_bin: Number(saved.end_bin),
        lid,
      };
    }

    // transfer / relieve — remark only
    const { rows } = await client.query(
      `UPDATE ${T.BIN_MANAGE}
       SET remark = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [rowId, remark, actor]
    );
    const saved = rows[0];
    return {
      ...saved,
      id: Number(saved.id),
      start_bin: saved.start_bin != null ? Number(saved.start_bin) : null,
      end_bin: saved.end_bin != null ? Number(saved.end_bin) : null,
      qty: saved.qty != null ? Number(saved.qty) : null,
    };
  });
}

export async function softDeleteBinManage({ id, actor = null }) {
  const rowId = Number(id);
  if (!(rowId > 0)) throw httpError(400, "id is required.");

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      `SELECT * FROM ${T.BIN_MANAGE} WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [rowId]
    );
    const existing = existingRows[0];
    if (!existing) throw httpError(404, "Register row not found.");

    const data = existing.data && typeof existing.data === "object" ? existing.data : {};
    // Setup assign (qty 0): free live JC only when no other active setup still uses this bin+JC.
    if (String(existing.type).toLowerCase() === "assign" && data.setup === true) {
      const liveId = Number(existing.end_bin) || Number(existing.start_bin);
      if (liveId > 0) {
        const { rows: otherSetup } = await client.query(
          `SELECT id FROM ${T.BIN_MANAGE}
           WHERE is_deleted = false AND id <> $1 AND type = 'assign'
             AND (end_bin = $2 OR start_bin = $2)
             AND pjobcardno IS NOT DISTINCT FROM $3
             AND COALESCE(data->>'setup', '') = 'true'
           LIMIT 1`,
          [rowId, liveId, existing.pjobcardno]
        );
        if (!otherSetup.length) {
          const bin = await loadBinById(liveId, { forUpdate: true, client });
          if (
            bin &&
            jcKey(bin.pjobcardno) === jcKey(existing.pjobcardno) &&
            !(Number(bin.qty) > 0)
          ) {
            await setBinLive(client, { id: bin.id, actor, clear: true });
          }
        }
      }
    }

    const { rows } = await client.query(
      `UPDATE ${T.BIN_MANAGE}
       SET is_deleted = true, deleted_by = $2, deleted_at = NOW(), updated_by = $2, updated_at = NOW()
       WHERE id = $1 AND is_deleted = false
       RETURNING id`,
      [rowId, actor]
    );
    if (!rows[0]) throw httpError(404, "Register row not found.");
    return { id: Number(rows[0].id) };
  });
}
