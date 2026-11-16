import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { sqlDailyprodDocNoMatch, sqlManageTrayRegistered } from "../../box/utils/inventory/boxInventorySql.js";
import { TRAY_OCC_JOIN, TRAY_POOL_EXPR } from "../../tray/lib/trayOccupancySql.js";
import { TRAY_BATCH_JOIN, TRAY_BATCH_ID_EXPR } from "../../tray/models/trayMaster.model.js";
import { MANAGE_TRAY_ENFORCE_FROM, sqlManageTrayCategoryInList } from "../../../lib/config/manageTray.config.js";
import { snapshotMetadataFromBoxUids } from "../../../lib/utils/erp-api/list/entryListMetadata.js";

const IN_HAND = `b.out_uid IS NULL AND (b.sa_entry_type IS DISTINCT FROM 'stock_out') AND b.qc_hold_id IS NULL`;
const PN = (alias) => `TRIM(${alias ? `${alias}.` : ""}packing_number::text)`;
const DOC = `TRIM(dp.doc_no::text)`;
const TRAY_ENFORCE_BY_PACKING_DATE = `EXISTS (
  SELECT 1
  FROM ${T.DAILYPROD} dpd
  WHERE ${sqlDailyprodDocNoMatch("dpd.doc_no", "b.packing_number")}
    AND dpd.doc_dt >= DATE '${MANAGE_TRAY_ENFORCE_FROM}'
)`;
const CAT_IS_TRAY = (expr) => `LOWER(TRIM(COALESCE(${expr}, ''))) IN (${sqlManageTrayCategoryInList()})`;
const IS_TRAY = `((${CAT_IS_TRAY("dp.category_name")} OR ${CAT_IS_TRAY("c.name")}) AND dp.doc_dt >= DATE '${MANAGE_TRAY_ENFORCE_FROM}')`;
const TRAY_JOINS = `LEFT JOIN ${T.CATEGORY} c ON c.id = dp.category_id`;
const DP_JOIN = sqlDailyprodDocNoMatch("dp.doc_no", "ba.packing_number");
const BATCH_JOIN = TRAY_BATCH_JOIN;
/** IMS Manage Tray = FG trays only (PRD bins belong to Production app). */
const ACTIVE_TRAY = `COALESCE(LOWER(TRIM(t.status)), 'active') = 'active' AND COALESCE(tb.is_deleted, false) = false AND UPPER(TRIM(COALESCE(t.type, ''))) = 'FG'`;
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

/** Pending / list — join boxes only for OEM-tray dailyprod packings (avoids full box-table scan). */
function packingListSql({ onlyInHand = false, extraWhere = "", includeTotal = false, forSinglePacking = false, traySearchParam = null } = {}) {
  const traySearchSql =
    traySearchParam != null
      ? `AND (${DOC} ILIKE $${traySearchParam} OR dp.item_code ILIKE $${traySearchParam} OR dp.acc_name ILIKE $${traySearchParam} OR dp.job_card_no ILIKE $${traySearchParam})`
      : "";

  const stickersCte = forSinglePacking
    ? `stickers AS (
      SELECT
        ${PN("b")} AS packing_number,
        b.created_at,
        b.created_by,
        tl.id AS tray_id,
        tl.updated_at AS linked_at,
        tl.updated_by AS linked_by,
        (${IN_HAND}) AS in_hand,
        (b.location_id IS NOT NULL OR b.out_uid IS NOT NULL) AS used,
        true AS box_is_tray
      FROM ${T.BOX_TABLE} b
      LEFT JOIN ${T.TRAY_MASTER} tl ON tl.box_uid = b.box_uid
      WHERE b.is_deleted = false AND ${PN("b")} = $1
    ),`
    : `tray_packings AS (
      SELECT DISTINCT ${DOC} AS packing_number
      FROM ${T.DAILYPROD} dp
      ${TRAY_JOINS}
      WHERE ${IS_TRAY}
      ${traySearchSql}
    ),
    stickers AS (
      SELECT
        tp.packing_number,
        b.created_at,
        b.created_by,
        tl.id AS tray_id,
        tl.updated_at AS linked_at,
        tl.updated_by AS linked_by,
        (${IN_HAND}) AS in_hand,
        (b.location_id IS NOT NULL OR b.out_uid IS NOT NULL) AS used,
        true AS box_is_tray
      FROM tray_packings tp
      INNER JOIN ${T.BOX_TABLE} b
        ON b.is_deleted = false
       AND ${PN("b")} = tp.packing_number
      LEFT JOIN ${T.TRAY_MASTER} tl ON tl.box_uid = b.box_uid
    ),`;

  return `
    WITH ${stickersCte}
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
       AND NOT ${sqlManageTrayRegistered(PN("b"))}`,
    [list]
  );
  return new Set(rows.map((r) => packingKey(r.pn)));
}

