import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { BOX_TX_TYPES } from "../constants/boxTransactionTypes.js";
import { logBoxTransaction, logBoxTransactionSafe, singlePackingFromRows } from "../utils/logBoxTransaction.js";
import { sqlBoxInHand, sqlBoxOutUidEmpty, sqlBoxCustomerCode, sqlDailyprodLateralForBox } from "../utils/boxInventorySql.js";


const ALLOWED_FILTER_FIELDS_BOX = [
  "box_uid",
  "box_no_uid",
  "packing_number",
  "sa_id",
  "location_id",
  "from_date",
  "to_date",
  "override_cust",
  "in_uid",
  "out_uid",
];

const ALLOWED_SORT_FIELDS_BOX = ["created_at", "qty", "box_no_uid", "packing_number", "rack_no", "acc_name"];

const ALLOWED_UPDATE_FIELDS_BOX = ["box_no_uid", "packing_number", "qty", "override_cust", "location_id", "in_uid", "out_uid", "updated_by", "updated_at"];

/** `sa_entry_type` must match `ims_box_table` CHECK: 'stock_in' | 'stock_out'. */
function normalizeSaEntryTypeForInsert(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "stock_in" || s === "stock_out") return s;
  return null;
}

const JOINS = `
  LEFT JOIN ims_dailyprod dp        ON b.packing_number::TEXT = dp.doc_no::TEXT
  LEFT JOIN ims_location_master lm  ON b.location_id          = lm.location_id
  LEFT JOIN ims_inventory_inwards ii ON b.in_uid::TEXT        = ii.in_uid::TEXT
  LEFT JOIN ims_out_entry io        ON b.out_uid::TEXT        = io.out_uid::TEXT
  
  LEFT JOIN ${M.USERS} u_cr    ON b.created_by  = u_cr.id
  LEFT JOIN ${M.USERS} u_upd   ON b.updated_by  = u_upd.id
  LEFT JOIN ${M.USERS} u_dl    ON b.deleted_by  = u_dl.id
`;

// Bare field names passed to findBoxes() are prefixed with b.; these live on joins instead.
const FIND_BOXES_JOINED_SELECT = {
  acc_name: "b.override_cust::text AS acc_name",
  rack_no: "lm.rack_no"
};

const DEFAULT_FIELDS_BOX = [
  "b.*",
  "lm.*",
  "b.override_cust::text AS acc_name",
  "ii.in_uid AS inward_ref",
  "io.out_uid AS outward_ref",
  "dp.doc_no AS prod_doc_no",
  "u_cr.name AS created_by_name",
  "u_upd.name AS updated_by_name"
];

function isExactBoxScanLookup(filters = {}, limit = 10) {
  const keys = Object.keys(filters).filter(
    (k) => filters[k] !== undefined && filters[k] !== null && String(filters[k]).trim() !== ""
  );
  if (keys.length !== 1) return false;
  const only = keys[0];
  if (only !== "box_no_uid" && only !== "box_uid") return false;
  return Number(limit) <= 5;
}

