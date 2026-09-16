import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { sqlDailyprodDocNoMatch } from "../../box/utils/inventory/boxInventorySql.js";
import { TRAY_OCC_JOIN, TRAY_POOL_EXPR } from "../../tray/lib/trayOccupancySql.js";

const IN_HAND = `b.out_uid IS NULL AND (b.sa_entry_type IS DISTINCT FROM 'stock_out') AND b.qc_hold_id IS NULL`;
const PN = (alias) => `TRIM(${alias ? `${alias}.` : ""}packing_number::text)`;
const DOC = `TRIM(dp.doc_no::text)`;
const IS_TRAY = `(
  LOWER(TRIM(COALESCE(dp.category_name, ''))) = 'tray'
  OR LOWER(TRIM(COALESCE(c.name, ''))) = 'tray'
)`;
const TRAY_JOINS = `LEFT JOIN ${T.CATEGORY} c ON c.id = dp.category_id`;
const DP_JOIN = sqlDailyprodDocNoMatch("dp.doc_no", "ba.packing_number");
const BATCH_JOIN = `LEFT JOIN ${T.TRAY_BATCH} tb ON tb.batch_id = t.batch_id`;
const ACTIVE_TRAY = `COALESCE(LOWER(TRIM(t.status)), 'active') = 'active' AND COALESCE(tb.is_deleted, false) = false`;
const BOX_LINK = `
  LEFT JOIN ${T.BOX_TABLE} lb ON lb.box_uid = t.box_uid AND lb.is_deleted = false
  LEFT JOIN LATERAL (
    SELECT item_code, acc_code, acc_name, job_card_no, doc_dt
    FROM ${T.DAILYPROD}
    WHERE ${sqlDailyprodDocNoMatch("doc_no", "lb.packing_number")}
    LIMIT 1
  ) dp ON true
  LEFT JOIN ${T.OUT_ENTRY} oe ON oe.out_uid = lb.out_uid AND COALESCE(oe.is_deleted, false) = false
  LEFT JOIN ${T.FORWARDING_NOTE_MASTER} fn ON fn.fuid = oe.fuid AND COALESCE(fn.is_deleted, false) = false`;

const SELECT_FIELDS = `
  ${DOC} AS id, ${DOC} AS packing_number,
  dp.item_dcode, dp.item_code, dp.item_desc, dp.acc_code, dp.acc_name, dp.doc_dt, dp.job_card_no, dp.total_qty,
  ba.box_count, ba.link_count, ba.open_count, ba.open_in_hand, ba.used_count, NULL::text AS remarks,
  (ba.used_count > 0 OR (ba.link_count > 0 AND ba.link_count >= ba.box_count)) AS approved,
  (ba.link_count > 0 AND ba.link_count < ba.box_count) AS submitted,
  ba.created_by, ba.created_at, ba.updated_at,
  ba.created_by AS created_by_name, ba.updated_by, ba.updated_by AS updated_by_name,
  dp.category_name`;

const SORT = {
  doc_dt: "dp.doc_dt",
  total_qty: "dp.total_qty",
  item_dcode: "dp.item_dcode",
  packing_number: "dp.doc_no",
  id: "dp.doc_no",
  box_count: "ba.box_count",
  approved: "ba.link_count",
  updated_at: "ba.updated_at",
  created_at: "ba.created_at",
};

const POOL = {
  out: "in_use", filled: "in_use", bhar: "in_use", in_use: "in_use",
  store: "factory", store_in: "factory", factory: "factory",
  vacant: "vacant", empty: "vacant",
  storage: "storage",
  with_customer: "with_customer", customer: "with_customer", customer_end: "with_customer",
};

export function packingKey(value) {
  return String(value ?? "").trim();
}

function truthy(val) {
  return val === true || val === "true" || val === 1 || val === "1";
}