export async function findManageTrays(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 100 } = options;
  const registered = truthy(filters.approved);
  if (registered) return findRegisteredSnapshots({ ...options, permission: options.permission || {} });

  const values = [];
  let i = 1;
  let traySearchParam = null;
  if (search) {
    values.push(`%${String(search).trim()}%`);
    traySearchParam = i++;
  }

  const packingWhere = [`ba.open_in_hand > 0 AND COALESCE(ba.used_count, 0) = 0`];

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

  if (traySearchParam != null) {
    packingWhere.push(
      `(${DOC} ILIKE $${traySearchParam} OR dp.item_code ILIKE $${traySearchParam} OR dp.acc_name ILIKE $${traySearchParam} OR dp.job_card_no ILIKE $${traySearchParam})`
    );
  }

  const { safePage, safeLimit, offset } = pageOf(page, limit);
  const sortExpr = SORT[sort.by] || "ba.created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const rows = await dbQuery(
    `${packingListSql({
      onlyInHand: !registered,
      extraWhere: `AND ${packingWhere.join(" AND ")}`,
      includeTotal: true,
      traySearchParam,
    })}
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
  const [row] = await dbQuery(`${packingListSql({ forSinglePacking: true })} LIMIT 1`, [pn]);
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

/** Add/update links for this submit only — does not clear other stickers on the packing. */
export async function appendManageTrayLinks({ packingNumber, links = [], createdBy = null } = {}) {
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
  if (!uids.length) return [];

  return withTransaction(async (client) => {
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

/** IMS Manage Tray = FG only. */
async function assertImsFgTrayId(trayId) {
  const id = parseInt(String(trayId), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Tray is required.");
  const [row] = await dbQuery(
    `SELECT UPPER(TRIM(COALESCE(type, ''))) AS type FROM ${T.TRAY_MASTER} WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!row) throw new Error("Tray not found.");
  if (row.type === "FG") return id;
  if (row.type === "PRD") throw new Error("This is a PRD tray. Use it in the Production app.");
  throw new Error("Only FG trays can be used in Manage Tray.");
}

export async function receiveTray({ trayId, createdBy = null } = {}) {
  const id = await assertImsFgTrayId(trayId);
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
  if (!uid) throw new Error("Sticker is required.");
  const id = await assertImsFgTrayId(trayId);

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

    const { rows: fromTrayRows } = await client.query(
      `SELECT t.id, t.code FROM ${T.TRAY_MASTER} t WHERE t.box_uid = $1 LIMIT 1`,
      [box.box_uid]
    );
    const fromTray = fromTrayRows[0];
    if (!fromTray) throw new Error("This sticker is not on a tray.");

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
      from_tray_id: fromTray.id,
      from_tray_code: fromTray.code,
      qty: box.qty,
    };
  });
}

/** First-time link: sticker must not already be on a tray. */
export async function assignBoxTray({ boxNoUid, trayId, createdBy = null } = {}) {
  const uid = String(boxNoUid ?? "").trim();
  if (!uid) throw new Error("Sticker is required.");
  const id = await assertImsFgTrayId(trayId);

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
    if (linked.length) throw new Error("This sticker is already on a tray. Use Reassign.");

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

/** Open type slug — not a fixed enum (new ops can add more later). */
function normalizeRegisterType(value, fallback = "assign") {
  let t = String(value ?? "").trim().toLowerCase();
  if (t === "submit" || t === "link") t = "assign";
  if (t) return t;
  return String(fallback ?? "assign").trim().toLowerCase() || "assign";
}

function compactRegisterLinks(links = [], type = "assign") {
  return (Array.isArray(links) ? links : [])
    .map((l) => {
      let sticker = String(l?.sticker ?? l?.s ?? l?.box_no_uid ?? "").trim();
      const tray = String(l?.tray ?? l?.t ?? l?.tray_code ?? "").trim();
      if (type === "receive" && tray && !sticker) sticker = tray;
      if (!sticker || !tray) return null;
      const row = { sticker, tray };
      const pn = packingKey(l?.pn ?? l?.packing_number);
      if (pn) row.pn = pn;
      const qty = l?.qty ?? l?.q;
      if (qty != null && Number.isFinite(Number(qty))) row.qty = Number(qty);
      const from = l?.from ?? l?.from_tray ?? l?.from_tray_code;
      if (from && type === "reassign") row.from = String(from).trim();
      // Receive snapshot — immutable history (who returned the tray).
      if (type === "receive") {
        const acc = l?.acc_code ?? l?.acc;
        if (acc != null && String(acc).trim() !== "") row.acc = Number(acc) || String(acc).trim();
        const cust = l?.acc_name ?? l?.cust;
        if (cust != null && String(cust).trim()) row.cust = String(cust).trim();
        const out = l?.out_uid ?? l?.out;
        if (out != null && String(out).trim() !== "") row.out = String(out).trim();
      }
      return row;
    })
    .filter(Boolean);
}

export function buildTrayManageData(payload = {}) {
  const type = normalizeRegisterType(payload?.type ?? payload?.entry_type, "assign");
  const tray = payload.tray ?? payload.tray_code;
  const remark = payload.remark;
  const links = compactRegisterLinks(payload.links ?? [], type);
  return {
    type,
    links,
    tray: tray ? String(tray).trim() : null,
    remark: remark ? String(remark).trim() : null,
  };
}

function splitPipeField(value) {
  if (value == null || !String(value).trim()) return [];
  return String(value)
    .split(" | ")
    .map((s) => s.trim())
    .filter((s, i, arr) => s !== "" || (arr.length === 1 && s === ""));
}

/** Legacy pipe columns only (pre-migration read). */
function linksFromPipeColumns(row, packingFallback = null) {
  const stickers = splitPipeField(row?.box_no_uids);
  const trays = splitPipeField(row?.tray_codes);
  const qtys = splitPipeField(row?.link_qtys);
  const froms = splitPipeField(row?.from_tray_codes);
  const n = Math.max(stickers.length, trays.length, 0);
  const pn = packingFallback ?? row?.packing_number ?? null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const box_no_uid = stickers[i] ?? null;
    const tray_code = trays[i] ?? null;
    if (!box_no_uid || !tray_code) continue;
    const qtyRaw = qtys[i];
    out.push({
      id: i + 1,
      box_no_uid,
      tray_code,
      packing_number: packingKey(pn),
      qty: qtyRaw !== undefined && qtyRaw !== "" ? Number(qtyRaw) : null,
      from_tray: froms[i] || null,
    });
  }
  return out;
}