export const findBoxes = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10, fields = [], permission = {}, skipCount = false } = options;

  const values = [];
  let i = 1;

  const conditions = ["b.is_deleted = false"];
  /** When listing by stock-adjustment id, include minus (`stock_out`) rows linked to that adjustment. */
  const filterBySaId =
    filters.sa_id !== undefined && filters.sa_id !== null && String(filters.sa_id).trim() !== "";
  if (!filterBySaId) {
    conditions.push("(b.sa_entry_type IS DISTINCT FROM 'stock_out')");
  }

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`b.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  // SAFE FILTERS
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    // DATE FILTERS
    if (key === "from_date") {
      values.push(val);
      conditions.push(`b.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`b.created_at <= $${i++}`);
      continue;
    }

    // NORMAL FILTERS (SAFE)
    if (!ALLOWED_FILTER_FIELDS_BOX.includes(key)) continue;

    values.push(String(val));
    conditions.push(`b.${key}::TEXT = $${i++}::TEXT`);
  }

  // SEARCH
  if (search) {
    const searchIndex = i;
    const searchTerm = `%${search}%`;
    values.push(searchTerm);

    conditions.push(`(
      b.box_no_uid::TEXT ILIKE $${searchIndex} OR
      b.packing_number::TEXT ILIKE $${searchIndex} OR
      b.qty::TEXT ILIKE $${searchIndex} OR
      b.override_cust::TEXT ILIKE $${searchIndex} OR
      lm.rack_no ILIKE $${searchIndex}
    )`);
    i++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const skipCountQuery = skipCount || (!search && isExactBoxScanLookup(filters, limit));
  let totalCount = 0;
  if (!skipCountQuery) {
    const countRes = await dbQuery(`SELECT COUNT(DISTINCT b.box_uid) AS count FROM ims_box_table b ${JOINS} ${whereClause}`, values);
    totalCount = Number(countRes[0]?.count || 0);
  }

  // PAGINATION & SORTING CONFIG
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortByField = ALLOWED_SORT_FIELDS_BOX.includes(sort.by) ? sort.by : "created_at";
  const sortOrder = sort.order === "ASC" ? "ASC" : "DESC";
  
  // --- SWITCH CASE FOR ORDER BY ---
  let orderByClause;
  switch (sortByField) {
    case "rack_no":
      orderByClause = "lm.rack_no";
      break;
    case "acc_name":
      orderByClause = "b.override_cust::text";
      break;
    case "box_no_uid":
      orderByClause = "b.box_no_uid";
      break;
    case "packing_number":
      orderByClause = "b.packing_number";
      break;
    case "qty":
      orderByClause = "b.qty";
      break;
    case "box_uid":
      orderByClause = "b.box_uid";
      break;
    default:
      orderByClause = "b.created_at";
  }

  // MAIN DATA QUERY
  const selectFields = fields.length > 0 
    ? fields.map(f => {
        if (f.includes(".")) return f;
        const lower = f.toLowerCase();
        // "col AS alias" must still qualify "col" otherwise joins (e.g. ims_dailyprod) make names like packing_number ambiguous
        if (lower.includes(" as ")) {
          const m = f.match(/^(.+?)\s+AS\s+(.+)$/i);
          if (m) {
            const lhs = m[1].trim();
            const rhs = m[2].trim();
            if (lhs.includes(".")) return f;
            const qualified = FIND_BOXES_JOINED_SELECT[lhs] || `b.${lhs}`;
            return `${qualified} AS ${rhs}`;
          }
        }
        const bare = f.trim();
        if (FIND_BOXES_JOINED_SELECT[bare]) return FIND_BOXES_JOINED_SELECT[bare];
        return `b.${f}`;
      }).join(", ") 
    : DEFAULT_FIELDS_BOX.join(", ");

  const limitIdx = i++;
  const offsetIdx = i++;
  values.push(safeLimit, offset);

  const rows = await dbQuery(
    `SELECT ${selectFields}
     FROM ims_box_table b
     ${JOINS}
     ${whereClause}
     ORDER BY ${orderByClause} ${sortOrder} 
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  const rowCount = rows.length;
  const resolvedTotal = skipCountQuery ? rowCount : totalCount;

  return {
    data: rows,
    total: resolvedTotal,
    page: safePage,
    limit: safeLimit,
    totalPages: skipCountQuery ? (rowCount > 0 ? 1 : 0) : Math.ceil(totalCount / safeLimit)
  };
};

/** Batch resolve in-hand boxes by scan code (box_no_uid and/or numeric box_uid). */
export const findInHandBoxesByScanCodes = async (scanCodes = []) => {
  const raw = [...new Set((scanCodes || []).map((c) => String(c).trim()).filter(Boolean))];
  if (!raw.length) return [];

  const numericOnly = raw.filter((c) => /^\d+$/.test(c));

  return dbQuery(
    `SELECT b.box_uid, b.box_no_uid, b.packing_number, b.qty
     FROM ims_box_table b
     WHERE b.is_deleted = false
       AND ${sqlBoxInHand("b")}
       AND (
         b.box_no_uid::text = ANY($1::text[])
         OR (cardinality($2::text[]) > 0 AND b.box_uid::text = ANY($2::text[]))
       )`,
    [raw, numericOnly]
  );
};

/** Lookup by scan code without in-hand filter (clearer inward batch-scan errors). */
export const findBoxesByScanCodesAny = async (scanCodes = []) => {
  const raw = [...new Set((scanCodes || []).map((c) => String(c).trim()).filter(Boolean))];
  if (!raw.length) return [];

  const numericOnly = raw.filter((c) => /^\d+$/.test(c));

  return dbQuery(
    `SELECT b.box_uid, b.box_no_uid, b.packing_number, b.qty, b.out_uid, b.sa_entry_type, b.is_deleted
     FROM ims_box_table b
     WHERE b.is_deleted = false
       AND (
         b.box_no_uid::text = ANY($1::text[])
         OR (cardinality($2::text[]) > 0 AND b.box_uid::text = ANY($2::text[]))
       )`,
    [raw, numericOnly]
  );
};

/** Why an inward scan did not match {@link findInHandBoxesByScanCodes}. */
export function inwardScanRejectMessage(row) {
  if (!row || row.is_deleted) return "Box not found";
  if (row.sa_entry_type === "stock_out") {
    return "Box removed via stock adjustment and cannot be stored inward";
  }
  const outEmpty =
    row.out_uid == null || String(row.out_uid).trim() === "";
  if (!outEmpty) {
    return "Box is already outward (Store Out) and cannot be stored inward";
  }
  return "Box not found or not eligible for inward";
}

/** Map one scan code to a row from {@link findInHandBoxesByScanCodes}. */
export function matchBoxRowByScanCode(rows, scanCode) {
  const val = scanCode != null ? String(scanCode).trim() : "";
  if (!val || !Array.isArray(rows)) return null;
  const tryUid = /^\d+$/.test(val);
  for (const row of rows) {
    if (String(row.box_no_uid ?? "").trim() === val) return row;
    if (tryUid && String(row.box_uid ?? "").trim() === val) return row;
  }
  return null;
}

/** Single round-trip lookup by numeric box_uid and/or box_no_uid (QR scan hot path). */
export const findBoxByUidOrNoUid = async (id) => {
  const val = id != null ? String(id).trim() : "";
  if (!val) return null;
  const tryUid = /^\d+$/.test(val);
  const [row] = await dbQuery(
    `SELECT b.*, b.override_cust::text AS acc_name
     FROM ims_box_table b
     WHERE b.is_deleted = false
       AND (
         b.box_no_uid::text = $1::text
         OR ($2::boolean AND b.box_uid::text = $1::text)
       )
     LIMIT 1`,
    [val, tryUid]
  );
  return row || null;
};

/** Sticker / QR scan: `box_no_uid` first, then numeric `box_uid` (external URL). */
export const findBoxByStickerScan = async ({ box_no_uid, box_uid } = {}) => {
  const noUid = box_no_uid != null ? String(box_no_uid).trim() : "";
  const uidRaw = box_uid != null ? String(box_uid).trim() : "";
  const uid = /^\d+$/.test(uidRaw) ? uidRaw : "";

  if (noUid) {
    const row = await findBoxByUidOrNoUid(noUid);
    if (row) return row;
  }
  if (uid) {
    const [row] = await dbQuery(
      `SELECT b.*, b.override_cust::text AS acc_name
       FROM ims_box_table b
       WHERE b.is_deleted = false AND b.box_uid::text = $1::text
       LIMIT 1`,
      [uid]
    );
    if (row) return row;
  }
  return null;
};

export const findBox = async (filters = {}) => {
  const keys = Object.keys(filters);
  const values = Object.values(filters);

  if (!keys.length) return null;

  const where = keys.map((k, i) => `b.${k} = $${i + 1}`).join(" AND ");

  const [row] = await dbQuery(
    `SELECT b.*, b.override_cust::text AS acc_name
     FROM ims_box_table b
     WHERE ${where} AND b.is_deleted = false
     LIMIT 1`,
    values
  );

  return row || null;
};

export const findBoxesByPackingNumber = async (packing_number) => {
  return await dbQuery(
    `SELECT b.*
     FROM ims_box_table b
     WHERE b.packing_number::text = $1::text
       AND b.is_deleted = false
       AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')
     ORDER BY b.box_uid ASC`,
    [String(packing_number)]
  );
};

/** Resolve production acc/item when the list-view join did not attach `ims_dailyprod` columns. */
export const findDailyProdByDocNo = async (doc_no) => {
  if (doc_no == null || String(doc_no).trim() === "") return null;
  const [row] = await dbQuery(
    `SELECT acc_code, job_card_no, item_dcode AS itemdcode, doc_dt
     FROM ims_dailyprod
     WHERE doc_no::text = trim($1::text)
     LIMIT 1`,
    [String(doc_no)]
  );
  return row ?? null;
};

const IN_HAND_BOX_SELECT_SQL = `
       b.box_uid,
       b.box_no_uid,
       b.packing_number,
       b.qty,
       b.is_loose,
       b.override_cust,
       b.location_id,
       b.in_uid,
       b.out_uid,
       b.sa_id,
       b.sa_entry_type,
       b.override_cust::text AS acc_name,
       lm.rack_no,
       lm.shelf_no,
       COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '-')))) AS location_no`;

/** Match packing on column and on SA box_no_uid (`{pn}_SA{id}_…`). */
function sqlPackingNumberMatch(alias, paramRef) {
  return `(
    trim(${alias}.packing_number::text) = trim(${paramRef}::text)
    OR (
      nullif(trim(${alias}.packing_number::text), '-') ~ '^[0-9]+$'
      AND nullif(trim(${paramRef}::text), '-') ~ '^[0-9]+$'
      AND trim(${alias}.packing_number::text)::numeric = trim(${paramRef}::text)::numeric
    )
  )`;
}

function sqlSaBoxNoUidMatchesPacking(paramRef) {
  return `position(('_' || trim(${paramRef}::text) || '_SA') IN b.box_no_uid::text) > 0`;
}

function parseItemDcodeId(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Minus adjustment item — from selected boxes / linked SA / in-hand stock at packing.
 * Does not require `ims_dailyprod` (SA-only or legacy inventory is valid).
 */
export const resolveItemDcodeForMinusAdjustment = async ({ packing_number, boxRows = [] }) => {
  for (const r of boxRows) {
    const id = parseItemDcodeId(r.itemdcode);
    if (id) return id;
  }

  const saIds = [
    ...new Set(
      (boxRows || [])
        .map((r) => Number(r.sa_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (saIds.length) {
    const [linked] = await dbQuery(
      `SELECT item_dcode AS itemdcode
       FROM ims_stock_adjustment
       WHERE adjustment_id = ANY($1::int[])
         AND is_deleted = false
         AND item_dcode IS NOT NULL
       ORDER BY adjustment_id DESC
       LIMIT 1`,
      [saIds]
    );
    const fromLinked = parseItemDcodeId(linked?.itemdcode);
    if (fromLinked) return fromLinked;
  }

  const pn = packing_number != null ? String(packing_number).trim() : "";
  if (!pn) return null;

  const [saAdd] = await dbQuery(
    `SELECT item_dcode AS itemdcode
     FROM ims_stock_adjustment
     WHERE trim(packing_number::text) = trim($1::text)
       AND entry_type = 'add'
       AND is_deleted = false
       AND item_dcode IS NOT NULL
     ORDER BY adjustment_id DESC
     LIMIT 1`,
    [pn]
  );
  const fromSaAdd = parseItemDcodeId(saAdd?.itemdcode);
  if (fromSaAdd) return fromSaAdd;

  const belongsToPacking = `(
    ${sqlPackingNumberMatch("b", "$1")}
    OR (
      b.sa_entry_type = 'stock_in'
      AND b.sa_id IS NOT NULL
      AND ${sqlSaBoxNoUidMatchesPacking("$1")}
    )
  )`;

  const [inv] = await dbQuery(
    `SELECT (
       CASE
         WHEN sa_adj.item_dcode IS NOT NULL THEN sa_adj.item_dcode
         ELSE dp.item_dcode
       END
     ) AS itemdcode
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
     LEFT JOIN ims_stock_adjustment sa_adj
       ON b.sa_id = sa_adj.adjustment_id
      AND sa_adj.is_deleted = false
     WHERE b.is_deleted = false
       AND ${belongsToPacking}
       AND ${sqlBoxInHand("b")}
       AND (
         sa_adj.item_dcode IS NOT NULL
         OR dp.item_dcode IS NOT NULL
       )
     ORDER BY b.box_uid ASC
     LIMIT 1`,
    [pn]
  );
  return parseItemDcodeId(inv?.itemdcode);
};

/**
 * Stock adjustment minus drawer: production in-hand + SA add (stock_in) + optional this adj's stock_out.
 */
export const findStockAdjustmentMinusBoxesByPacking = async (packing_number, adjustment_id = null) => {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return [];
  const adjId = Number(adjustment_id);
  const hasAdj = Number.isFinite(adjId) && adjId > 0;

  const values = [pn];
  let removedOr = "";
  if (hasAdj) {
    values.push(adjId);
    removedOr = `
      OR (
        b.sa_id = $2::integer
        AND b.sa_entry_type = 'stock_out'
        AND (
          ${sqlPackingNumberMatch("b", "$1")}
          OR ${sqlSaBoxNoUidMatchesPacking("$1")}
        )
      )`;
  }

  const belongsToPacking = `(
    ${sqlPackingNumberMatch("b", "$1")}
    OR (
      b.sa_entry_type = 'stock_in'
      AND b.sa_id IS NOT NULL
      AND ${sqlSaBoxNoUidMatchesPacking("$1")}
    )
  )`;

  return dbQuery(
    `SELECT ${IN_HAND_BOX_SELECT_SQL}
     FROM ims_box_table b
     ${JOINS}
     WHERE b.is_deleted = false
       AND ${belongsToPacking}
       AND (
         ${sqlBoxInHand("b")}
         OR (
           b.sa_entry_type = 'stock_in'
           AND b.sa_id IS NOT NULL
           AND ${sqlBoxOutUidEmpty("b")}
         )
         ${removedOr}
       )
     ORDER BY b.box_uid ASC`,
    values
  );
};

/** All in-hand boxes for a packing (production + SA add) — same rules as inventory report. */
export const findInHandBoxesByPackingNumber = async (packing_number) => {
  return findStockAdjustmentMinusBoxesByPacking(packing_number, null);
};

/**
 * Minus edit/view: in-hand + SA add + this adjustment's approved minus (stock_out) boxes.
 */
export const findInHandBoxesByPackingForStockAdjustment = async (packing_number, adjustment_id) => {
  return findStockAdjustmentMinusBoxesByPacking(packing_number, adjustment_id);
};

/**
 * Stock adjustment add view: all boxes ever created for this SA add (includes stock_out / minus).
 * Matches sticker id `_SA{adjustment_id}_` on box_no_uid.
 */
export const findStockAdjustmentAddBoxesByPattern = async (packing_number, adjustment_id) => {
  const pn = String(packing_number ?? "").trim();
  const adjId = Number(adjustment_id);
  if (!pn || !Number.isFinite(adjId) || adjId <= 0) return [];
  const saTag = `_SA${adjId}_`;

  return dbQuery(
    `SELECT ${IN_HAND_BOX_SELECT_SQL}
     FROM ims_box_table b
     ${JOINS}
     WHERE b.is_deleted = false
       AND ${sqlPackingNumberMatch("b", "$1")}
       AND position($2::text IN b.box_no_uid::text) > 0
     ORDER BY b.box_uid ASC`,
    [pn, saTag]
  );
};

export const findItemDcodesWithInHandStock = async () => {
  return dbQuery(
    `SELECT DISTINCT
       (
         CASE
           WHEN b.sa_id IS NOT NULL AND b.sa_entry_type = 'stock_in' AND sa_adj.item_dcode IS NOT NULL
             THEN sa_adj.item_dcode
           ELSE dp.item_dcode
         END
       )::int::text AS itemdcode
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
     LEFT JOIN ims_stock_adjustment sa_adj
       ON b.sa_id = sa_adj.adjustment_id
      AND b.sa_entry_type = 'stock_in'
      AND sa_adj.is_deleted = false
     WHERE ${sqlBoxInHand("b")}
       AND (
         CASE
           WHEN b.sa_id IS NOT NULL AND b.sa_entry_type = 'stock_in' AND sa_adj.item_dcode IS NOT NULL
             THEN sa_adj.item_dcode
           ELSE dp.item_dcode
         END
       ) IS NOT NULL`
  );
};

/** Standard pcs-per-box from local `ims_dailyprod` ? `ims_packing_standard` for this packing doc. */
export const findStandardQtyPerBoxForPackingNumber = async (doc_no) => {
  if (doc_no == null || String(doc_no).trim() === "") return null;
  const [row] = await dbQuery(
    `SELECT ps.qty AS standard_qty_per_box
     FROM ims_dailyprod dp
     LEFT JOIN ims_packing_standard ps
       ON ps.standard_id = dp.packing_standard_id
      AND ps.is_deleted = false
     WHERE trim(dp.doc_no::text) = trim($1::text)
     LIMIT 1`,
    [String(doc_no)]
  );
  const q = row?.standard_qty_per_box;
  if (q == null || q === "") return null;
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Fallback when `ims_dailyprod` has no linked standard: latest approved standard for the item. */
export const findLatestApprovedStandardQtyForItem = async (item_dcode) => {
  const id = item_dcode != null ? parseInt(String(item_dcode), 10) : NaN;
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ps.qty
     FROM ims_packing_standard ps
     WHERE ps.item_dcode = $1 AND ps.is_deleted = false AND ps.approved = true
     ORDER BY ps.standard_id DESC
     LIMIT 1`,
    [id]
  );
  const q = row?.qty;
  if (q == null || q === "") return null;
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const findBoxesByNoUids = async (box_no_uids = []) => {
  const uids = [...new Set((box_no_uids || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return [];
  return dbQuery(
    `SELECT b.*,
            dp.acc_code AS prod_acc_code,
            dp.item_dcode AS itemdcode
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::TEXT), '-') = NULLIF(TRIM(dp.doc_no::TEXT), '-')
     WHERE b.is_deleted = false
       AND b.box_no_uid::text = ANY($1::text[])
     ORDER BY b.box_uid ASC`,
    [uids]
  );
};

export const findBoxesByUids = async (box_uids = []) => {
  if (!box_uids.length) return [];
  
  return await dbQuery(
    `SELECT 
        b.*, 
        dp.doc_dt, 
        dp.job_card_no, 
        dp.acc_code AS prod_acc_code, 
        COALESCE(dp.item_dcode, sa_adj.item_dcode) AS itemdcode, 
        dp.total_qty AS prod_total_qty
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::TEXT), '-') = NULLIF(TRIM(dp.doc_no::TEXT), '-')
     LEFT JOIN ims_stock_adjustment sa_adj
       ON b.sa_id = sa_adj.adjustment_id
      AND sa_adj.is_deleted = false
     WHERE b.box_uid::TEXT = ANY($1::TEXT[])
       AND b.is_deleted = false
     ORDER BY b.box_uid ASC`,
    [box_uids.map((id) => String(id))]
  );
};

export const insertBox = async (data) => {
  const { box_no_uid, packing_number, qty = 0, override_cust, location_id, in_uid, out_uid, created_by } = data;

  const [row] = await dbQuery(
    `INSERT INTO ims_box_table
      (box_no_uid, packing_number, qty, override_cust, location_id, in_uid, out_uid, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [box_no_uid, packing_number, qty, override_cust, location_id, in_uid, out_uid, created_by]
  );

  return row;
};

export const updateBoxes = async (fields = {}, filters = {}) => {
  const safeFields = {};
  const safeFilters = {};

  for (const k in fields) {
    if (ALLOWED_UPDATE_FIELDS_BOX.includes(k)) {
      safeFields[k] = fields[k];
    }
  }

  for (const k in filters) {
    if (ALLOWED_FILTER_FIELDS_BOX.includes(k)) {
      safeFilters[k] = filters[k];
    }
  }

  safeFields.updated_at = new Date();

  const fieldKeys = Object.keys(safeFields);
  const filterKeys = Object.keys(safeFilters);

  if (!fieldKeys.length)  throw new Error("No valid fields to update");
  if (!filterKeys.length) throw new Error("No valid filters provided");

  const values = [...Object.values(safeFields), ...Object.values(safeFilters)];

  const setClause = fieldKeys
    .map((k, i) => `${k} = $${i + 1}`)
    .join(", ");

  const whereClause = filterKeys
    .map((k, i) => `${k} = $${fieldKeys.length + i + 1}`)
    .join(" AND ");

  const rows = await dbQuery(
    `UPDATE ims_box_table
     SET ${setClause}
     WHERE ${whereClause}
     RETURNING *`,
    values
  );

  return rows;
};

export const updateBoxesByUids = async (box_uids = [], fields = {}) => {
  if (!box_uids.length) return [];
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return [];

  const set = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = [...Object.values(fields), box_uids.map((id) => String(id))];

  const rows = await dbQuery(
    `UPDATE ims_box_table
     SET ${set}, updated_at = NOW()
     WHERE box_uid::text = ANY($${fieldKeys.length + 1}::text[])
     RETURNING *`,
    values
  );
  return rows;
};

export const deleteBoxes = async (filters = {}, meta = {}) => {
  const keys = Object.keys(filters);
  if (!keys.length) return;

  const where = keys.map((k, i) => `b.${k} = $${i + 1}`).join(" AND ");

  const rows = await dbQuery(
    `UPDATE ims_box_table b
     SET is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $${keys.length + 1}
     WHERE ${where}
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [...Object.values(filters), meta.deleted_by || null]
  );
  if (rows?.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.BOX_SOFT_DELETE,
      source_module: meta.source_module || "boxes",
      source_id: meta.source_id != null ? String(meta.source_id) : null,
      packing_number: rows[0]?.packing_number,
      user_id: meta.deleted_by,
      rows,
      details: { filters },
    });
  }
};

/** Production packing-entry stickers only SA `stock_in` rows for this packing are not deleted. */
export const permanentlyDeleteProductionBoxesForPackingNumber = async ({
  packing_number,
  user_id = null,
} = {}) => {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return [];

  const rows = await dbQuery(
    `DELETE FROM ims_box_table b
     WHERE b.packing_number::text = $1::text
       AND b.is_deleted = false
       AND NOT (b.sa_entry_type = 'stock_in' AND b.sa_id IS NOT NULL)
     RETURNING box_uid, box_no_uid, qty, is_loose`,
    [pn]
  );
  if (rows?.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.PACKING_DELETE,
      source_module: "packing_entry",
      source_id: pn,
      packing_number: pn,
      user_id,
      rows,
      details: { scope: "production_only" },
    });
  }
  return rows;
};