function packingListSql({ onlyInHand = false, extraWhere = "", includeTotal = false } = {}) {
  return `
    WITH tray_packings AS (
      SELECT DISTINCT ${DOC} AS packing_number
      FROM ${T.DAILYPROD} dp
      ${TRAY_JOINS}
      WHERE ${IS_TRAY}
    ),
    stickers AS (
      SELECT
        ${PN("b")} AS packing_number,
        b.created_at,
        b.created_by,
        tl.id AS tray_id,
        tl.updated_at AS linked_at,
        tl.updated_by AS linked_by,
        (${IN_HAND}) AS in_hand,
        (b.location_id IS NOT NULL OR b.out_uid IS NOT NULL) AS used,
        LOWER(TRIM(COALESCE(box_cat.name, ''))) = 'tray' AS box_is_tray
      FROM ${T.BOX_TABLE} b
      LEFT JOIN ${T.CATEGORY} box_cat ON box_cat.id = b.category_id
      LEFT JOIN ${T.TRAY_MASTER} tl ON tl.box_uid = b.box_uid
      WHERE b.is_deleted = false
        AND NULLIF(${PN("b")}, '') IS NOT NULL
        AND (
          LOWER(TRIM(COALESCE(box_cat.name, ''))) = 'tray'
          OR EXISTS (
            SELECT 1 FROM tray_packings tp
            WHERE tp.packing_number = ${PN("b")}
          )
        )
    ),
    scanned AS (
      SELECT * FROM stickers
      ${onlyInHand ? "WHERE in_hand" : ""}
    ),
    packing_counts AS (
      SELECT
        packing_number,
        COUNT(*)::int AS box_count,
        COUNT(*) FILTER (WHERE tray_id IS NOT NULL)::int AS link_count,
        COUNT(*) FILTER (WHERE tray_id IS NULL)::int AS open_count,
        COUNT(*) FILTER (WHERE tray_id IS NULL AND in_hand)::int AS open_in_hand,
        BOOL_OR(box_is_tray) AS is_tray_box,
        MIN(created_at) AS created_at,
        MAX(created_by) AS created_by
      FROM scanned
      GROUP BY packing_number
    ),
    used_counts AS (
      SELECT packing_number, COUNT(*) FILTER (WHERE used)::int AS used_count
      FROM stickers
      GROUP BY packing_number
    ),
    last_link AS (
      SELECT DISTINCT ON (packing_number)
        packing_number,
        linked_at AS updated_at,
        linked_by AS updated_by
      FROM scanned
      WHERE tray_id IS NOT NULL
      ORDER BY packing_number, linked_at DESC NULLS LAST
    ),
    packing AS (
      SELECT c.*, COALESCE(u.used_count, 0) AS used_count, ll.updated_at, ll.updated_by
      FROM packing_counts c
      LEFT JOIN used_counts u USING (packing_number)
      LEFT JOIN last_link ll USING (packing_number)
    )
    SELECT ${SELECT_FIELDS}${includeTotal ? ", COUNT(*) OVER()::int AS _total" : ""}
    FROM packing ba
    JOIN LATERAL (
      SELECT
        dp.doc_no, dp.item_dcode, dp.item_code, dp.item_desc,
        dp.acc_code, dp.acc_name, dp.doc_dt, dp.job_card_no, dp.total_qty, dp.category_name,
        (${IS_TRAY}) AS category_is_tray
      FROM ${T.DAILYPROD} dp
      ${TRAY_JOINS}
      WHERE ${DP_JOIN}
      ORDER BY CASE WHEN ${IS_TRAY} THEN 0 ELSE 1 END, dp.doc_dt DESC NULLS LAST
      LIMIT 1
    ) dp ON true
    WHERE (dp.category_is_tray OR ba.is_tray_box)
      AND ba.box_count > 0
      ${extraWhere}`;
}

function pageOf(page, limit, max = 1000) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(max, Math.max(1, Number(limit) || 100));
  return { safePage, safeLimit, offset: (safePage - 1) * safeLimit };
}

