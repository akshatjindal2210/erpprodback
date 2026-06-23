import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

/** QC Hold Material — DB access for ims_qc_hold_material (list, CRUD, reasons). */

const TABLE = "ims_qc_hold_material";

const ALLOWED_FILTER_FIELDS = [
  "hold_id",
  "packing_number",
  "item_dcode",
  "status",
  "approved",
  "is_deleted",
  "from_date",
  "to_date",
];

const SORT_EXPR = {
  hold_id: "q.hold_id",
  packing_number: "q.packing_number",
  item_dcode: "q.item_dcode",
  qty: "COALESCE((q.hold_data->>'qty')::int, 0)",
  status: "q.status",
  created_at: "q.created_at",
  approved: "q.approved",
};

const JOINS = `
  LEFT JOIN ${M.USERS} u_cr ON q.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON q.updated_by = u_up.id
  LEFT JOIN ${M.USERS} u_ap ON q.approved_by = u_ap.id
  LEFT JOIN ${M.USERS} u_dl ON q.deleted_by = u_dl.id
`;

const DEFAULT_FIELDS = [
  "q.hold_id",
  "q.packing_number",
  "q.item_dcode",
  "q.item_dcode::text AS item_code",
  "q.status",
  "q.reason",
  "q.remarks",
  "q.hold_data",
  "q.approved",
  "q.approved_by",
  "q.approved_at",
  "q.created_by",
  "q.created_at",
  "q.updated_by",
  "q.updated_at",
  "q.deleted_by",
  "q.deleted_at",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
  "u_dl.name AS deleted_by_name",
];

const assertField = (key, whitelist, context = "field") => {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
};

function toJsonbParam(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function mapInsertValues(data) {
  return Object.keys(data).map((k) => (k === "hold_data" ? toJsonbParam(data[k]) : data[k]));
}

export const findQcHoldMaterials = async (options = {}) => {
  const {
    filters = {},
    sort = {},
    page = 1,
    limit = 10,
    search = null,
    permission = {},
  } = options;

  const values = [];
  let i = 1;
  const conditions = ["q.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`q.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`q.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`q.created_at <= $${i++}`);
      continue;
    }
    if (key === "open_only") {
      const truthy = val === true || val === "true" || val === "1" || val === 1;
      if (truthy) {
        conditions.push(`COALESCE(q.status, 'pending') IN ('pending', 'partial')`);
      }
      continue;
    }
    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`q.${key} = $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      CAST(q.hold_id AS TEXT) ILIKE $${i} OR
      COALESCE(q.packing_number::text, '') ILIKE $${i} OR
      CAST(q.item_dcode AS TEXT) ILIKE $${i} OR
      COALESCE(q.remarks, '') ILIKE $${i} OR
      COALESCE(q.reason, '') ILIKE $${i} OR
      COALESCE(q.status, '') ILIKE $${i}
    )`);
    i++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const safeSortBy = SORT_EXPR[sort.by] ? sort.by : "hold_id";
  const sortExpr = SORT_EXPR[safeSortBy] || SORT_EXPR.hold_id;
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${TABLE} q ${JOINS} ${whereClause}`,
    countValues
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} q
     ${JOINS}
     ${whereClause}
     ORDER BY ${sortExpr} ${safeSortOrder}
     LIMIT $${i++} OFFSET $${i++}`,
    values
  );

  return { data: rows, total: parseInt(count, 10), page: safePage, limit: safeLimit };
};

export const findQcHoldMaterialById = async (hold_id) => {
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} q
     ${JOINS}
     WHERE q.hold_id = $1 AND q.is_deleted = false
     LIMIT 1`,
    [hold_id]
  );
  return rows[0] || null;
};

export const insertQcHoldMaterial = async (data) => {
  const keys = Object.keys(data);
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
  const rows = await dbQuery(
    `INSERT INTO ${TABLE} (${keys.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    mapInsertValues(data)
  );
  return rows[0] || null;
};

export const updateQcHoldMaterial = async (hold_id, data) => {
  const keys = Object.keys(data);
  if (!keys.length) return findQcHoldMaterialById(hold_id);
  const sets = keys.map((k, idx) => `${k} = $${idx + 2}`).join(", ");
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET ${sets}
     WHERE hold_id = $1 AND is_deleted = false
     RETURNING *`,
    [
      hold_id,
      ...keys.map((k) => (k === "hold_data" ? toJsonbParam(data[k]) : data[k])),
    ]
  );
  return rows[0] || null;
};

export const findActiveQcHoldParents = async (search = null, { requireInStoreBoxes = false } = {}) => {
  const values = [];
  let i = 1;
  const conditions = [
    "q.is_deleted = false",
    "q.approved = true",
    "COALESCE(q.hold_data->>'hold_type', 'pending_hold') = 'pending_hold'",
    `(
      COALESCE((q.hold_data->>'qty')::int, 0)
      - COALESCE((q.hold_data->>'completed_qty')::int, 0)
      - COALESCE((q.hold_data->>'rejected_qty')::int, 0)
    ) > 0`,
  ];
  if (requireInStoreBoxes) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM ims_box_table b
      WHERE b.is_deleted = false
        AND b.qc_hold_id = q.hold_id
        AND b.out_uid IS NULL
        AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
        AND (b.location_id IS NOT NULL OR b.in_uid IS NOT NULL)
    )`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      CAST(q.hold_id AS TEXT) ILIKE $${i} OR
      COALESCE(q.packing_number::text, '') ILIKE $${i} OR
      COALESCE(q.item_dcode::text, '') ILIKE $${i}
    )`);
    i++;
  }
  return dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} q
     ${JOINS}
     WHERE ${conditions.join(" AND ")}
     ORDER BY q.hold_id DESC
     LIMIT 200`,
    values
  );
};

export const softDeleteQcHoldMaterial = async (hold_id, deleted_by) => {
  const rows = await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
     WHERE hold_id = $1 AND is_deleted = false
     RETURNING hold_id`,
    [hold_id, deleted_by]
  );
  return rows[0] || null;
};

/** Distinct reasons from hold row + submission JSON (dropdown suggestions). */
export const findDistinctQcHoldReasons = async ({ search, limit = 200 } = {}) => {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const values = [];
  let i = 1;
  let searchClause = "";
  if (search && String(search).trim()) {
    values.push(`%${String(search).trim().slice(0, 100)}%`);
    searchClause = `AND reason ILIKE $${i++}`;
  }

  const rows = await dbQuery(
    `SELECT reason, MAX(last_used_at) AS last_used_at
     FROM (
       SELECT BTRIM(q.reason) AS reason, q.created_at AS last_used_at
       FROM ${TABLE} q
       WHERE q.is_deleted = false AND BTRIM(COALESCE(q.reason, '')) <> ''

       UNION ALL

       SELECT BTRIM(sub.elem->>'reason') AS reason,
              COALESCE(
                NULLIF(sub.elem->>'created_at', '')::timestamptz,
                q.created_at
              ) AS last_used_at
       FROM ${TABLE} q
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.hold_data->'submissions', '[]'::jsonb)) AS sub(elem)
       WHERE q.is_deleted = false
         AND BTRIM(COALESCE(sub.elem->>'reason', '')) <> ''
         AND COALESCE(sub.elem->>'is_deleted', 'false') <> 'true'
     ) combined
     WHERE BTRIM(COALESCE(reason, '')) <> ''
     ${searchClause}
     GROUP BY reason
     ORDER BY last_used_at DESC NULLS LAST, reason ASC
     LIMIT $${i}`,
    [...values, safeLimit]
  );

  return rows || [];
};