/** @deprecated Use `permanentlyDeleteProductionBoxesForPackingNumber` kept as alias. */
export const permanentlyDeleteBoxesForPackingNumber = permanentlyDeleteProductionBoxesForPackingNumber;

/** After all live boxes for a doc are removed, allow packing entry to generate again from ERP. */
export const resetDailyProdStickerGeneratedForDoc = async (doc_no) => {
  return dbQuery(
    `UPDATE ims_dailyprod
     SET sticker_generated = false,
         packing_standard_id = NULL
     WHERE doc_no = trim(COALESCE($1::text, '-'))::integer`,
    [String(doc_no)]
  );
};

export const getStickerHistory = async (doc_no, category_id = null) => {
  if (!doc_no) return [];

  const params = [String(doc_no), category_id ? String(category_id) : null];

  return await dbQuery(
    `
    WITH base AS (
      SELECT
        dp.doc_no,
        dp.doc_dt,
        dp.job_card_no,
        dp.item_dcode AS itemdcode,
        dp.total_qty,
        dp.acc_code,
        dp.sticker_generated,
        dp.packing_standard_id,
        NULL::text AS item_code,
        NULL::text AS itemdesc,
        NULL::text AS acc_name
      FROM ims_dailyprod dp
      WHERE dp.doc_no::text = $1::text
    ),
    ranked_standards AS (
      SELECT
        ps.standard_id,
        ps.item_dcode,
        ps.qty,
        ps.unit,
        ps.type,
        ps.acc_code,
        b.doc_no,
        ROW_NUMBER() OVER (
          PARTITION BY b.doc_no, ps.type
          ORDER BY
            CASE
              WHEN b.acc_code IS NOT NULL AND ps.acc_code::text = b.acc_code::text THEN 0
              ELSE 1
            END,
            ps.approved_at DESC NULLS LAST,
            ps.standard_id DESC
        ) AS rn
      FROM base b
      JOIN ims_packing_standard ps
        ON ps.is_deleted = false
       AND ps.approved = true
       AND (
            (b.packing_standard_id IS NOT NULL AND ps.standard_id = b.packing_standard_id)
            OR
            (
              b.packing_standard_id IS NULL
              AND ps.item_dcode::text = b.itemdcode::text
              AND (ps.acc_code::text = b.acc_code::text OR ps.acc_code IS NULL)
            )
          )
      WHERE ($2::text IS NULL OR ps.type::text = $2::text)
    )
    SELECT
      b.doc_no,
      b.doc_dt,
      b.job_card_no,
      b.itemdcode,
      b.item_code,
      b.itemdesc,
      b.total_qty,
      b.acc_code,
      b.acc_name,
      b.sticker_generated,
      rs.standard_id,
      rs.qty AS standard_qty_per_box,
      rs.unit,
      rs.type,
      ct.name AS ims_category
    FROM base b
    LEFT JOIN ranked_standards rs
      ON rs.doc_no = b.doc_no
     AND rs.rn = 1
    LEFT JOIN ims_category ct ON rs.type = ct.id
    ORDER BY rs.type ASC NULLS LAST
    `,
    params
  );
};

/**
 * Same packing-standard matching as {@link getStickerHistory}, but `base` comes from IMS / API
 * (`live`), not `ims_dailyprod` used before any local ims_dailyprod row exists.
 */