export async function getManageTrayPendingPackingNumbers(packingNumbers = []) {
  const list = [...new Set(packingNumbers.map(packingKey).filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await dbQuery(
    `SELECT DISTINCT ${PN("b")} AS pn
     FROM ${T.BOX_TABLE} b
     JOIN ${T.DAILYPROD} dp ON ${sqlDailyprodDocNoMatch("dp.doc_no", "b.packing_number")}
     ${TRAY_JOINS}
     WHERE b.is_deleted = false AND ${PN("b")} = ANY($1::text[])
       AND ${IN_HAND} AND ${IS_TRAY}
       AND NOT EXISTS (
         SELECT 1 FROM ${T.TRAY_MANAGE} m
         WHERE m.is_deleted = false
           AND m.approved = true
           AND TRIM(m.data->>'packing_number') = ${PN("b")}
       )`,
    [list]
  );
  return new Set(rows.map((r) => packingKey(r.pn)));
}

export async function findManageTrays(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const registered = truthy(filters.approved);
  if (registered) return findRegisteredSnapshots({ ...options, permission: options.permission || {} });
  const packingWhere = [`(
    ba.open_count > 0
    OR (
      ba.link_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM ${T.TRAY_MANAGE} m
        WHERE m.is_deleted = false
          AND m.approved = true
          AND TRIM(m.data->>'packing_number') = ba.packing_number
      )
    )
  )`];

  for (const [key, val] of Object.entries(filters)) {
    if (val == null || val === "" || key === "approved") continue;
    if (key === "from_date") {
      values.push(String(val).slice(0, 10));
      packingWhere.push(`COALESCE(dp.doc_dt, ba.created_at::date) >= $${i++}::date`);
    } else if (key === "to_date") {
      values.push(String(val).slice(0, 10));
      packingWhere.push(`COALESCE(dp.doc_dt, ba.created_at::date) <= $${i++}::date`);
    } else if (key === "id" || key === "packing_number") {
      values.push(packingKey(val));
      packingWhere.push(`${DOC} = $${i++}`);
    } else if (key === "item_dcode") {
      values.push(val);
      packingWhere.push(`dp.item_dcode = $${i++}`);
    }
  }

  if (search) {
    values.push(`%${String(search).trim()}%`);
    packingWhere.push(`(${DOC} ILIKE $${i} OR dp.item_code ILIKE $${i} OR dp.acc_name ILIKE $${i} OR dp.job_card_no ILIKE $${i})`);
    i++;
  }

  const { safePage, safeLimit, offset } = pageOf(page, limit);
  const sortExpr = SORT[sort.by] || "ba.created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const rows = await dbQuery(
    `${packingListSql({ onlyInHand: !registered, extraWhere: `AND ${packingWhere.join(" AND ")}`, includeTotal: true })}
     ORDER BY ${sortExpr} ${sortOrder} NULLS LAST
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );
  const total = Number(rows[0]?._total) || 0;
  return {
    data: rows.map(({ _total, ...row }) => row),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}

export async function findManageTray(filters = {}) {
  const pn = packingKey(filters.packing_number ?? filters.id);
  if (!pn) return null;
  const [row] = await dbQuery(
    `${packingListSql({ extraWhere: `AND ${DOC} = $1` })}
     LIMIT 1`,
    [pn]
  );
  return row ?? null;
}

export async function findManageTrayLinks(packingNumber) {
  const pn = packingKey(packingNumber);
  if (!pn) return [];
  return dbQuery(
    `SELECT b.box_uid AS id, b.box_no_uid, b.box_uid, t.id AS tray_id, t.code AS tray_code, b.qty, t.updated_at AS created_at
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     WHERE t.box_uid IS NOT NULL AND ${PN("b")} = $1
     ORDER BY b.box_uid DESC`,
    [pn]
  );
}

export async function clearManageTrayWork({ packingNumber, updatedBy = null } = {}) {
  const pn = packingKey(packingNumber);
  if (!pn) throw new Error("Packing number is required.");
  await dbQuery(
    `UPDATE ${T.TRAY_MASTER} t
     SET box_uid = NULL, updated_by = $2, updated_at = NOW()
     FROM ${T.BOX_TABLE} b
     WHERE t.box_uid = b.box_uid
       AND b.is_deleted = false
       AND ${PN("b")} = $1`,
    [pn, updatedBy]
  );
  return { packing_number: pn };
}

export async function replaceManageTrayLinks({ packingNumber, links = [], createdBy = null } = {}) {
  const pn = packingKey(packingNumber);
  if (!pn) throw new Error("Packing number is required.");

  const uids = [];
  const ids = [];
  const codeByUid = new Map();
  for (const [idx, row] of (links || []).entries()) {
    const boxNo = String(row?.box_no_uid ?? "").trim();
    const trayId = parseInt(String(row?.tray_id), 10);
    if (!boxNo || !Number.isFinite(trayId) || trayId <= 0) continue;
    uids.push(boxNo);
    ids.push(trayId);
    codeByUid.set(boxNo, { tray_code: row.tray_code, sort_order: idx });
  }

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE ${T.TRAY_MASTER} t
       SET box_uid = NULL, updated_by = $2, updated_at = NOW()
       FROM ${T.BOX_TABLE} b
       WHERE t.box_uid = b.box_uid
         AND b.is_deleted = false
         AND ${PN("b")} = $1`,
      [pn, createdBy]
    );
    if (!uids.length) return [];
    const { rows: saved } = await client.query(
      `UPDATE ${T.TRAY_MASTER} t
       SET box_uid = b.box_uid, updated_by = $2, updated_at = NOW()
       FROM unnest($3::text[], $4::int[]) AS v(box_no_uid, tray_id)
       JOIN ${T.BOX_TABLE} b
         ON b.is_deleted = false
        AND TRIM(b.box_no_uid::text) = v.box_no_uid
        AND ${PN("b")} = $1
       WHERE t.id = v.tray_id
       RETURNING t.id AS tray_id, b.box_uid, b.packing_number, b.box_no_uid, b.qty, t.updated_at AS created_at`,
      [pn, createdBy, uids, ids]
    );
    return saved.map((row) => ({ ...row, ...codeByUid.get(row.box_no_uid) }));
  });
}