/** data JSON: links only — item codes come from box→dailyprod join, not stored. */
function slimRegisterJson(links = []) {
  return { links: Array.isArray(links) ? links : [] };
}

/** Qty from each link; item codes are joined live (not from JSON). */
function displayMetaFromLinks(links = []) {
  const list = Array.isArray(links) ? links : [];
  const qtys = list
    .map((l) => (l?.qty != null && Number.isFinite(Number(l.qty)) ? Number(l.qty) : null))
    .filter((q) => q != null);
  const total = qtys.reduce((sum, q) => sum + q, 0);
  return {
    qtys: qtys.length ? qtys.map(String).join(" | ") : null,
    total_qty: total > 0 ? total : null,
  };
}

/** Item codes for register list — packing_number(s) → dailyprod. */
const REGISTER_ITEM_CODES_SQL = `(
  SELECT NULLIF(string_agg(DISTINCT TRIM(dp.item_code::text), ' | '), '')
  FROM unnest(string_to_array(REPLACE(COALESCE(m.packing_number, ''), ' | ', '|'), '|')) AS part(raw)
  INNER JOIN ${T.DAILYPROD} dp
    ON ${sqlDailyprodDocNoMatch("dp.doc_no", "NULLIF(TRIM(part.raw), '')")}
  WHERE NULLIF(TRIM(part.raw), '') IS NOT NULL
)`;

export async function enrichRegisterLinksWithTrayIds(links = []) {
  const list = Array.isArray(links) ? links : [];
  const codes = [...new Set(list.map((l) => String(l?.tray_code ?? "").trim()).filter(Boolean))];
  if (!codes.length) return list;
  const rows = await dbQuery(
    `SELECT id AS tray_id, TRIM(code::text) AS tray_code
     FROM ${T.TRAY_MASTER}
     WHERE TRIM(code::text) = ANY($1::text[])`,
    [codes]
  );
  const byCode = new Map(rows.map((r) => [String(r.tray_code).trim(), Number(r.tray_id)]));
  return list.map((l) => ({
    ...l,
    tray_id: Number(l?.tray_id) > 0 ? Number(l.tray_id) : byCode.get(String(l?.tray_code ?? "").trim()) ?? null,
  }));
}

function parseRegisterLinks(row) {
  const raw = row?.data;
  const linksRaw = raw?.links ?? (Array.isArray(raw) ? raw : null);
  if (Array.isArray(linksRaw) && linksRaw.length) {
    return linksRaw.map((l, idx) => ({
      id: idx + 1,
      box_no_uid: l?.sticker ?? l?.s ?? l?.box_no_uid ?? null,
      tray_code: l?.tray ?? l?.t ?? l?.tray_code ?? null,
      packing_number: packingKey(l?.pn ?? l?.packing_number) ?? packingKey(row?.packing_number),
      qty: l?.qty ?? l?.q ?? null,
      from_tray: l?.from ?? l?.from_tray ?? l?.from_tray_code ?? null,
      acc_code: l?.acc ?? l?.acc_code ?? null,
      acc_name: l?.cust ?? l?.acc_name ?? null,
      out_uid: l?.out ?? l?.out_uid ?? null,
    })).filter((l) => l.box_no_uid && l.tray_code);
  }
  if (row?.box_no_uids || row?.tray_codes) return linksFromPipeColumns(row);
  return [];
}

/** Same pipe-metadata as Store In — built in SQL from box_no_uid list. */
async function listMetaFromRegisterLinks(links = []) {
  const stickers = (links || [])
    .map((l) => String(l?.sticker ?? l?.box_no_uid ?? "").trim())
    .filter(Boolean);
  if (!stickers.length) return null;
  return snapshotMetadataFromBoxUids(stickers, { includePackingNumbers: true });
}

async function listMetaFromReceiveLinks(links = []) {
  const list = Array.isArray(links) ? links : [];
  const withUid = list.filter((l) => {
    const uid = String(l?.box_no_uid ?? l?.sticker ?? "").trim();
    return uid && uid !== String(l?.tray_code ?? "").trim();
  });
  if (withUid.length) {
    const meta = await listMetaFromRegisterLinks(withUid);
    if (meta?.packing_numbers) return meta;
  }
  const packings = [...new Set(list.map((l) => packingKey(l?.packing_number)).filter(Boolean))];
  const qtys = list.map((l) => (l?.qty != null && Number.isFinite(Number(l.qty)) ? Number(l.qty) : null));
  const total = qtys.reduce((sum, q) => sum + (q ?? 0), 0);
  return {
    packing_numbers: packings.length ? packings.join(" | ") : null,
    item_codes: null,
    qtys: qtys.some((q) => q != null) ? qtys.map((q) => (q != null ? String(q) : "—")).join(" | ") : String(list.length),
    total_qty: total > 0 ? total : list.length,
  };
}