export const getStickerHistoryFromLiveRow = async (live = {}, category_id = null) => {
  if (!live || live.doc_no == null || String(live.doc_no).trim() === "") return [];

  const packingStdIdRaw =
    live.packing_standard_id != null && String(live.packing_standard_id).trim() !== ""
      ? String(live.packing_standard_id).trim()
      : null;

  const params = [
    String(live.doc_no).trim(),
    live.doc_dt != null && live.doc_dt !== "" ? String(live.doc_dt) : null,
    live.job_card_no != null ? String(live.job_card_no) : null,
    live.itemdcode != null ? String(live.itemdcode) : null,
    live.total_qty != null ? String(live.total_qty) : "0",
    live.acc_code != null ? String(live.acc_code) : null,
    Boolean(live.sticker_generated),
    packingStdIdRaw,
    category_id != null && String(category_id).trim() !== "" ? String(category_id).trim() : null
  ];

  return dbQuery(
    `
    WITH raw AS (
      SELECT
        $1::text AS doc_no,
        NULLIF(trim($2::text), '-') AS doc_dt,
        NULLIF(trim($3::text), '-') AS job_card_no,
        NULLIF(trim($4::text), '-') AS itemdcode,
        COALESCE(NULLIF(trim($5::text), '-')::numeric, 0)::numeric AS total_qty,
        NULLIF(trim($6::text), '-') AS acc_code,
        COALESCE($7::boolean, false) AS sticker_generated,
        CASE WHEN $8::text IS NULL OR trim($8::text) = '-' THEN NULL ELSE trim($8::text)::bigint END AS packing_standard_id
    ),
    base AS (
      SELECT
        r.doc_no,
        r.doc_dt,
        r.job_card_no,
        r.itemdcode,
        r.total_qty,
        r.acc_code,
        r.sticker_generated,
        r.packing_standard_id,
        NULL::text AS item_code,
        NULL::text AS itemdesc,
        NULL::text AS acc_name
      FROM raw r
    ),
    ranked_standards AS (
      SELECT
        ps.standard_id,
        ps.item_dcode,
        ps.qty,
        ps.unit,
        ps.type,
        ps.acc_code,
        b.doc_no,
        ROW_NUMBER() OVER (
          PARTITION BY b.doc_no, ps.type
          ORDER BY
            CASE
              WHEN b.acc_code IS NOT NULL AND ps.acc_code::text = b.acc_code::text THEN 0
              ELSE 1
            END,
            ps.approved_at DESC NULLS LAST,
            ps.standard_id DESC
        ) AS rn
      FROM base b
      JOIN ims_packing_standard ps
        ON ps.is_deleted = false
       AND ps.approved = true
       AND (
            (b.packing_standard_id IS NOT NULL AND ps.standard_id = b.packing_standard_id)
            OR
            (
              b.packing_standard_id IS NULL
              AND ps.item_dcode::text = b.itemdcode::text
              AND (ps.acc_code::text = b.acc_code::text OR ps.acc_code IS NULL)
            )
          )
      WHERE ($9::text IS NULL OR ps.type::text = $9::text)
    )
    SELECT
      b.doc_no,
      b.doc_dt,
      b.job_card_no,
      b.itemdcode,
      b.item_code,
      b.itemdesc,
      b.total_qty,
      b.acc_code,
      b.acc_name,
      b.sticker_generated,
      rs.standard_id,
      rs.qty AS standard_qty_per_box,
      rs.unit,
      rs.type,
      ct.name AS ims_category
    FROM base b
    LEFT JOIN ranked_standards rs
      ON rs.doc_no = b.doc_no
     AND rs.rn = 1
    LEFT JOIN ims_category ct ON rs.type = ct.id
    ORDER BY rs.type ASC NULLS LAST
    `,
    params
  );
};

export const checkPackingExists = async (packing_number) => {
  const [row] = await dbQuery(
    `SELECT 1 AS ok
     FROM ims_box_table
     WHERE packing_number = $1
       AND is_deleted = false
       AND (sa_entry_type IS DISTINCT FROM 'stock_out')
     LIMIT 1`,
    [String(packing_number)]
  );
  return Boolean(row?.ok);
};

/** SA-approved add boxes for this packing (print/remove from Stock Adjustment only). */
export const checkSaStockInBoxesExist = async (packing_number) => {
  const [row] = await dbQuery(
    `SELECT 1 AS ok
     FROM ims_box_table
     WHERE packing_number = $1
       AND is_deleted = false
       AND sa_entry_type = 'stock_in'
       AND sa_id IS NOT NULL
     LIMIT 1`,
    [String(packing_number)]
  );
  return Boolean(row?.ok);
};

/** True when normal packing-entry stickers exist (not SA add placeholders only). */
export const checkProductionStickersExist = async (packing_number) => {
  const [row] = await dbQuery(
    `SELECT 1 AS ok
     FROM ims_box_table
     WHERE packing_number = $1
       AND is_deleted = false
       AND (sa_entry_type IS DISTINCT FROM 'stock_out')
       AND NOT (sa_entry_type = 'stock_in' AND sa_id IS NOT NULL)
     LIMIT 1`,
    [String(packing_number)]
  );
  return Boolean(row?.ok);
};

/** ERP packing numbers that have production stickers in `ims_box_table` (panel DB source of truth). */
export const getProductionStickerPackingDocNos = async () => {
  const rows = await dbQuery(
    `SELECT DISTINCT packing_number::text AS doc_no
     FROM ims_box_table
     WHERE is_deleted = false
       AND packing_number IS NOT NULL
       AND trim(packing_number::text) <> '-'
       AND (sa_entry_type IS DISTINCT FROM 'stock_out')
       AND NOT (sa_entry_type = 'stock_in' AND sa_id IS NOT NULL)`
  );
  return (rows || []).map((r) => String(r.doc_no).trim()).filter(Boolean);
};

const PRODUCTION_STICKER_BOX_FILTER = `
  b.is_deleted = false
  AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')
`;

/** Production sticker UI only SA boxes use ims_stock_adjustment module + `checkSaStockInBoxesExist`. */
const SQL_SA_BOX_NO_UID_MATCH = `b.box_no_uid::text ~ '_SA[0-9]+_'`;
const SQL_EXCLUDE_SA_BOX_NO_UID = `AND NOT (${SQL_SA_BOX_NO_UID_MATCH})`;

function sqlSaTokenInBoxNoUid(adjustmentIdExpr, boxNoUidRef = "b.box_no_uid") {
  return `position(('_SA' || ${adjustmentIdExpr}::text || '_') IN ${boxNoUidRef}::text) > 0`;
}

/**
 * Remove SA sticker rows: adjustment deleted, or this packing has no active approved add.
 * @param {string|null} [packing_number] when set, also drops orphans on that packing only.
 */
export async function purgeSaStickerBoxesTx(client = null, packing_number = null) {
  const pn = packing_number != null ? String(packing_number).trim() : "";
  const params = [];
  const clauses = [
    `EXISTS (
      SELECT 1 FROM ims_stock_adjustment sa
      WHERE sa.is_deleted = true AND ${sqlSaTokenInBoxNoUid("sa.adjustment_id")}
    )`,
  ];
  if (pn) {
    params.push(pn);
    const p = `$${params.length}`;
    clauses.push(`(
      trim(b.packing_number::text) = trim(${p}::text)
      AND NOT EXISTS (
        SELECT 1 FROM ims_stock_adjustment sa
        WHERE sa.is_deleted = false
          AND sa.approved = true
          AND sa.entry_type = 'add'
          AND trim(sa.packing_number::text) = trim(${p}::text)
          AND ${sqlSaTokenInBoxNoUid("sa.adjustment_id")}
      )
    )`);
  }
  const sql = `DELETE FROM ims_box_table b
     WHERE b.is_deleted = false
       AND ${SQL_SA_BOX_NO_UID_MATCH}
       AND (${clauses.join(" OR ")})
     RETURNING box_uid, box_no_uid, packing_number`;
  if (client?.query) {
    const { rows } = await client.query(sql, params);
    return rows || [];
  }
  return (await dbQuery(sql, params)) || [];
}

/**
 * Panel DB meta for generated stickers: customer (`override_cust`), ims_dailyprod snapshot, audit.
 * Used by daily-prod list so generated rows do not show ERP customer after sticker create.
 */
export async function getProductionStickerPanelMetaByPackingNumbers(packingNumbers = []) {
  const nums = [...new Set((packingNumbers || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!nums.length) return new Map();

  const rows = await dbQuery(
    `WITH box_with_meta AS (
       SELECT
         b.box_uid,
         b.created_at,
         b.updated_at,
         b.created_by,
         b.updated_by,
         b.packing_number::text AS packing_number,
         COALESCE(sa.item_dcode::text, dp.item_dcode::text, '-') AS item_dcode,
         ${sqlBoxCustomerCode("b", "dp")} AS acc_code,
         dp.acc_code AS dailyprod_acc_code,
         dp.item_dcode AS dailyprod_item_dcode,
         dp.total_qty AS dailyprod_total_qty,
         dp.job_card_no AS dailyprod_job_card_no,
         dp.doc_dt AS dailyprod_doc_dt,
         sa.financial_year AS sa_financial_year,
         b.override_cust
       FROM ims_box_table b
       LEFT JOIN ims_stock_adjustment sa ON sa.adjustment_id = b.sa_id AND sa.is_deleted = false
       ${sqlDailyprodLateralForBox("b", "sa", "NULLIF(TRIM(b.packing_number::text), '-')")}
       WHERE b.packing_number::text = ANY($1::text[])
         AND ${PRODUCTION_STICKER_BOX_FILTER}
     )
     SELECT
       packing_number,
       item_dcode,
       acc_code,
       COUNT(*)::int AS sticker_count,
       MIN(created_at) AS sticker_created_at,
       MAX(updated_at) AS sticker_updated_at,
       MAX(NULLIF(trim(override_cust::text), '-')) AS override_cust,
       MAX(dailyprod_acc_code)::text AS dailyprod_acc_code,
       MAX(dailyprod_item_dcode)::text AS dailyprod_item_dcode,
       MAX(dailyprod_total_qty) AS dailyprod_total_qty,
       MAX(dailyprod_job_card_no) AS dailyprod_job_card_no,
       MAX(dailyprod_doc_dt) AS dailyprod_doc_dt,
       MAX(sa_financial_year)::text AS sa_financial_year,
       (
         SELECT u.name
         FROM box_with_meta bm
         INNER JOIN ${M.USERS} u ON u.id = bm.created_by
         WHERE bm.packing_number = b.packing_number
           AND bm.item_dcode = b.item_dcode
           AND bm.acc_code = b.acc_code
         ORDER BY bm.created_at ASC NULLS LAST
         LIMIT 1
       ) AS sticker_created_by_name,
       (
         SELECT u.name
         FROM box_with_meta bm
         INNER JOIN ${M.USERS} u ON u.id = bm.updated_by
         WHERE bm.packing_number = b.packing_number
           AND bm.item_dcode = b.item_dcode
           AND bm.acc_code = b.acc_code
           AND bm.updated_by IS NOT NULL
         ORDER BY bm.updated_at DESC NULLS LAST
         LIMIT 1
       ) AS sticker_updated_by_name
     FROM box_with_meta b
     GROUP BY packing_number, item_dcode, acc_code`,
    [nums]
  );

  const map = new Map();
  for (const r of rows || []) {
    const pn = String(r.packing_number).trim();
    const item = String(r.item_dcode).trim();
    const cust = String(r.acc_code).trim();
    const key = `${pn}:${item}:${cust}`;
    const entry = {
      ...r,
      acc_code: cust === "-" ? null : cust,
      itemdcode:
        r.dailyprod_item_dcode != null && String(r.dailyprod_item_dcode).trim() !== ""
          ? String(r.dailyprod_item_dcode).trim()
          : null,
    };
    map.set(key, entry);
    const pnOnly = String(r.packing_number).trim();
    if (pnOnly && !map.has(pnOnly)) map.set(pnOnly, entry);
  }
  return map;
}

/** @deprecated Use {@link getProductionStickerPanelMetaByPackingNumbers} */
export async function getProductionStickerAuditByPackingNumbers(packingNumbers = []) {
  return getProductionStickerPanelMetaByPackingNumbers(packingNumbers);
}

/** Remove SA-approved add boxes for a packing so production stickers can be generated. */
export const permanentlyDeleteSaStockInBoxesForPacking = async ({ packing_number, user_id = null } = {}) => {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return [];

  const rows = await dbQuery(
    `DELETE FROM ims_box_table b
     WHERE b.packing_number::text = $1::text
       AND b.is_deleted = false
       AND b.sa_entry_type = 'stock_in'
       AND b.sa_id IS NOT NULL
     RETURNING box_uid, box_no_uid, qty, is_loose, sa_id`,
    [pn]
  );
  if (rows?.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.SA_DELETE,
      source_module: "packing_entry",
      source_id: pn,
      packing_number: pn,
      user_id,
      rows,
      details: {
        reason: "replaced_by_production_sticker_generate",
        sa_ids: [...new Set(rows.map((r) => r.sa_id).filter(Boolean))],
      },
    });
  }
  return rows;
};

