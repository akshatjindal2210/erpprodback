/**
 * Change Override Customer — DB list + row enrich.
 *
 * Table: ims_box_override_request (r)
 * Joins: users for requested_by / approved_by names
 * Extra:  box_no_uids subquery from ims_box_table via r.box_uids
 *
 * Filters: from_date, to_date, status
 * Search:  packing, item, customers, remarks, request_id, user names, box_no_uid
 */

import dbQuery from "../../../../config/db.js";
import { MST_TABLES as M } from "../../../../config/dbTables.js";
import { canonicalCode, getImsMapsSafe } from "../erp-api/imsLookup.js";

const USER_JOINS = `
  LEFT JOIN ${M.USERS} req_user ON req_user.id = r.requested_by
  LEFT JOIN ${M.USERS} app_user ON app_user.id = r.approved_by
`;

const SORT_COLUMNS = {
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

function buildListWhere({ filters = {}, search }) {
  const values = [];
  let paramIdx = 1;
  const conditions = ["1=1"];

  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`r.requested_at >= $${paramIdx++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`r.requested_at <= $${paramIdx++}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${paramIdx++}`);
  }

  const searchText = search != null ? String(search).trim() : "";
  if (searchText) {
    const searchTerm = `%${searchText}%`;
    values.push(searchTerm);
    const idx = paramIdx++;
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

  return { whereClause: `WHERE ${conditions.join(" AND ")}`, values, nextParamIdx: paramIdx };
}

export async function listOverrideRequests(options = {}) {
  const { filters = {}, search, sort = {}, page = 1, limit = 10 } = options;
  const { whereClause, values, nextParamIdx } = buildListWhere({ filters, search });

  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count
     FROM ims_box_override_request r
     ${USER_JOINS}
     ${whereClause}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || 10);
  const offset = (safePage - 1) * safeLimit;

  const orderByColumn =
    SORT_COLUMNS[sort.sortBy] || SORT_COLUMNS[sort.by] || SORT_COLUMNS.requested_at;
  const orderDir = sort.order === "ASC" ? "ASC" : "DESC";

  const queryValues = [...values, safeLimit, offset];
  const limitIdx = nextParamIdx;
  const offsetIdx = nextParamIdx + 1;

  const rows = await dbQuery(
    `SELECT
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
     ${USER_JOINS}
     ${whereClause}
     ORDER BY ${orderByColumn} ${orderDir}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    queryValues
  );

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
}

export async function enrichOverrideCustomerListRows(rows = []) {
  if (!rows?.length) return rows || [];

  const { itemMap, ledgerMap } = await getImsMapsSafe();
  return rows.map((row) => {
    const itemCode = canonicalCode(row.itemdcode);
    const item = itemCode ? itemMap.get(itemCode) : null;
    const fromCode = canonicalCode(row.from_customer);
    const toCode = canonicalCode(row.to_customer);

    return {
      ...row,
      from_customer_name:
        (fromCode ? ledgerMap.get(fromCode) : null) ?? row.from_customer_name ?? null,
      to_customer_name:
        (toCode ? ledgerMap.get(toCode) : null) ?? row.to_customer_name ?? null,
      item_name: item?.item_code ?? row.item_name ?? null,
      item_code: item?.item_code ?? row.item_code ?? null,
    };
  });
}

export async function insertOverrideRequest({
  packing_number,
  itemdcode,
  box_uids,
  from_customer,
  to_customer,
  remarks,
  requested_by,
  approved = false,
}) {
  const approved_by = approved ? requested_by : null;
  const approved_at = approved ? new Date() : null;
  const status = approved ? "approved" : "pending";

  const [row] = await dbQuery(
    `INSERT INTO ims_box_override_request
       (packing_number, itemdcode, box_uids, from_customer, to_customer, remarks,
        requested_by, approved, approved_by, approved_at, status)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      String(packing_number),
      String(itemdcode),
      box_uids.map((id) => String(id)),
      from_customer || null,
      to_customer,
      remarks || null,
      requested_by,
      approved,
      approved_by,
      approved_at,
      status,
    ]
  );
  return row;
}

export async function getOverrideRequestById(request_id) {
  const [row] = await dbQuery(
    `SELECT * FROM ims_box_override_request WHERE request_id = $1 LIMIT 1`,
    [request_id]
  );
  return row || null;
}

export async function updateOverrideRequest(request_id, fields = {}) {
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
}