export async function findManageTrayLinkConflicts({ packingNumber, boxNoUids = [], trayCodes = [] } = {}) {
  const pn = packingKey(packingNumber);
  const boxes = [...new Set(boxNoUids.map((v) => String(v ?? "").trim()).filter(Boolean))];
  const codes = [...new Set(trayCodes.map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (!pn || (!boxes.length && !codes.length)) return [];

  const values = [pn];
  const parts = [];
  if (boxes.length) {
    values.push(boxes);
    parts.push(`b.box_no_uid = ANY($${values.length}::text[])`);
  }
  if (codes.length) {
    values.push(codes);
    parts.push(`t.code = ANY($${values.length}::text[])`);
  }
  return dbQuery(
    `SELECT b.box_no_uid, t.code AS tray_code, b.packing_number
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     WHERE t.box_uid IS NOT NULL AND ${PN("b")} <> $1 AND (${parts.join(" OR ")})`,
    values
  );
}

export async function receiveTray({ trayId, createdBy = null } = {}) {
  const id = parseInt(String(trayId), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Tray is required.");
  const rows = await dbQuery(
    `WITH target AS (
       SELECT b.box_no_uid, b.packing_number
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1 AND t.box_uid IS NOT NULL AND b.out_uid IS NOT NULL
     ),
     cleared AS (
       UPDATE ${T.TRAY_MASTER} t
       SET box_uid = NULL, updated_by = $2, updated_at = NOW()
       FROM target
       WHERE t.id = $1
       RETURNING t.id
     )
     SELECT box_no_uid, packing_number FROM target`,
    [id, createdBy]
  );
  if (!rows.length) throw new Error("Only a tray sent to a customer can be received.");
  return { cleared: rows.length, boxes: rows };
}

export async function reassignBoxTray({ boxNoUid, trayId, createdBy = null } = {}) {
  const uid = String(boxNoUid ?? "").trim();
  const id = parseInt(String(trayId), 10);
  if (!uid) throw new Error("Sticker is required.");
  if (!Number.isFinite(id) || id <= 0) throw new Error("Tray is required.");

  return withTransaction(async (client) => {
    const { rows: boxRows } = await client.query(
      `SELECT box_uid, box_no_uid, packing_number, qty
       FROM ${T.BOX_TABLE}
       WHERE is_deleted = false AND TRIM(box_no_uid::text) = $1
       LIMIT 1`,
      [uid]
    );
    const box = boxRows[0];
    if (!box?.box_uid) throw new Error("Sticker not found.");

    const { rows: linked } = await client.query(
      `SELECT id FROM ${T.TRAY_MASTER} WHERE box_uid = $1 LIMIT 1`,
      [box.box_uid]
    );
    if (!linked.length) throw new Error("This sticker is not on a tray.");

    await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET box_uid = NULL, updated_by = $3, updated_at = NOW()
       WHERE box_uid = $1 AND id <> $2`,
      [box.box_uid, id, createdBy]
    );

    const { rows: saved } = await client.query(
      `UPDATE ${T.TRAY_MASTER}
       SET box_uid = $1, updated_by = $3, updated_at = NOW()
       WHERE id = $2
       RETURNING id AS tray_id`,
      [box.box_uid, id, createdBy]
    );
    if (!saved.length) throw new Error("Tray not found.");

    return {
      box_uid: box.box_uid,
      box_no_uid: box.box_no_uid,
      packing_number: box.packing_number,
      tray_id: saved[0].tray_id,
      qty: box.qty,
    };
  });
}

const DISPATCH_ACC = `CASE WHEN ${TRAY_POOL_EXPR} = 'with_customer' THEN fn.acc_code::text END`;
let registerSeeded = false;

function snapLinks(rows = []) {
  return rows.map((row, idx) => ({
    id: idx + 1,
    box_no_uid: row?.sticker ?? row?.box_no_uid ?? null,
    tray_code: row?.tray ?? row?.tray_code ?? null,
    tray_id: row?.tray_id ?? null,
    box_uid: row?.box_uid ?? null,
    qty: row?.qty ?? null,
  }));
}

function mapRegisterRow(row) {
  if (!row?.data) return null;
  const data = row.data;
  const links = snapLinks(data.links);
  return {
    id: data.packing_number,
    packing_number: data.packing_number,
    item_dcode: data.item_dcode ?? null,
    item_code: data.item_code ?? null,
    acc_code: data.acc_code ?? null,
    acc_name: data.acc_name ?? null,
    box_count: links.length,
    link_count: links.length,
    approved: row.approved !== false,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_by: row.updated_by ?? row.created_by ?? null,
    updated_by_name: row.updated_by ?? row.created_by ?? null,
    updated_at: row.updated_at ?? row.created_at ?? null,
    links,
  };
}

const REGISTER_COLS = `id, data, approved, created_by, created_at, updated_by, updated_at`;

export async function findManageTraySnapshot(packingNumber) {
  const pn = packingKey(packingNumber);
  if (!pn) return null;
  const [row] = await dbQuery(
    `SELECT ${REGISTER_COLS}
     FROM ${T.TRAY_MANAGE}
     WHERE data->>'packing_number' = $1 AND is_deleted = false
     LIMIT 1`,
    [pn]
  );
  return mapRegisterRow(row);
}

export async function saveManageTrayRegister(row, actor = null) {
  const pn = packingKey(row?.packing_number ?? row?.id);
  if (!pn) return null;
  const linked = await dbQuery(
    `SELECT b.box_no_uid AS sticker, t.code AS tray, t.id AS tray_id, b.box_uid, b.qty
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     WHERE ${PN("b")} = $1
     ORDER BY t.id`,
    [pn]
  );
  if (!linked.length) return null;
  const links = linked.map((item) => ({
    sticker: item.sticker,
    tray: item.tray,
    tray_id: item.tray_id,
    box_uid: item.box_uid,
    qty: item.qty,
  }));
  const data = {
    packing_number: pn,
    item_dcode: row?.item_dcode ?? null,
    item_code: row?.item_code ?? null,
    acc_code: row?.acc_code ?? null,
    acc_name: row?.acc_name ?? null,
    links,
  };
  await dbQuery(
    `INSERT INTO ${T.TRAY_MANAGE} (
       data, approved, approved_by, approved_at, created_by, updated_by, updated_at
     )
     VALUES ($1::jsonb, true, $2, NOW(), $2, $2, NOW())
     ON CONFLICT ((data->>'packing_number')) WHERE is_deleted = false DO UPDATE
       SET data = EXCLUDED.data,
           approved = true,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [JSON.stringify(data), actor]
  );
  return { packing_number: pn };
}

export async function deleteManageTrayRegister(packingNumber, actor = null) {
  const pn = packingKey(packingNumber);
  if (!pn) return;
  await dbQuery(
    `UPDATE ${T.TRAY_MANAGE}
     SET is_deleted = true, deleted_by = $2, deleted_at = NOW(), updated_by = $2, updated_at = NOW()
     WHERE is_deleted = false AND data->>'packing_number' = $1`,
    [pn, actor]
  );
}

async function seedRegisterIfEmpty() {
  if (registerSeeded) return;
  registerSeeded = true;
  const [{ n } = { n: 0 }] = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM ${T.TRAY_MANAGE} WHERE COALESCE(is_deleted, false) = false`
  );
  if (Number(n) > 0) return;
  const rows = await dbQuery(
    packingListSql({
      extraWhere: "AND (ba.used_count > 0 OR (ba.open_in_hand = 0 AND ba.link_count > 0 AND ba.link_count >= ba.box_count))",
    })
  );
  for (const row of rows || []) await saveManageTrayRegister(row, row.created_by);
}

async function findRegisteredSnapshots(options = {}) {
  await seedRegisterIfEmpty();
  const { filters = {}, search, sort = {}, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  let i = 1;
  const where = ["TRUE"];
  const viewDays = Math.floor(Number(permission?.can_view_days));
  if (Number.isFinite(viewDays) && viewDays > 0) {
    where.push(`r.created_at::date >= CURRENT_DATE - ${viewDays - 1}`);
  }
  if (filters.from_date) {
    values.push(String(filters.from_date).slice(0, 10));
    where.push(`r.created_at::date >= $${i++}::date`);
  }
  if (filters.to_date) {
    values.push(String(filters.to_date).slice(0, 10));
    where.push(`r.created_at::date <= $${i++}::date`);
  }
  if (filters.id || filters.packing_number) {
    values.push(packingKey(filters.id || filters.packing_number));
    where.push(`r.packing_number = $${i++}`);
  }
  if (filters.item_dcode) {
    values.push(filters.item_dcode);
    where.push(`r.item_dcode = $${i++}`);
  }
  if (search) {
    values.push(`%${String(search).trim()}%`);
    where.push(`(r.packing_number ILIKE $${i} OR r.item_code ILIKE $${i} OR r.acc_name ILIKE $${i})`);
    i++;
  }
  const { safePage, safeLimit, offset } = pageOf(page, limit);
  const sortMap = {
    id: "r.id",
    packing_number: "r.packing_number",
    item_code: "r.item_code",
    acc_name: "r.acc_name",
    created_at: "r.created_at",
    updated_at: "r.updated_at",
    box_count: "r.link_count",
  };
  const sortExpr = sortMap[sort.by] || "r.created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const rows = await dbQuery(
    `SELECT
       r.packing_number AS id, r.packing_number,
       r.item_code, r.acc_name,
       r.link_count AS box_count, r.link_count,
       r.approved,
       r.created_by AS created_by_name, r.created_at,
       r.updated_by, r.updated_by AS updated_by_name, r.updated_at,
       COALESCE(u.used_count, 0) AS used_count,
       COUNT(*) OVER()::int AS _total
     FROM (
       SELECT
         data->>'packing_number' AS packing_number,
         (data->>'item_dcode')::int AS item_dcode,
         data->>'item_code' AS item_code,
         data->>'acc_name' AS acc_name,
         approved, created_by, created_at, updated_by, updated_at,
         jsonb_array_length(COALESCE(data->'links', '[]'::jsonb)) AS link_count
       FROM ${T.TRAY_MANAGE}
       WHERE is_deleted = false AND approved = true
     ) r
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE b.location_id IS NOT NULL OR b.out_uid IS NOT NULL)::int AS used_count
       FROM ${T.BOX_TABLE} b
       WHERE b.is_deleted = false AND ${PN("b")} = r.packing_number
     ) u ON true
     WHERE ${where.join(" AND ")}
     ORDER BY ${sortExpr} ${sortOrder} NULLS LAST
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );
  const total = Number(rows[0]?._total) || 0;
  return {
    data: rows.map(({ _total, ...row }) => row),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}

export async function getManageTrayReportSummary() {
  const [row] = await dbQuery(
    `SELECT
       COUNT(*)::int AS total_count,
       COUNT(*) FILTER (WHERE ${TRAY_POOL_EXPR} = 'vacant')::int AS vacant_count,
       COUNT(*) FILTER (WHERE ${TRAY_POOL_EXPR} = 'in_use')::int AS packing_area_count,
       COUNT(*) FILTER (WHERE ${TRAY_POOL_EXPR} = 'storage')::int AS storage_count,
       COUNT(*) FILTER (WHERE ${TRAY_POOL_EXPR} = 'with_customer')::int AS with_customer_count,
       COUNT(*) FILTER (WHERE ${TRAY_POOL_EXPR} IN ('in_use', 'storage'))::int AS in_use_count
     FROM ${T.TRAY_MASTER} t ${BATCH_JOIN} ${TRAY_OCC_JOIN}
     WHERE ${ACTIVE_TRAY}`
  );
  const customers = await dbQuery(
    `SELECT ${DISPATCH_ACC} AS acc_code, COUNT(*)::int AS count
     FROM ${T.TRAY_MASTER} t ${BATCH_JOIN} ${TRAY_OCC_JOIN} ${BOX_LINK}
     WHERE ${ACTIVE_TRAY} AND ${TRAY_POOL_EXPR} = 'with_customer' AND fn.acc_code IS NOT NULL
     GROUP BY 1
     ORDER BY count DESC, acc_code NULLS LAST`
  );
  return {
    total_count: Number(row?.total_count) || 0,
    vacant_count: Number(row?.vacant_count) || 0,
    packing_area_count: Number(row?.packing_area_count) || 0,
    storage_count: Number(row?.storage_count) || 0,
    with_customer_count: Number(row?.with_customer_count) || 0,
    in_use_count: Number(row?.in_use_count) || 0,
    customers: customers.map((c) => ({ acc_code: c.acc_code, count: Number(c.count) || 0 })),
  };
}

export async function findManageTrayPoolLedger(options = {}) {
  const { search, sort = {}, page = 1, limit = 1000, pool_status, acc_code, unassigned } = options;
  const values = [];
  let i = 1;
  const conditions = [ACTIVE_TRAY];
  const pool = POOL[String(pool_status ?? "").trim().toLowerCase()] || "";
  if (pool === "factory") {
    conditions.push(`${TRAY_POOL_EXPR} IN ('in_use', 'storage')`);
  } else if (pool) {
    values.push(pool);
    conditions.push(`${TRAY_POOL_EXPR} = $${i++}`);
  }
  if (unassigned) {
    conditions.push(`${TRAY_POOL_EXPR} = 'with_customer' AND ${DISPATCH_ACC} IS NULL`);
  } else if (acc_code != null && String(acc_code).trim() !== "" && Number.isFinite(Number(acc_code))) {
    values.push(String(acc_code).trim());
    conditions.push(`${TRAY_POOL_EXPR} = 'with_customer' AND ${DISPATCH_ACC} = $${i++}`);
  }
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim()}%`);
    conditions.push(`(
      t.code ILIKE $${i} OR t.type ILIKE $${i} OR t.batch_id ILIKE $${i}
      OR CONCAT(t.type, t.serial_number)::text ILIKE $${i}
      OR lb.packing_number ILIKE $${i} OR lb.box_no_uid ILIKE $${i}
      OR dp.acc_name ILIKE $${i} OR dp.item_code ILIKE $${i}
    )`);
    i++;
  }

  const fromSql = `FROM ${T.TRAY_MASTER} t ${BATCH_JOIN} ${TRAY_OCC_JOIN} ${BOX_LINK} WHERE ${conditions.join(" AND ")}`;
  const { safePage, safeLimit, offset } = pageOf(page, limit, 2000);
  const sortMap = {
    code: "t.code", type: "t.type", serial_number: "t.serial_number", batch_id: "t.batch_id",
    pool_status: TRAY_POOL_EXPR, packing_number: "lb.packing_number", acc_name: "dp.acc_name",
    item_code: "dp.item_code", created_at: "tb.created_at", updated_at: "t.updated_at", assigned_at: "t.updated_at",
  };
  const sortBy = sortMap[sort.by] || TRAY_POOL_EXPR;
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";
  const rows = await dbQuery(
    `SELECT
       t.id, t.code, t.type, t.serial_number, t.batch_id, t.status,
       ${TRAY_POOL_EXPR} AS pool_status,
       COALESCE(tb.approved, false) AS approved,
       tb.created_at, t.updated_at, tb.created_by AS created_by_name, t.updated_by AS updated_by_name,
       CASE ${TRAY_POOL_EXPR}
         WHEN 'vacant' THEN 'VACANT' WHEN 'in_use' THEN 'PACKING AREA'
         WHEN 'storage' THEN 'STORE IN' WHEN 'with_customer' THEN 'CUSTOMER END'
         ELSE UPPER(${TRAY_POOL_EXPR})
       END AS pool_label,
       lb.packing_number, lb.box_no_uid, lb.qty, t.updated_at AS assigned_at, t.updated_by AS assigned_by_name,
       dp.item_code, dp.acc_code, dp.acc_name, dp.job_card_no, dp.doc_dt,
       ${DISPATCH_ACC} AS dispatch_acc_code,
       COUNT(*) OVER()::int AS _total
     ${fromSql}
     ORDER BY
       CASE ${TRAY_POOL_EXPR} WHEN 'with_customer' THEN 1 WHEN 'in_use' THEN 2 WHEN 'storage' THEN 3 WHEN 'vacant' THEN 4 ELSE 5 END,
       ${sortBy} ${sortOrder} NULLS LAST, t.serial_number ASC
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, safeLimit, offset]
  );
  const total = Number(rows[0]?._total) || 0;
  return {
    data: rows.map(({ _total, ...row }) => row),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}