function mapRowsToBulkInsertArrays(rows) {
  const box_no_uids = [];
  const packing_numbers = [];
  const qtys = [];
  const is_looses = [];
  const override_custs = [];
  const created_bys = [];
  const sa_ids = [];
  const sa_entry_types = [];

  for (const row of rows) {
    box_no_uids.push(row.box_no_uid);
    packing_numbers.push(row.packing_number);
    qtys.push(row.qty);
    is_looses.push(row.is_loose ?? false);
    override_custs.push(row.override_cust ?? null);
    created_bys.push(row.created_by);
    sa_ids.push(row.sa_id != null ? row.sa_id : null);
    sa_entry_types.push(normalizeSaEntryTypeForInsert(row.sa_entry_type));
  }

  return {
    box_no_uids,
    packing_numbers,
    qtys,
    is_looses,
    override_custs,
    created_bys,
    sa_ids,
    sa_entry_types,
  };
}

const BULK_INSERT_SQL = `
  INSERT INTO ims_box_table
    (box_no_uid, packing_number, qty, is_loose, override_cust, created_by, sa_id, sa_entry_type)
  SELECT u, p, q, l, o, c, s, e
  FROM unnest(
    $1::text[],
    $2::text[],
    $3::int[],
    $4::boolean[],
    $5::text[],
    $6::int[],
    $7::int[],
    $8::text[]
  ) AS t(u, p, q, l, o, c, s, e)
  RETURNING *`;

export const insertBulkBoxes = async (rows) => {
  if (!rows?.length) return [];
  const arrays = mapRowsToBulkInsertArrays(rows);
  try {
    const inserted = await dbQuery(BULK_INSERT_SQL, [
      arrays.box_no_uids,
      arrays.packing_numbers,
      arrays.qtys,
      arrays.is_looses,
      arrays.override_custs,
      arrays.created_bys,
      arrays.sa_ids,
      arrays.sa_entry_types,
    ]);
    const packing = rows[0]?.packing_number ?? inserted[0]?.packing_number;
    const isSa = rows[0]?.sa_entry_type === "stock_in";
    logBoxTransactionSafe({
      transaction_type: isSa ? BOX_TX_TYPES.SA_STOCK_IN : BOX_TX_TYPES.PACKING_CREATE,
      source_module: isSa ? "stock_adjustment" : "packing_entry",
      source_id: isSa ? String(rows[0]?.sa_id ?? "") : String(packing ?? ""),
      packing_number: packing,
      user_id: rows[0]?.created_by,
      rows: inserted,
      details: { entry_type: isSa ? "add" : undefined },
    });
    return inserted;
  } catch (err) {
    console.error("Bulk box insert failed:", err.message);
    throw new Error(`Failed to insert boxes: ${err.message}`);
  }
};

/** Same as `insertBulkBoxes` but uses an open transaction `client`. */
export const insertBulkBoxesTx = async (client, rows) => {
  if (!rows?.length) return [];
  const arrays = mapRowsToBulkInsertArrays(rows);
  const { rows: inserted } = await client.query(BULK_INSERT_SQL, [
    arrays.box_no_uids,
    arrays.packing_numbers,
    arrays.qtys,
    arrays.is_looses,
    arrays.override_custs,
    arrays.created_bys,
    arrays.sa_ids,
    arrays.sa_entry_types,
  ]);
  const packing = rows[0]?.packing_number ?? inserted[0]?.packing_number;
  const isSa = rows[0]?.sa_entry_type === "stock_in";
  await logBoxTransaction({
    client,
    transaction_type: isSa ? BOX_TX_TYPES.SA_STOCK_IN : BOX_TX_TYPES.PACKING_CREATE,
    source_module: isSa ? "stock_adjustment" : "packing_entry",
    source_id: isSa ? String(rows[0]?.sa_id ?? "") : String(packing ?? ""),
    packing_number: packing,
    user_id: rows[0]?.created_by,
    rows: inserted,
    details: { entry_type: isSa ? "add" : undefined },
  });
  return inserted;
};

/**
 * Stock-adjustment minus: set `sa_id` and `sa_entry_type = 'stock_out'` on in-hand boxes only.
 * @returns {Promise<Array<{ box_uid: number }>>}
 */
export const findStockAdjustmentAddBoxesTx = async (client, adjustmentId) => {
  const { rows } = await client.query(
    `SELECT box_uid, box_no_uid, packing_number, qty, is_loose, unit, sa_id, sa_entry_type
     FROM ims_box_table
     WHERE sa_id = $1::integer
       AND sa_entry_type = 'stock_in'
       AND is_deleted = false
     ORDER BY box_uid ASC`,
    [adjustmentId]
  );
  return rows;
};

/** Soft-delete selected stock-in boxes for this add adjustment. */
export const softDeleteStockAdjustmentAddBoxesByUidsTx = async (client, { adjustmentId, boxUids, userId }) => {
  const ids = (Array.isArray(boxUids) ? boxUids : [])
    .map((u) => Number(u))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `UPDATE ims_box_table
     SET is_deleted = true,
         deleted_by = $3::integer,
         deleted_at = NOW(),
         updated_by = $3::integer,
         updated_at = NOW()
     WHERE sa_id = $1::integer
       AND sa_entry_type = 'stock_in'
       AND is_deleted = false
       AND box_uid = ANY($2::int[])
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [adjustmentId, ids, userId]
  );
  if (rows.length !== ids.length) {
    const err = new Error("Some boxes could not be removed they may not belong to this adjustment.");
    err.statusCode = 400;
    throw err;
  }
  await logBoxTransaction({
    client,
    transaction_type: BOX_TX_TYPES.SA_DELETE,
    source_module: "stock_adjustment",
    source_id: String(adjustmentId),
    packing_number: singlePackingFromRows(rows),
    user_id: userId,
    rows,
    details: { entry_type: "add", adjustment_id: adjustmentId },
  });
  return rows;
};

/** Update per-box qty on all stock-in boxes for an add adjustment. */
export const updateStockAdjustmentAddBoxesQtyTx = async (client, { adjustmentId, qty, userId }) => {
  await client.query(
    `UPDATE ims_box_table
     SET qty = $2::integer,
         updated_by = $3::integer,
         updated_at = NOW()
     WHERE sa_id = $1::integer
       AND sa_entry_type = 'stock_in'
       AND is_deleted = false`,
    [adjustmentId, qty, userId]
  );
  await logBoxTransaction({
    client,
    transaction_type: BOX_TX_TYPES.SA_QTY_UPDATE,
    source_module: "stock_adjustment",
    source_id: String(adjustmentId),
    user_id: userId,
    details: { entry_type: "add", adjustment_id: adjustmentId, per_box_qty: qty },
  });
};

/**
 * Permanently remove all boxes created by an add adjustment, including `stock_out`
 * rows left after a minus (box_no_uid contains `_SA{adjustmentId}_`).
 * Set `skipLog` on approve re-apply cleanup.
 */
export const permanentlyDeleteStockAdjustmentAddBoxesTx = async (
  client,
  { adjustmentId, userId = null, skipLog = true }
) => {
  const adjId = Number(adjustmentId);
  const { rows } = await client.query(
    `DELETE FROM ims_box_table
     WHERE is_deleted = false
       AND (
         (sa_id = $1::integer AND sa_entry_type = 'stock_in')
         OR ${sqlSaTokenInBoxNoUid("$1", "box_no_uid")}
       )
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [adjId]
  );
  if (!skipLog && rows?.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.SA_REVERT,
      source_module: "stock_adjustment",
      source_id: String(adjustmentId),
      packing_number: singlePackingFromRows(rows),
      user_id: userId,
      rows,
      details: {
        entry_type: "add",
        adjustment_id: adjustmentId,
      },
    });
  }
  return rows;
};