async function insertTrayManageRow({
  type: rowType,
  links = [],
  listMeta = null,
  remark = null,
  approved,
  actor = null,
} = {}) {
  const type = normalizeRegisterType(rowType, "assign");
  const ok = approved === true;
  const packing_number = listMeta?.packing_numbers ?? listMeta?.packing_number ?? null;
  const linkCount = links.length;
  const [saved] = await dbQuery(
    `INSERT INTO ${T.TRAY_MANAGE} (
       type, packing_number, link_count, data, remark,
       approved, approved_by, approved_at, created_by, updated_by, updated_at
     )
     VALUES (
       $1, $2, $3, $4::jsonb, $5,
       $6,
       CASE WHEN $6 THEN $7 ELSE NULL END,
       CASE WHEN $6 THEN NOW() ELSE NULL END,
       $7, $7, NOW()
     )
     RETURNING id`,
    [
      type,
      packing_number,
      linkCount,
      JSON.stringify(slimRegisterJson(links)),
      remark,
      ok,
      actor,
    ]
  );
  return { id: saved?.id, type };
}

function customersFromLinks(links = []) {
  const names = [];
  const codes = [];
  for (const l of links || []) {
    const name = l?.acc_name != null ? String(l.acc_name).trim() : "";
    const code = l?.acc_code != null ? String(l.acc_code).trim() : "";
    if (name && !names.includes(name)) names.push(name);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return {
    acc_name: names.length ? names.join(" | ") : null,
    acc_code: codes.length === 1 ? codes[0] : codes.length ? codes.join(" | ") : null,
  };
}

async function mapRegisterRow(row) {
  if (!row?.id) return null;
  const type = normalizeRegisterType(row.type ?? row.entry_type, "assign");
  const links = parseRegisterLinks(row);
  const link_count = Number(row.link_count) || links.length;
  const meta = displayMetaFromLinks(links);
  const liveMeta = await listMetaFromRegisterLinks(links);
  const item_codes = liveMeta?.item_codes ?? null;
  const cust = customersFromLinks(links);
  return {
    id: row.id,
    register_id: row.id,
    packing_number: row.packing_number ?? null,
    packing_numbers: row.packing_number ?? null,
    item_code: item_codes,
    item_codes,
    qtys: meta.qtys,
    total_qty: meta.total_qty,
    acc_code: cust.acc_code,
    acc_name: cust.acc_name,
    box_count: link_count,
    link_count,
    approved: row.approved === true,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_by: row.updated_by ?? row.created_by ?? null,
    updated_by_name: row.updated_by ?? row.created_by ?? null,
    updated_at: row.updated_at ?? row.created_at ?? null,
    type,
    entry_type: type,
    tray_code: links[0]?.tray_code ?? null,
    remark: row.remark ?? null,
    links,
    is_deleted: row.is_deleted === true,
    deleted_by: row.deleted_by ?? null,
    deleted_at: row.deleted_at ?? null,
  };
}

const REGISTER_COLS = `id, type, packing_number, link_count, data, remark, approved, created_by, created_at, updated_by, updated_at, is_deleted, deleted_by, deleted_at`;

export async function findManageTrayRegisterById(registerId, { includeDeleted = false } = {}) {
  const id = parseInt(String(registerId), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const deletedClause = includeDeleted ? "" : " AND is_deleted = false";
  const [row] = await dbQuery(
    `SELECT ${REGISTER_COLS}
     FROM ${T.TRAY_MANAGE}
     WHERE id = $1${deletedClause}`,
    [id]
  );
  return await mapRegisterRow(row);
}

export async function findManageTraySnapshot(packingNumber) {
  const pn = packingKey(packingNumber);
  if (!pn) return null;
  const [row] = await dbQuery(
    `SELECT ${REGISTER_COLS}
     FROM ${T.TRAY_MANAGE}
     WHERE is_deleted = false
       AND (
         TRIM(COALESCE(packing_number, '')) = $1
         OR packing_number LIKE ($1 || ' |%')
         OR packing_number LIKE ('% | ' || $1)
         OR packing_number LIKE ('% | ' || $1 || ' |%')
       )
     ORDER BY id DESC
     LIMIT 1`,
    [pn]
  );
  return await mapRegisterRow(row);
}

/** One submit → one register row (columns + slim data.links). */
export async function insertManageTrayOpSubmitRegister(
  { type: opType, entry_type: legacyType, links = [], remark = null } = {},
  actor = null
) {
  const kind = normalizeRegisterType(opType ?? legacyType, "assign");
  const built = buildTrayManageData({ type: kind, links, remark });
  const n = built.links.length;
  if (!n) return null;
  const listMeta =
    built.type === "receive" ? await listMetaFromReceiveLinks(links) : await listMetaFromRegisterLinks(built.links);
  let approved = false;
  if (built.type === "receive") {
    approved = true;
  } else if (built.type === "assign") {
    const pn = packingKey(String(listMeta?.packing_numbers ?? "").split(" | ")[0]);
    const live = pn ? await findManageTray({ packing_number: pn }) : null;
    const required = Number(live?.box_count) || 0;
    const totalOnPacking = Number(live?.link_count) || 0;
    approved = required > 0 ? totalOnPacking >= required : n > 0;
  }
  const saved = await insertTrayManageRow({
    type: built.type,
    links: built.links,
    listMeta,
    remark: built.remark,
    approved,
    actor,
  });
  const display = displayMetaFromLinks(built.links);
  return {
    id: saved?.id,
    register_id: saved?.id,
    packing_number: listMeta?.packing_numbers ?? null,
    type: built.type,
    entry_type: built.type,
    approved,
    box_count: n,
    link_count: n,
    item_codes: listMeta?.item_codes ?? null,
    qtys: display.qtys,
    total_qty: display.total_qty ?? 0,
  };
}

/** Packing assign submit → one register row (Store In when packing fully on trays). */
export async function insertManageTrayLinkSubmitRegister(header, submittedLinks = [], actor = null) {
  const pn = packingKey(header?.packing_number ?? header?.id);
  if (!pn) return null;
  const live = await findManageTray({ packing_number: pn });
  const required = Number(header?.box_count) || 0;
  const totalOnPacking = Number(live?.link_count) || 0;
  const normLinks = submittedLinks.map((l) => ({ ...l, packing_number: packingKey(l.packing_number) || pn }));
  const built = buildTrayManageData({
    type: header?.type ?? "assign",
    links: normLinks,
  });
  const n = built.links.length;
  if (!n) return null;
  const approved = required > 0 ? totalOnPacking >= required : n > 0;
  const listMeta = (await listMetaFromRegisterLinks(built.links)) || { packing_numbers: pn };
  if (!listMeta.packing_numbers) listMeta.packing_numbers = pn;
  const saved = await insertTrayManageRow({
    type: built.type,
    links: built.links,
    listMeta,
    approved,
    actor,
  });
  return {
    id: saved?.id,
    register_id: saved?.id,
    packing_number: listMeta.packing_numbers ?? pn,
    type: built.type,
    entry_type: built.type,
    approved,
    box_count: n,
    link_count: n,
  };
}

/** Receive boxes keep out_uid — only store-in (location) blocks edit. */
async function assertReceiveRegisterEditable(links = []) {
  const uids = [...new Set((links || []).map((l) => String(l?.box_no_uid ?? "").trim()).filter(Boolean))];
  if (!uids.length) return;
  const rows = await dbQuery(
    `SELECT TRIM(box_no_uid::text) AS box_no_uid, location_id
     FROM ${T.BOX_TABLE}
     WHERE is_deleted = false AND TRIM(box_no_uid::text) = ANY($1::text[])`,
    [uids]
  );
  for (const b of rows) {
    if (b.location_id != null) {
      throw new Error(`Sticker ${b.box_no_uid} is already stored in. You cannot edit this receive entry.`);
    }
  }
}

async function resolveTrayIdByCode(trayCode) {
  const code = String(trayCode ?? "").trim();
  if (!code) return null;
  const [row] = await dbQuery(
    `SELECT id FROM ${T.TRAY_MASTER} WHERE TRIM(code::text) = $1 LIMIT 1`,
    [code]
  );
  return row?.id != null ? Number(row.id) : null;
}

/** Snapshot customer/out before clearing tray on receive edit add. */
async function snapshotReceiveTrayLink(trayId) {
  const id = parseInt(String(trayId), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [row] = await dbQuery(
    `SELECT t.id AS tray_id, TRIM(t.code::text) AS tray_code,
            TRIM(b.box_no_uid::text) AS box_no_uid, b.box_uid, b.packing_number, b.qty, b.out_uid,
            fn.acc_code
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     LEFT JOIN ${T.OUT_ENTRY} oe ON oe.out_uid = b.out_uid AND COALESCE(oe.is_deleted, false) = false
     LEFT JOIN ${T.FORWARDING_NOTE_MASTER} fn ON fn.fuid = oe.fuid AND COALESCE(fn.is_deleted, false) = false
     WHERE t.id = $1 AND t.box_uid IS NOT NULL AND b.out_uid IS NOT NULL
     LIMIT 1`,
    [id]
  );
  if (!row) return null;
  return {
    tray_id: Number(row.tray_id),
    tray_code: row.tray_code,
    box_no_uid: row.box_no_uid,
    box_uid: row.box_uid,
    packing_number: packingKey(row.packing_number),
    qty: row.qty != null ? Number(row.qty) : null,
    out_uid: row.out_uid != null ? String(row.out_uid).trim() : null,
    acc_code: row.acc_code ?? null,
  };
}

/** Clear sticker from tray when it still matches this register line. */
export async function unassignRegisterLink({ boxNoUid, trayCode = null, actor = null } = {}) {
  const uid = String(boxNoUid ?? "").trim();
  if (!uid) return { cleared: 0 };
  const code = trayCode != null && String(trayCode).trim() ? String(trayCode).trim() : null;
  const { affectedRows } = await dbQuery(
    `UPDATE ${T.TRAY_MASTER} t
     SET box_uid = NULL, updated_by = $3, updated_at = NOW()
     FROM ${T.BOX_TABLE} b
     WHERE b.is_deleted = false
       AND TRIM(b.box_no_uid::text) = $1
       AND t.box_uid = b.box_uid
       AND ($2::text IS NULL OR t.code = $2)`,
    [uid, code, actor]
  );
  return { cleared: affectedRows || 0 };
}

/** Edit one register entry: reconcile live trays, then update the row (not a new insert). */
export async function updateManageTrayRegisterEntry(registerId, { links: rawLinks = [] } = {}, actor = null) {
  const id = parseInt(String(registerId), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const snap = await findManageTrayRegisterById(id);
  if (!snap) return null;
  const kind = normalizeRegisterType(snap.type ?? snap.entry_type, "assign");

  const norm = [];
  for (const row of rawLinks || []) {
    const box_no_uid = String(row?.box_no_uid ?? "").trim();
    const tray_code = String(row?.tray_code ?? "").trim() || null;
    let tray_id = parseInt(String(row?.tray_id), 10);
    if ((!Number.isFinite(tray_id) || tray_id <= 0) && tray_code) {
      tray_id = await resolveTrayIdByCode(tray_code);
    }
    if (!box_no_uid || !tray_code || !Number.isFinite(tray_id) || tray_id <= 0) continue;
    norm.push({
      box_no_uid,
      tray_id,
      tray_code,
      packing_number: packingKey(row?.packing_number) || packingKey(snap.packing_number),
      qty: row?.qty != null ? Number(row.qty) : null,
      from_tray_code: row?.from_tray ?? row?.from_tray_code ?? null,
      acc_code: row?.acc_code ?? row?.acc ?? null,
      acc_name: row?.acc_name ?? row?.cust ?? null,
      out_uid: row?.out_uid ?? row?.out ?? null,
    });
  }

  if (!norm.length) throw new Error("Keep at least one sticker and tray, or delete the register entry.");

  const oldLinks = Array.isArray(snap.links) ? snap.links : [];
  // Register edit is allowed for any entry type (permission-gated in API).
  // Receive: only store-in blocks. Assign/reassign: live tray ops enforce per sticker.
  if (kind === "receive") {
    await assertReceiveRegisterEditable([...oldLinks, ...norm]);
  }

  const oldByUid = new Map(oldLinks.map((l) => [String(l.box_no_uid).trim(), l]));
  const newByUid = new Map(norm.map((l) => [l.box_no_uid, l]));
  const finalLinks = [];

  if (kind === "receive") {
    for (const [uid, old] of oldByUid) {
      if (!newByUid.has(uid)) {
        await undoReceiveRegisterLinks([old], actor);
      }
    }
    for (const [uid, neu] of newByUid) {
      const old = oldByUid.get(uid);
      if (!old) {
        let snapLine = {
          acc_code: neu.acc_code,
          acc_name: neu.acc_name,
          out_uid: neu.out_uid,
          packing_number: neu.packing_number,
          qty: neu.qty,
        };
        if (snapLine.out_uid == null || snapLine.acc_code == null) {
          const liveSnap = await snapshotReceiveTrayLink(neu.tray_id);
          if (!liveSnap) throw new Error(`Tray ${neu.tray_code} is not ready to receive.`);
          snapLine = {
            acc_code: snapLine.acc_code ?? liveSnap.acc_code,
            acc_name: snapLine.acc_name,
            out_uid: snapLine.out_uid ?? liveSnap.out_uid,
            packing_number: snapLine.packing_number || liveSnap.packing_number,
            qty: snapLine.qty ?? liveSnap.qty,
            box_no_uid: liveSnap.box_no_uid,
          };
          if (liveSnap.box_no_uid && liveSnap.box_no_uid !== uid) {
            throw new Error(`Tray ${neu.tray_code} sticker mismatch.`);
          }
        }
        await receiveTray({ trayId: neu.tray_id, createdBy: actor });
        finalLinks.push({
          ...neu,
          packing_number: snapLine.packing_number || neu.packing_number,
          qty: snapLine.qty ?? neu.qty,
          acc_code: snapLine.acc_code ?? neu.acc_code,
          acc_name: snapLine.acc_name ?? neu.acc_name,
          out_uid: snapLine.out_uid ?? neu.out_uid,
        });
        continue;
      }
      finalLinks.push({
        ...neu,
        packing_number: neu.packing_number || packingKey(old.packing_number),
        qty: neu.qty ?? old.qty ?? null,
        acc_code: neu.acc_code ?? old.acc_code ?? null,
        acc_name: neu.acc_name ?? old.acc_name ?? null,
        out_uid: neu.out_uid ?? old.out_uid ?? null,
      });
    }
  } else {
    for (const [uid, old] of oldByUid) {
      if (!newByUid.has(uid)) {
        await unassignRegisterLink({ boxNoUid: uid, trayCode: old.tray_code, actor });
      }
    }

    for (const [uid, neu] of newByUid) {
      const old = oldByUid.get(uid);
      const trayChanged = !old || old.tray_code !== neu.tray_code || Number(old.tray_id) !== neu.tray_id;
      if (!old) {
        if (kind === "reassign") {
          await reassignBoxTray({ boxNoUid: uid, trayId: neu.tray_id, createdBy: actor });
        } else {
          await assignBoxTray({ boxNoUid: uid, trayId: neu.tray_id, createdBy: actor });
        }
      } else if (trayChanged) {
        await reassignBoxTray({ boxNoUid: uid, trayId: neu.tray_id, createdBy: actor });
      }
      finalLinks.push({
        ...neu,
        from_tray_code: neu.from_tray_code ?? old?.from_tray ?? old?.from_tray_code ?? null,
      });
    }
  }

  const built = buildTrayManageData({ type: kind, links: finalLinks });
  const listMeta =
    (kind === "receive"
      ? await listMetaFromReceiveLinks(finalLinks)
      : await listMetaFromRegisterLinks(built.links)) || {
      packing_numbers: packingKey(snap.packing_number),
    };
  if (kind === "receive" && !listMeta.packing_numbers) {
    const pns = [...new Set(finalLinks.map((l) => packingKey(l.packing_number)).filter(Boolean))];
    listMeta.packing_numbers = pns.join(" | ") || packingKey(snap.packing_number);
  }
  const n = built.links.length;
  let approved = Boolean(snap.approved);
  if (kind === "assign") {
    const pn = packingKey(listMeta.packing_numbers ?? snap.packing_number);
    const live = pn ? await findManageTray({ packing_number: pn }) : null;
    const required = Number(live?.box_count) || 0;
    const totalOnPacking = Number(live?.link_count) || 0;
    approved = required > 0 ? totalOnPacking >= required : n > 0;
  } else if (kind === "receive") {
    approved = true;
  } else {
    approved = false;
  }

  await dbQuery(
    `UPDATE ${T.TRAY_MANAGE}
     SET packing_number = $2, link_count = $3,
         data = $4::jsonb, approved = $5,
         approved_by = CASE WHEN $5 THEN $6 ELSE NULL END,
         approved_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
         updated_by = $6, updated_at = NOW()
     WHERE id = $1 AND is_deleted = false`,
    [
      id,
      listMeta.packing_numbers ?? listMeta.packing_number ?? snap.packing_number,
      n,
      JSON.stringify(slimRegisterJson(built.links)),
      approved,
      actor,
    ]
  );

  return findManageTrayRegisterById(id);
}

/**
 * Undo a receive: put each box back on its tray (customer-end link).
 * Only restores when tray is still vacant and box still has out_uid / not on another tray.
 */
async function undoReceiveRegisterLinks(links = [], actor = null) {
  const list = Array.isArray(links) ? links : [];
  let restored = 0;
  for (const link of list) {
    const trayCode = String(link?.tray_code ?? "").trim();
    const boxNoUid = String(link?.box_no_uid ?? "").trim();
    if (!trayCode || !boxNoUid || boxNoUid === trayCode) continue;

    const [box] = await dbQuery(
      `SELECT box_uid, TRIM(box_no_uid::text) AS box_no_uid, out_uid
       FROM ${T.BOX_TABLE}
       WHERE is_deleted = false AND TRIM(box_no_uid::text) = $1
       LIMIT 1`,
      [boxNoUid]
    );
    if (!box?.box_uid) continue;
    if (box.out_uid == null || String(box.out_uid).trim() === "") continue;

    const [onOther] = await dbQuery(
      `SELECT id, code FROM ${T.TRAY_MASTER}
       WHERE box_uid = $1 AND TRIM(code::text) <> $2
       LIMIT 1`,
      [box.box_uid, trayCode]
    );
    if (onOther) continue;

    const { affectedRows } = await dbQuery(
      `UPDATE ${T.TRAY_MASTER} t
       SET box_uid = $2, updated_by = $3, updated_at = NOW()
       WHERE TRIM(t.code::text) = $1
         AND t.box_uid IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${T.TRAY_MASTER} x
           WHERE x.box_uid = $2 AND x.id <> t.id
         )`,
      [trayCode, box.box_uid, actor]
    );
    if (affectedRows) restored += 1;
  }
  return restored;
}

/** Soft-delete register. Receive entries also restore tray↔box customer-end links. */
export async function deleteManageTrayRegisterEntry(registerId, actor = null) {
  const id = parseInt(String(registerId), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const snap = await findManageTrayRegisterById(id);
  if (!snap) {
    const [gone] = await dbQuery(
      `SELECT id, packing_number, type FROM ${T.TRAY_MANAGE}
       WHERE id = $1 AND COALESCE(is_deleted, false) = true`,
      [id]
    );
    return gone ?? null;
  }

  const kind = normalizeRegisterType(snap.type ?? snap.entry_type, "assign");
  let restored = 0;
  if (kind === "receive") {
    restored = await undoReceiveRegisterLinks(snap.links, actor);
  }

  const [row] = await dbQuery(
    `UPDATE ${T.TRAY_MANAGE}
     SET is_deleted = true, deleted_by = $2, deleted_at = NOW(), updated_by = $2, updated_at = NOW()
     WHERE id = $1 AND COALESCE(is_deleted, false) = false
     RETURNING id, packing_number, type`,
    [id, actor]
  );
  return row ? { ...row, restored } : null;
}

async function findRegisteredSnapshots(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  let i = 1;
  const where = ["TRUE"];
  const hasDateRange = Boolean(filters.from_date || filters.to_date);
  const viewDays = Math.floor(Number(permission?.can_view_days));
  if (!hasDateRange && Number.isFinite(viewDays) && viewDays > 0) {
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
  if (filters.id || filters.register_id) {
    const rid = parseInt(String(filters.id ?? filters.register_id), 10);
    if (Number.isFinite(rid) && rid > 0) {
      values.push(rid);
      where.push(`r.id = $${i++}`);
    }
  } else if (filters.packing_number) {
    values.push(packingKey(filters.packing_number));
    where.push(`r.packing_number = $${i++}`);
  }
  const typeFilter = String(filters.type ?? "").trim().toLowerCase();
  if (typeFilter) {
    if (typeFilter === "assign") {
      where.push(`LOWER(r.type) = 'assign'`);
    } else {
      values.push(typeFilter);
      where.push(`LOWER(r.type) = $${i++}`);
    }
  }
  if (search) {
    values.push(`%${String(search).trim()}%`);
    where.push(
      `(r.packing_number ILIKE $${i} OR r.item_code ILIKE $${i} OR r.acc_name ILIKE $${i} OR r.id::text ILIKE $${i} OR r.type ILIKE $${i})`,
    );
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
    type: "r.type",
    entry_type: "r.type",
  };
  const sortExpr = sortMap[sort.by] || "r.created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  const rows = await dbQuery(
    `SELECT
       r.id, r.id AS register_id, r.packing_number,
       r.type, r.type AS entry_type, r.tray_code,
       r.item_code, r.item_code AS item_codes, r.qtys, r.total_qty,
       r.acc_name, r.acc_code,
       r.box_count, r.link_count,
       r.approved,
       r.created_by AS created_by_name, r.created_at,
       r.updated_by, r.updated_by AS updated_by_name, r.updated_at,
       r.is_deleted,
       r.deleted_by,
       r.deleted_at,
       COALESCE(u.used_count, 0) AS used_count,
       COUNT(*) OVER()::int AS _total
     FROM (
       SELECT
         m.id,
         LOWER(COALESCE(NULLIF(TRIM(m.type), ''), 'assign')) AS type,
         NULLIF(TRIM(m.packing_number), '') AS packing_number,
         (
           SELECT NULLIF(TRIM(COALESCE(x->>'tray', x->>'t', '')), '')
           FROM jsonb_array_elements(COALESCE(m.data->'links', '[]'::jsonb)) x
           WHERE NULLIF(TRIM(COALESCE(x->>'tray', x->>'t', '')), '') IS NOT NULL
           LIMIT 1
         ) AS tray_code,
         ${REGISTER_ITEM_CODES_SQL} AS item_code,
         NULL AS qtys,
         0 AS total_qty,
         (
           SELECT string_agg(DISTINCT v, ' | ')
           FROM (
             SELECT NULLIF(TRIM(x->>'cust'), '') AS v
             FROM jsonb_array_elements(COALESCE(m.data->'links', '[]'::jsonb)) x
           ) s
           WHERE v IS NOT NULL
         ) AS acc_name,
         (
           SELECT NULLIF(TRIM(x->>'acc'), '')
           FROM jsonb_array_elements(COALESCE(m.data->'links', '[]'::jsonb)) x
           WHERE NULLIF(TRIM(x->>'acc'), '') IS NOT NULL
           LIMIT 1
         ) AS acc_code,
         m.approved, m.created_by, m.created_at, m.updated_by, m.updated_at,
         COALESCE(m.is_deleted, false) AS is_deleted,
         m.deleted_by,
         m.deleted_at,
         COALESCE(m.link_count, 0) AS box_count,
         COALESCE(m.link_count, 0) AS link_count
       FROM ${T.TRAY_MANAGE} m
       WHERE COALESCE(m.is_deleted, false) = false
     ) r
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (
         WHERE b.location_id IS NOT NULL
            OR (r.type IS DISTINCT FROM 'receive' AND b.out_uid IS NOT NULL)
       )::int AS used_count
       FROM ${T.BOX_TABLE} b
       WHERE b.is_deleted = false
         AND NULLIF(TRIM(b.packing_number::text), '') = ANY (
           SELECT NULLIF(TRIM(part), '')
           FROM unnest(string_to_array(REPLACE(COALESCE(r.packing_number, ''), ' | ', '|'), '|')) AS part
           WHERE NULLIF(TRIM(part), '') IS NOT NULL
         )
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
      t.code ILIKE $${i} OR t.type ILIKE $${i} OR tb.batch_id ILIKE $${i}
      OR CONCAT(t.type, t.serial_number)::text ILIKE $${i}
      OR lb.packing_number ILIKE $${i} OR lb.box_no_uid ILIKE $${i}
      OR dp.acc_name ILIKE $${i} OR dp.item_code ILIKE $${i}
    )`);
    i++;
  }

  const fromSql = `FROM ${T.TRAY_MASTER} t ${BATCH_JOIN} ${TRAY_OCC_JOIN} ${BOX_LINK} WHERE ${conditions.join(" AND ")}`;
  const { safePage, safeLimit, offset } = pageOf(page, limit, 2000);
  const sortMap = {
    code: "t.code", type: "t.type", serial_number: "t.serial_number", batch_id: "tb.batch_id",
    pool_status: TRAY_POOL_EXPR, packing_number: "lb.packing_number", acc_name: "dp.acc_name",
    item_code: "dp.item_code", created_at: "tb.created_at", updated_at: "t.updated_at", assigned_at: "t.updated_at",
  };
  const sortBy = sortMap[sort.by] || TRAY_POOL_EXPR;
  const sortOrder = sort.order === "DESC" ? "DESC" : "ASC";
  const rows = await dbQuery(
    `SELECT
       t.id, t.code, t.type, t.serial_number, ${TRAY_BATCH_ID_EXPR}, t.status,
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