/** Undo minus marks for this adjustment only (pending edit). */
export const clearStockAdjustmentMinusMarksTx = async (client, { adjustmentId, boxUids, userId }) => {
  const ids = (Array.isArray(boxUids) ? boxUids : [])
    .map((u) => Number(u))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `UPDATE ims_box_table
     SET sa_id = NULL,
         sa_entry_type = NULL,
         out_uid = NULL,
         updated_by = $2::integer,
         updated_at = NOW()
     WHERE sa_id = $1::integer
       AND sa_entry_type = 'stock_out'
       AND box_uid = ANY($3::int[])
       AND is_deleted = false
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [adjustmentId, userId, ids]
  );
  if (rows.length) {
    await logBoxTransaction({
      client,
      transaction_type: BOX_TX_TYPES.SA_REVERT,
      source_module: "stock_adjustment",
      source_id: String(adjustmentId),
      user_id: userId,
      rows,
      details: { entry_type: "minus", adjustment_id: adjustmentId },
    });
  }
  return rows;
};

export const markBoxesStockAdjustmentOutTx = async (client, { adjustmentId, boxUids, userId, packing_number = null }) => {
  const ids = (Array.isArray(boxUids) ? boxUids : [])
    .map((u) => Number(u))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `UPDATE ims_box_table
     SET sa_id = $1::integer,
         sa_entry_type = 'stock_out',
         out_uid = $1::integer,
         updated_by = $2::integer,
         updated_at = NOW()
     WHERE box_uid = ANY($3::int[])
       AND is_deleted = false
       AND (out_uid IS NULL OR out_uid::text = $1::text)
       AND (sa_entry_type IS DISTINCT FROM 'stock_out' OR sa_id = $1::integer)
     RETURNING box_uid, box_no_uid, packing_number, qty, is_loose`,
    [adjustmentId, userId, ids]
  );
  if (rows.length !== ids.length) {
    const err = new Error(
      "Some boxes could not be removed they may be dispatched, already removed via adjustment, or deleted."
    );
    err.statusCode = 409;
    throw err;
  }
  await logBoxTransaction({
    client,
    transaction_type: BOX_TX_TYPES.SA_STOCK_OUT,
    source_module: "stock_adjustment",
    source_id: String(adjustmentId),
    packing_number: packing_number || singlePackingFromRows(rows),
    user_id: userId,
    rows,
    details: { entry_type: "minus", adjustment_id: adjustmentId },
  });
  return rows;
};

/** If no local row exists, insert one from `snapshot` (live production line). */
export const updateDailyProdStickerStatus = async (doc_no, standard_id = null, snapshot = null) => {
  const d = String(doc_no);
  const sid =
    standard_id != null && standard_id !== ""
      ? standard_id
      : null;

  const snapAcc =
    snapshot?.acc_code != null && String(snapshot.acc_code).trim() !== ""
      ? String(snapshot.acc_code).trim()
      : null;

  const snapItemCode =
    snapshot?.item_code != null && String(snapshot.item_code).trim() !== ""
      ? String(snapshot.item_code).trim()
      : null;

  const updated = await dbQuery(
    `UPDATE ims_dailyprod
     SET sticker_generated = true,
         packing_standard_id = $2::bigint,
         acc_code = CASE
           WHEN $3::text IS NOT NULL AND trim($3::text) <> '-' THEN trim($3::text)::integer
           ELSE acc_code
         END,
         item_code = COALESCE($4::text, item_code)
     WHERE doc_no = trim(COALESCE($1::text, '-'))::integer
     RETURNING doc_no`,
    [d, sid, snapAcc, snapItemCode]
  );

  if (Array.isArray(updated) && updated.length > 0) return updated;

  if (!snapshot || typeof snapshot !== "object") return [];

  const doc_dt = snapshot.doc_dt ?? null;
  const job_card_no = snapshot.job_card_no ?? null;
  const acc_code = snapshot.acc_code ?? null;
  const itemdcode = snapshot.itemdcode ?? null;
  const item_code = snapshot.item_code ?? null;
  const total_qty = snapshot.total_qty ?? 0;

  const sidStr = sid != null && sid !== "" ? String(sid) : "";

  return dbQuery(
    `INSERT INTO ims_dailyprod (doc_no, doc_dt, job_card_no, acc_code, item_dcode, item_code, total_qty, sticker_generated, packing_standard_id)
     VALUES (
       trim(COALESCE($1::text, '-'))::integer,
       CASE WHEN trim(COALESCE($2::text, '-')) = '-' THEN NULL::date ELSE trim($2::text)::date END,
       NULLIF(trim(COALESCE($3::text, '-')), '-'),
       CASE WHEN trim(COALESCE($4::text, '-')) = '-' THEN NULL::integer ELSE trim($4::text)::integer END,
       CASE WHEN trim(COALESCE($5::text, '-')) = '-' THEN NULL::bigint ELSE trim($5::text)::bigint END,
       NULLIF(trim(COALESCE($6::text, '-')), '-'),
       COALESCE(NULLIF(trim(COALESCE($7::text, '-')), '-')::numeric, 0),
       true,
       CASE WHEN trim(COALESCE($8::text, '-')) = '-' THEN NULL::bigint ELSE trim($8::text)::bigint END
     )
     ON CONFLICT (doc_no) DO UPDATE SET
       sticker_generated = true,
       packing_standard_id = EXCLUDED.packing_standard_id,
       acc_code = COALESCE(EXCLUDED.acc_code, ims_dailyprod.acc_code),
       item_dcode = COALESCE(EXCLUDED.item_dcode, ims_dailyprod.item_dcode),
       item_code = COALESCE(EXCLUDED.item_code, ims_dailyprod.item_code),
       total_qty = COALESCE(EXCLUDED.total_qty, ims_dailyprod.total_qty),
       doc_dt = COALESCE(EXCLUDED.doc_dt, ims_dailyprod.doc_dt),
       job_card_no = COALESCE(EXCLUDED.job_card_no, ims_dailyprod.job_card_no)
     RETURNING doc_no`,
    [
      d,
      doc_dt != null ? String(doc_dt) : "",
      job_card_no != null ? String(job_card_no) : "",
      acc_code != null ? String(acc_code) : "",
      itemdcode != null ? String(itemdcode) : "",
      item_code != null ? String(item_code) : "",
      String(total_qty),
      sidStr
    ]
  );
};

export const incrementDownloadCount = async (box_uid, updated_by) => {
  const [row] = await dbQuery(
    `UPDATE ims_box_table
     SET download_count = COALESCE(download_count, 0) + 1,
         updated_by     = $2,
         updated_at     = NOW()
     WHERE box_uid = $1
     RETURNING *`,
    [box_uid, updated_by]
  );
  return row;
};

/** Single UPDATE bulk print all without N log rows in ims_box_download_log. */
export const incrementDownloadCountBulk = async (box_uids, updated_by) => {
  const ids = (Array.isArray(box_uids) ? box_uids : [])
    .map((u) => Number(u))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  return await dbQuery(
    `UPDATE ims_box_table
     SET download_count = COALESCE(download_count, 0) + 1,
         updated_by     = $2,
         updated_at     = NOW()
     WHERE box_uid = ANY($1::int[])
       AND is_deleted = false
     RETURNING box_uid, download_count`,
    [ids, updated_by]
  );
};

const FIND_BOX_DETAILED_SELECT = `
    SELECT 
      b.*,
      NULL::text AS item_code,
      NULL::text AS itemdesc,
      NULL::text AS acc_name,
      j.job_card_no AS job_no,
      j.doc_dt,
      j.acc_code::text AS prod_acc_code,
      j.acc_code,
      COALESCE(j.item_dcode, sa_adj.item_dcode) AS itemdcode,
      ps.unit,
      NULL::text AS party_rate_cust_code
    FROM ims_box_table b
    LEFT JOIN ims_dailyprod j ON TRIM(b.packing_number::TEXT) = TRIM(j.doc_no::TEXT)
    LEFT JOIN ims_stock_adjustment sa_adj
      ON b.sa_id = sa_adj.adjustment_id AND b.sa_entry_type = 'stock_in'
    LEFT JOIN ims_packing_standard ps ON j.packing_standard_id = ps.standard_id`;

// 2. Find Single Box Detailed (join ims_dailyprod like findBoxes `dp` fields for suggestion resolver)
export const findBoxDetailed = async ({ box_uid, box_no_uid } = {}) => {
  const noUid = box_no_uid != null ? String(box_no_uid).trim() : "";
  const uidRaw = box_uid != null ? String(box_uid).trim() : "";
  const uid = /^\d+$/.test(uidRaw) ? uidRaw : "";

  if (noUid) {
    const rows = await dbQuery(
      `${FIND_BOX_DETAILED_SELECT}
       WHERE b.box_no_uid::text = $1::text
       LIMIT 1`,
      [noUid]
    );
    if (rows?.[0]) return rows[0];
  }
  if (uid) {
    const rows = await dbQuery(
      `${FIND_BOX_DETAILED_SELECT}
       WHERE b.box_uid::text = $1::text
       LIMIT 1`,
      [uid]
    );
    if (rows?.[0]) return rows[0];
  }
  return null;
};

/** Detailed row for sticker scan (`box_no_uid` + optional `box_uid`). */
export const findBoxDetailedByStickerScan = async ({ box_no_uid, box_uid } = {}) => {
  const noUid = box_no_uid != null ? String(box_no_uid).trim() : "";
  const uidRaw = box_uid != null ? String(box_uid).trim() : "";
  const uid = /^\d+$/.test(uidRaw) ? uidRaw : "";

  if (noUid) {
    const row = await findBoxDetailed({ box_no_uid: noUid });
    if (row) return row;
  }
  if (uid) {
    return findBoxDetailed({ box_uid: uid });
  }
  return null;
};

export const findBoxDetailedByUidOrNoUid = async (id) => {
  const val = id != null ? String(id).trim() : "";
  if (!val) return null;
  const tryUid = /^\d+$/.test(val);
  const rows = await dbQuery(
    `${FIND_BOX_DETAILED_SELECT}
     WHERE (
       b.box_no_uid::text = $1::text
       OR ($2::boolean AND b.box_uid::text = $1::text)
     )
     LIMIT 1`,
    [val, tryUid]
  );
  return rows?.[0] || null;
};

// 3. Find Multiple Boxes Detailed (Fixed Array handling with ANY)
export const findBoxesDetailed = async ({ box_uids, packing_number }) => {
  let query = `
    SELECT 
      b.*, 
      NULL::text AS item_code, NULL::text AS itemdesc, NULL::text AS acc_name,
      j.job_card_no as job_no,
      j.doc_dt,
      j.acc_code::text AS prod_acc_code,
      j.acc_code,
      COALESCE(j.item_dcode, sa_adj.item_dcode) AS itemdcode,
      ps.unit,
      NULL::text AS party_rate_cust_code
    FROM ims_box_table b
    LEFT JOIN ims_dailyprod j ON TRIM(b.packing_number::TEXT) = TRIM(j.doc_no::TEXT)
    LEFT JOIN ims_stock_adjustment sa_adj
      ON b.sa_id = sa_adj.adjustment_id AND b.sa_entry_type = 'stock_in'
    LEFT JOIN ims_packing_standard ps ON j.packing_standard_id = ps.standard_id
    WHERE 
  `;

  const params = [];
  if (box_uids && box_uids.length > 0) {
    query += ` b.box_uid::TEXT = ANY($1::TEXT[]) `;
    params.push(box_uids.map(id => String(id)));
  } else {
    query += ` b.packing_number::TEXT = $1::TEXT `;
    params.push(String(packing_number));
  }

  query += ` AND b.is_deleted = false AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')`;

  const rows = await dbQuery(query, params);
  return rows || [];
};

export const insertDownloadLog = async ({
  box_uid,
  cust_at_time,
  downloaded_by,
  download_type = "single",
  bulk_packing_number = null,
  bulk_sticker_count = null,
  download_source = null,
}) => {
  const isBulkPack =
    String(download_type || "").toLowerCase() === "bulk_pack" &&
    bulk_packing_number != null &&
    String(bulk_packing_number).trim() !== "";
  const uid =
    isBulkPack
      ? null
      : box_uid != null && Number.isFinite(Number(box_uid)) && Number(box_uid) > 0
        ? Number(box_uid)
        : null;
  if (!isBulkPack && uid == null) {
    throw new Error("insertDownloadLog: box_uid required for non bulk_pack rows");
  }

  const src =
    download_source != null && String(download_source).trim() !== ""
      ? String(download_source).trim().slice(0, 48)
      : null;

  const [row] = await dbQuery(
    `INSERT INTO ims_box_download_log
      (box_uid, cust_at_time, downloaded_by, download_type, bulk_packing_number, bulk_sticker_count, download_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      uid,
      cust_at_time,
      downloaded_by,
      download_type,
      bulk_packing_number != null && String(bulk_packing_number).trim() !== ""
        ? String(bulk_packing_number).trim()
        : null,
      bulk_sticker_count != null && Number(bulk_sticker_count) > 0 ? Number(bulk_sticker_count) : null,
      src,
    ]
  );
  return row;
};

export const getDownloadLogByBox = async (box_uid) => {
  return await dbQuery(
    `
    SELECT * FROM (
      SELECT
        l.log_id,
        l.downloaded_at,
        l.download_type,
        l.cust_at_time,
        l.download_source
      FROM ims_box_download_log l
      WHERE l.box_uid = $1
      UNION
      SELECT
        l2.log_id,
        l2.downloaded_at,
        l2.download_type,
        l2.cust_at_time,
        l2.download_source
      FROM ims_box_download_log l2
      INNER JOIN ims_box_table b ON b.box_uid = $1
      WHERE l2.download_type = 'bulk_pack'
        AND l2.bulk_packing_number IS NOT NULL
        AND l2.bulk_packing_number = b.packing_number::text
    ) x
    ORDER BY x.downloaded_at DESC
  `,
    [box_uid]
  );
};

export const getDownloadSummaryByPacking = async (packing_number) => {
  return await dbQuery(`
    SELECT
      b.box_uid,
      b.box_no_uid,
      b.qty,
      b.is_loose,
      b.override_cust,
      b.download_count,
      b.packing_number as packing_no,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'log_id',           l.log_id,
            'downloaded_at',    l.downloaded_at,
            'type',             l.download_type,
            'cust_at_time',     l.cust_at_time,
            'download_source',  l.download_source
          ) ORDER BY l.downloaded_at DESC
        ) FILTER (WHERE l.log_id IS NOT NULL),
        '[]'
      ) AS download_history
    FROM ims_box_table b
    LEFT JOIN ims_box_download_log l ON (
      l.box_uid = b.box_uid
      OR (
        l.download_type = 'bulk_pack'
        AND l.bulk_packing_number IS NOT NULL
        AND l.bulk_packing_number = b.packing_number::text
      )
    )
    WHERE b.packing_number::text = $1::text
      AND b.is_deleted = false
      AND NOT (b.sa_entry_type = 'stock_in' AND b.sa_id IS NOT NULL)
      ${SQL_EXCLUDE_SA_BOX_NO_UID}
    GROUP BY b.box_uid
    ORDER BY b.box_uid ASC
  `, [String(packing_number)]);
};


/** One row per `ims_box_table` sticker (legacy / box search). Pass `list_mode: "box"`. */
async function getStickerBoxManagementList(options = {}) {
  const { 
    filters = {}, 
    search = null, 
    page = 1, 
    limit = 10, 
    sort = {} 
  } = options;

  /** Packing-wide `bulk_pack` lives on `bulk_packing_number` (box_uid NULL). Per-box singles stay on `box_uid`. */
  const lastLogLateral = `
    LEFT JOIN LATERAL (
      SELECT
        ev.downloaded_at,
        ev.downloaded_by_name,
        ev.download_type,
        ev.bulk_sticker_count
      FROM LATERAL (
        SELECT
          dl.downloaded_at,
          u.name AS downloaded_by_name,
          dl.download_type,
          NULL::integer AS bulk_sticker_count
        FROM ims_box_download_log dl
        LEFT JOIN ${M.USERS} u ON u.id = dl.downloaded_by
        WHERE dl.box_uid = b.box_uid
          AND (dl.download_type IS DISTINCT FROM 'bulk_pack')
        UNION
        SELECT
          dl2.downloaded_at,
          u2.name AS downloaded_by_name,
          dl2.download_type,
          dl2.bulk_sticker_count
        FROM ims_box_download_log dl2
        LEFT JOIN ${M.USERS} u2 ON u2.id = dl2.downloaded_by
        WHERE dl2.download_type = 'bulk_pack'
          AND dl2.bulk_packing_number IS NOT NULL
          AND TRIM(dl2.bulk_packing_number::text) = TRIM(b.packing_number::text)
      ) ev
      ORDER BY ev.downloaded_at DESC NULLS LAST
      LIMIT 1
    ) last_log ON true
  `;

  const packingBulkMaxAt = `
    (SELECT MAX(bl.downloaded_at)
     FROM ims_box_download_log bl
     WHERE bl.download_type = 'bulk_pack'
       AND bl.bulk_packing_number IS NOT NULL
       AND TRIM(bl.bulk_packing_number::text) = TRIM(b.packing_number::text))
  `;

  const values = [];
  let i = 1;

  const conditions = ["b.is_deleted = false", "(b.sa_entry_type IS DISTINCT FROM 'stock_out')"];

  if (filters.from_date) {
    values.push(filters.from_date);
    const fromIdx = i++;
    conditions.push(`(
      COALESCE(last_log.downloaded_at, b.created_at) >= $${fromIdx}::timestamp
      OR EXISTS (
        SELECT 1 FROM ims_box_download_log bl
        WHERE bl.download_type = 'bulk_pack'
          AND bl.bulk_packing_number IS NOT NULL
          AND TRIM(bl.bulk_packing_number::text) = TRIM(b.packing_number::text)
          AND bl.downloaded_at >= $${fromIdx}::timestamp
      )
    )`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    const toIdx = i++;
    conditions.push(`(
      COALESCE(last_log.downloaded_at, b.created_at) <= $${toIdx}::timestamp
      OR EXISTS (
        SELECT 1 FROM ims_box_download_log bl
        WHERE bl.download_type = 'bulk_pack'
          AND bl.bulk_packing_number IS NOT NULL
          AND TRIM(bl.bulk_packing_number::text) = TRIM(b.packing_number::text)
          AND bl.downloaded_at <= $${toIdx}::timestamp
      )
    )`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      b.box_no_uid ILIKE $${idx} OR
      b.packing_number::TEXT ILIKE $${idx} OR
      dp.item_dcode::TEXT ILIKE $${idx} OR
      dp.acc_code::TEXT ILIKE $${idx} OR
      b.override_cust::TEXT ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const ALLOWED_SORT_FIELDS = {
    "box_uid": "b.box_uid",
    "created_at": "b.created_at",
    "box_no_uid": "b.box_no_uid",
    "packing_number": "b.packing_number",
    "qty": "b.qty",
    "item_code": "dp.item_dcode",
    "acc_name": "COALESCE(b.override_cust::text, dp.acc_code::text)",
    "download_count": "b.download_count",
    "last_downloaded_at": `COALESCE(last_log.downloaded_at, ${packingBulkMaxAt}, b.created_at)`,
  };

  const sortByField = ALLOWED_SORT_FIELDS[sort.by] || "b.created_at";
  const sortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const countResult = await dbQuery(
    `SELECT COUNT(*) AS count 
     FROM ims_box_table b
     LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
     ${lastLogLateral}
     ${whereClause}`,
    countValues
  );
  const count = countResult[0]?.count || 0;

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT
      b.box_uid,
      b.box_no_uid,
      b.packing_number,
      b.qty,
      b.override_cust,
      b.download_count,
      dp.item_dcode AS itemdcode,
      COALESCE(b.override_cust::text, dp.acc_code::text) AS acc_name, 
      COALESCE(last_log.downloaded_at, ${packingBulkMaxAt}, b.created_at) AS last_downloaded_at,
      last_log.downloaded_by_name AS last_downloaded_by_name,
      last_log.download_type AS last_download_type,
      last_log.bulk_sticker_count AS last_bulk_sticker_count
    FROM ims_box_table b
    LEFT JOIN ims_dailyprod dp ON NULLIF(TRIM(b.packing_number::text), '-') = NULLIF(TRIM(dp.doc_no::text), '-')
    ${lastLogLateral}
    ${whereClause}
    ORDER BY ${sortByField} ${sortOrder} NULLS LAST
    LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count) / safeLimit),
  };
}

/** One row per `ims_box_download_log` entry (default for sticker management UI). */
async function getStickerDownloadLogList(options = {}) {
  const { filters = {}, search = null, page = 1, limit = 10, sort = {} } = options;

  const values = [];
  let i = 1;
  const conditions = ["1=1"];

  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`l.downloaded_at >= $${i++}::timestamp`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`l.downloaded_at <= $${i++}::timestamp`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      COALESCE(b.box_no_uid, '-') ILIKE $${idx} OR
      COALESCE(l.box_uid::text, '-') ILIKE $${idx} OR
      COALESCE(b.packing_number::text, TRIM(l.bulk_packing_number::text), '-') ILIKE $${idx} OR
      COALESCE(l.cust_at_time, '-') ILIKE $${idx} OR
      COALESCE(dp.item_dcode::text, '-') ILIKE $${idx} OR
      COALESCE(b.override_cust::text, '-') ILIKE $${idx} OR
      COALESCE(pack_box.pack_override_cust, '-') ILIKE $${idx} OR
      COALESCE(dp.acc_code::text, '-') ILIKE $${idx} OR
      COALESCE(l.download_source::text, '-') ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const packingBoxCountSql = `(SELECT COUNT(*)::int FROM ims_box_table bt2 WHERE bt2.is_deleted = false AND TRIM(COALESCE(bt2.packing_number::text, '-')) = TRIM(COALESCE(l.bulk_packing_number::text, '-')))`;
  /** Stickers included in one bulk_pack log row (matches incrementDownloadCountBulk). */
  const bulkPackStickerCountSql = `GREATEST(1, COALESCE(NULLIF(l.bulk_sticker_count, 0), ${packingBoxCountSql}))`;

  const packingKeySql = `COALESCE(NULLIF(TRIM(b.packing_number::text), '-'), NULLIF(TRIM(l.bulk_packing_number::text), '-'))`;
  const customerAccCodeSql = `COALESCE(NULLIF(TRIM(b.override_cust::text), '-'), pack_box.pack_override_cust, NULLIF(TRIM(dp.acc_code::text), '-'))`;
  const customerDisplaySql = `COALESCE(NULLIF(TRIM(l.cust_at_time::text), '-'), ${customerAccCodeSql})`;

  const SORT_MAP = {
    last_downloaded_at: "l.downloaded_at",
    last_download_type: "l.download_type",
    packing_number: "COALESCE(b.packing_number, NULLIF(TRIM(l.bulk_packing_number::text), '-'))",
    box_no_uid: "b.box_no_uid",
    box_uid: "l.box_uid",
    created_at: "l.downloaded_at",
    event_sticker_count: `CASE WHEN l.download_type = 'bulk_pack' THEN (${bulkPackStickerCountSql})::int ELSE 1 END`,
    item_code: "dp.item_dcode",
    acc_name: customerDisplaySql,
    download_source: "l.download_source",
  };

  const sortByField = SORT_MAP[sort.by] || "l.downloaded_at";
  const sortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const baseFrom = `
    FROM ims_box_download_log l
    LEFT JOIN ${M.USERS} u ON u.id = l.downloaded_by
    LEFT JOIN ims_box_table b ON b.box_uid = l.box_uid AND b.is_deleted = false
    LEFT JOIN LATERAL (
      SELECT MAX(NULLIF(TRIM(bt.override_cust::text), '-')) AS pack_override_cust
      FROM ims_box_table bt
      WHERE bt.is_deleted = false
        AND TRIM(COALESCE(bt.packing_number::text, '-')) = TRIM(${packingKeySql})
        AND TRIM(${packingKeySql}) <> '-'
    ) pack_box ON true
    LEFT JOIN LATERAL (
      SELECT dp.*
      FROM ims_dailyprod dp
      WHERE dp.doc_no::text = ${packingKeySql}
      LIMIT 1
    ) dp ON true
  `;

  const countValues = [...values];
  const countResult = await dbQuery(
    `SELECT COUNT(*)::int AS count ${baseFrom} ${whereClause}`,
    countValues
  );
  const count = countResult[0]?.count || 0;

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT
        l.log_id,
        l.box_uid,
        b.box_no_uid,
        COALESCE(b.packing_number, NULLIF(TRIM(l.bulk_packing_number::text), '-')) AS packing_number,
        b.override_cust,
        l.cust_at_time,
        ${customerAccCodeSql} AS acc_code,
        ${customerDisplaySql} AS acc_name,
        dp.item_dcode AS itemdcode,
        CASE
          WHEN l.download_type = 'bulk_pack' THEN (${bulkPackStickerCountSql})::int
          ELSE 1
        END AS event_sticker_count,
        l.downloaded_at AS last_downloaded_at,
        u.name AS last_downloaded_by_name,
        l.download_type AS last_download_type,
        l.bulk_sticker_count AS last_bulk_sticker_count,
        l.download_source,
        CASE
          WHEN b.box_no_uid IS NOT NULL AND TRIM(b.box_no_uid::text) <> '-' THEN b.box_no_uid
          WHEN l.download_type = 'bulk_pack' THEN 'ALL'
          ELSE COALESCE(l.box_uid::text, CONCAT('log-', l.log_id::text))
        END AS primary_label
    ${baseFrom}
    ${whereClause}
    ORDER BY ${sortByField} ${sortOrder} NULLS LAST
    LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count, 10),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(parseInt(count, 10) / safeLimit),
  };
}

export const getStickerManagementList = async (options = {}) => {
  const mode = String(options.list_mode || "log").toLowerCase();
  if (mode === "box") return getStickerBoxManagementList(options);
  return getStickerDownloadLogList(options);
};

export const insertOverrideRequest = async ({ packing_number, itemdcode, box_uids, from_customer, to_customer, remarks, requested_by, approved = false }) => {
  const approved_by = approved ? requested_by : null;
  const approved_at = approved ? new Date() : null;
  const status = approved ? "approved" : "pending";

  const [row] = await dbQuery(
    `INSERT INTO ims_box_override_request
      (packing_number, itemdcode, box_uids, from_customer, to_customer, remarks, requested_by, approved, approved_by, approved_at, status)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [String(packing_number), String(itemdcode), box_uids.map((id) => String(id)), from_customer || null, to_customer, remarks || null, requested_by, approved, approved_by, approved_at, status]
  );
  return row;
};

export const listOverrideRequests = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10 } = options;

  const values = [];
  let i = 1;
  const conditions = ["1=1"];

  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`r.requested_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`r.requested_at <= $${i++}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${i++}`);
  }

  const searchText = search != null ? String(search).trim() : "";
  if (searchText) {
    const searchTerm = `%${searchText}%`;
    values.push(searchTerm);
    const idx = i++;
    conditions.push(`(
      r.packing_number::TEXT ILIKE $${idx} OR
      r.itemdcode::TEXT ILIKE $${idx} OR
      r.from_customer::TEXT ILIKE $${idx} OR
      r.to_customer::TEXT ILIKE $${idx} OR
      r.remarks ILIKE $${idx} OR
      r.request_id::TEXT ILIKE $${idx} OR
      req_user.name ILIKE $${idx} OR
      app_user.name ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ims_box_table b
        WHERE b.box_uid::TEXT = ANY(r.box_uids::TEXT[])
          AND b.box_no_uid::TEXT ILIKE $${idx}
      )
    )`);
  }

  const joins = `
    LEFT JOIN ${M.USERS} req_user ON req_user.id = r.requested_by
    LEFT JOIN ${M.USERS} app_user ON app_user.id = r.approved_by
  `;

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countRes = await dbQuery(
    `SELECT COUNT(*) as count FROM ims_box_override_request r ${joins} ${whereClause}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || 10);
  const offset = (safePage - 1) * safeLimit;

  const sortMapping = {
    request_id: "r.request_id",
    packing_number: "r.packing_number",
    requested_at: "r.requested_at",
    status: "r.status",
    requested_by_name: "req_user.name",
    approved_by_name: "app_user.name",
    from_customer_name: "r.from_customer",
    to_customer_name: "r.to_customer",
    item_name: "r.itemdcode",
    itemdcode: "r.itemdcode",
  };

  const orderByColumn = sortMapping[sort.sortBy] || sortMapping[sort.by] || "r.requested_at";
  const orderDir = sort.order === "ASC" ? "ASC" : "DESC";

  const queryValues = [...values, safeLimit, offset];
  
  const sql = `
    SELECT
      r.*,
      req_user.name AS requested_by_name,
      app_user.name AS approved_by_name,
      r.from_customer AS from_customer_name,
      r.to_customer AS to_customer_name,
      r.itemdcode AS item_name,
      (
        SELECT ARRAY_AGG(b.box_no_uid)
        FROM ims_box_table b
        WHERE b.box_uid::TEXT = ANY(r.box_uids::TEXT[])
      ) AS box_no_uids
    FROM ims_box_override_request r
    ${joins}
    ${whereClause}
    ORDER BY ${orderByColumn} ${orderDir}
    LIMIT $${i++} OFFSET $${i++}
  `;

  const rows = await dbQuery(sql, queryValues);

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit)
  };
};

export const getOverrideRequestById = async (request_id) => {
  const [row] = await dbQuery(
    `SELECT * FROM ims_box_override_request WHERE request_id = $1 LIMIT 1`,
    [request_id]
  );
  return row || null;
};

export const updateOverrideRequest = async (request_id, fields = {}) => {
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return null;
  const set = fieldKeys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = [request_id, ...Object.values(fields)];
  const [row] = await dbQuery(
    `UPDATE ims_box_override_request
     SET ${set}
     WHERE request_id = $1
     RETURNING *`,
    values
  );
  return row || null;
};

// Inward Entry Controllers
// After inward: set box location and in_uid
export const updateBoxesAfterInward = async (in_uid, location_id, boxes, userId, options = {}) => {
  const { logEvent = true } = options;
  const query = `
    UPDATE ims_box_table 
    SET location_id = $1, 
        in_uid = $2, 
        updated_by = $3, 
        updated_at = NOW() 
    WHERE box_no_uid = ANY($4)
      AND is_deleted = false
      AND (out_uid IS NULL OR NULLIF(TRIM(out_uid::text), '-') IS NULL)
      AND (sa_entry_type IS DISTINCT FROM 'stock_out')
    RETURNING *`;

  const rows = await dbQuery(query, [location_id, in_uid, userId, boxes]);
  if (logEvent && rows?.length) {
    logBoxTransactionSafe({
      transaction_type: BOX_TX_TYPES.INWARD_LINK,
      source_module: "inventory_inward",
      source_id: String(in_uid),
      packing_number: singlePackingFromRows(rows),
      user_id: userId,
      rows,
      details: {
        in_uid,
        location_id,
        packing_numbers: [...new Set(rows.map((r) => r.packing_number).filter(Boolean))],
      },
    });
  }
  return rows;
};

export const getPackingNumberFromBox = async (box_no_uid) => {
  const [row] = await dbQuery(
    `SELECT packing_number FROM ims_box_table WHERE box_no_uid = $1 LIMIT 1`,
    [box_no_uid]
  );
  return row ? row.packing_number : null;
};

/** Distinct non-empty packing numbers for the given box_no_uid list (stable sort). Used for inward header when multiple packings are stored on one inward. */
export const getDistinctPackingNumbersFromBoxNoUids = async (boxNoUids = []) => {
  const uniq = [...new Set((boxNoUids || []).map((u) => (u != null ? String(u).trim() : "")).filter(Boolean))];
  if (uniq.length === 0) return [];
  const rows = await dbQuery(
    `SELECT DISTINCT TRIM(packing_number::text) AS pn
     FROM ims_box_table
     WHERE is_deleted = false
       AND box_no_uid = ANY($1::text[])
       AND packing_number IS NOT NULL
       AND TRIM(packing_number::text) <> '-'`,
    [uniq]
  );
  const seen = [...new Set((rows || []).map((r) => String(r.pn).trim()).filter(Boolean))];
  return seen.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
};