import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { hydrateCriteriaFromLegacy } from "../utils/specPayload.js";

const TABLE = T.MASTER_SPEC;

const ALLOWED_FILTER_FIELDS = [
  "item_dcode", "spec_type", "approved", "approval_status", "from_date", "to_date",
];

const ALLOWED_ITEM_SORT_FIELDS = [
  "item_dcode", "item_code", "item_desc", "spec_count",
  "created_at", "updated_at", "approved_at",
];

const DEFAULT_FIELDS = [
  "sm.spec_id", "sm.item_dcode", "sm.item_code", "sm.item_desc",
  "sm.condition", "sm.grade", "sm.size",
  "sm.sno", "sm.type", "sm.spec_name", "sm.remarks", "sm.print_val",
  "sm.spec_type", "sm.min_value", "sm.max_value",
  "sm.correct_option", "sm.incorrect_option",
  "sm.document_required",
  "sm.approved", "sm.approved_by", "sm.approved_at",
  "sm.created_by", "sm.created_at", "sm.updated_by", "sm.updated_at",
  "sm.deleted_by", "sm.deleted_at",
  "sm.created_by AS created_by_name",
  "sm.updated_by AS updated_by_name",
  "sm.approved_by AS approved_by_name",
  "sm.deleted_by AS deleted_by_name",
];

function mapRow(row) {
  if (!row) return null;
  const criteria = hydrateCriteriaFromLegacy(row.spec_type, row);
  return {
    ...row,
    min_value: criteria.min_value,
    max_value: criteria.max_value,
    correct_option: criteria.correct_option,
    incorrect_option: criteria.incorrect_option,
    document_required: Boolean(row.document_required),
  };
}

function approvalStatus(spec_count, approvedLines) {
  if (spec_count <= 0) return "pending";
  if (approvedLines >= spec_count) return "authorized";
  if (approvedLines <= 0) return "pending";
  return "partial";
}

function mapItemGroup(row) {
  if (!row) return null;
  const spec_count = Number(row.spec_count || 0);
  const approvedLines = Number(row.approved_lines || 0);
  const status = approvalStatus(spec_count, approvedLines);
  return {
    item_dcode: row.item_dcode,
    item_code: row.item_code,
    item_desc: row.item_desc,
    condition: row.condition || null,
    grade: row.grade || null,
    size: row.size || null,
    spec_count,
    approval_status: status,
    approved: status === "authorized",
    spec_names: row.spec_names || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
    created_by_name: row.created_by_name ?? null,
    updated_by_name: row.updated_by_name ?? null,
    approved_by_name: row.approved_by_name ?? null,
  };
}

/** List one row per RM item with aggregated approval / line counts. */
export const findSpecItems = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10 } = options;
  const values = [];
  let i = 1;
  const conditions = ["sm.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (key === "from_date") {
      values.push(val);
      conditions.push(`sm.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`sm.created_at <= $${i++}`);
      continue;
    }
    if (key === "approval_status" || key === "approved") {
      const status = key === "approval_status"
        ? String(val).toLowerCase()
        : (val === true || val === "true" || val === 1 || val === "1" || val === "approved" || val === "authorized")
          ? "authorized"
          : (val === false || val === "false" || val === 0 || val === "0" || val === "pending")
            ? "pending"
            : String(val).toLowerCase();

      if (status === "authorized" || status === "approved") {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM ${TABLE} p
          WHERE p.item_dcode = sm.item_dcode AND p.is_deleted = false AND p.approved = false
        )`);
      } else if (status === "pending") {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM ${TABLE} p
          WHERE p.item_dcode = sm.item_dcode AND p.is_deleted = false AND p.approved = true
        )`);
      } else if (status === "partial") {
        conditions.push(`EXISTS (
          SELECT 1 FROM ${TABLE} p
          WHERE p.item_dcode = sm.item_dcode AND p.is_deleted = false AND p.approved = true
        )`);
        conditions.push(`EXISTS (
          SELECT 1 FROM ${TABLE} p
          WHERE p.item_dcode = sm.item_dcode AND p.is_deleted = false AND p.approved = false
        )`);
      }
      continue;
    }
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`sm.${key} = $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      sm.item_dcode::text ILIKE $${idx} OR
      COALESCE(sm.item_code, '') ILIKE $${idx} OR
      COALESCE(sm.item_desc, '') ILIKE $${idx} OR
      COALESCE(sm.condition, '') ILIKE $${idx} OR
      COALESCE(sm.grade, '') ILIKE $${idx} OR
      COALESCE(sm.size, '') ILIKE $${idx} OR
      COALESCE(sm.spec_name, '') ILIKE $${idx} OR
      COALESCE(sm.type, '') ILIKE $${idx} OR
      COALESCE(sm.print_val, '') ILIKE $${idx} OR
      COALESCE(sm.spec_type, '') ILIKE $${idx} OR
      COALESCE(sm.remarks, '') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM (
       SELECT sm.item_dcode FROM ${TABLE} sm ${where} GROUP BY sm.item_dcode
     ) g`,
    values
  );
  const count = Number(countRes[0]?.count || 0);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortBy = ALLOWED_ITEM_SORT_FIELDS.includes(sort.by) ? sort.by : "item_code";
  const sortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const sortExpr = sortBy === "item_code" || sortBy === "item_desc"
    ? `MAX(sm.${sortBy})`
    : sortBy === "spec_count"
      ? "COUNT(*)"
      : sortBy === "created_at"
        ? "MIN(sm.created_at)"
        : sortBy === "updated_at"
          ? "MAX(COALESCE(sm.updated_at, sm.created_at))"
          : sortBy === "approved_at"
            ? "MAX(sm.approved_at)"
            : `sm.${sortBy}`;

  const dataValues = [...values, safeLimit, offset];
  const rows = await dbQuery(
    `SELECT
       sm.item_dcode,
       MAX(sm.item_code) AS item_code,
       MAX(sm.item_desc) AS item_desc,
       MAX(sm.condition) AS condition,
       MAX(sm.grade) AS grade,
       MAX(sm.size) AS size,
       COUNT(*)::int AS spec_count,
       COUNT(*) FILTER (WHERE sm.approved = true)::int AS approved_lines,
       STRING_AGG(sm.spec_name, ', ' ORDER BY sm.sno) AS spec_names,
       MIN(sm.created_at) AS created_at,
       MAX(COALESCE(sm.updated_at, sm.created_at)) AS updated_at,
       MAX(sm.approved_at) AS approved_at,
       (ARRAY_AGG(sm.created_by ORDER BY sm.created_at ASC))[1] AS created_by_name,
       (ARRAY_AGG(sm.updated_by ORDER BY COALESCE(sm.updated_at, sm.created_at) DESC NULLS LAST))[1] AS updated_by_name,
       (ARRAY_AGG(sm.approved_by ORDER BY sm.approved_at DESC NULLS LAST))[1] AS approved_by_name
     FROM ${TABLE} sm
     ${where}
     GROUP BY sm.item_dcode
     ORDER BY ${sortExpr} ${sortOrder}, sm.item_dcode ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    dataValues
  );

  return {
    data: (rows || []).map(mapItemGroup),
    total: count,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(count / safeLimit),
  };
};

export const findSpecsByItem = async (item_dcode) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) return [];
  const rows = await dbQuery(
    `SELECT ${DEFAULT_FIELDS.join(", ")}
     FROM ${TABLE} sm
     WHERE sm.is_deleted = false AND sm.item_dcode = $1
     ORDER BY sm.sno ASC, sm.spec_id ASC`,
    [item]
  );
  return (rows || []).map(mapRow);
};

export const findSpecItemDetail = async (item_dcode) => {
  const specs = await findSpecsByItem(item_dcode);
  if (!specs.length) return null;
  const first = specs[0];
  const approvedLines = specs.filter((s) => s.approved).length;
  const spec_count = specs.length;
  const status = approvalStatus(spec_count, approvedLines);
  return {
    item_dcode: first.item_dcode,
    item_code: first.item_code,
    item_desc: first.item_desc,
    condition: first.condition || null,
    grade: first.grade || null,
    size: first.size || null,
    spec_count,
    approval_status: status,
    approved: status === "authorized",
    specs,
  };
};

/**
 * Replace all active lines for an item.
 * Approval is applied uniformly to every line (item-level authorize).
 */
export const syncItemSpecs = async ({
  item_dcode,
  source_item_dcode,
  item_code,
  item_desc,
  specs,
  userName,
  approval = { approved: false, approved_by: null, approved_at: null },
}) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) throw new Error("The RM item code is invalid.");
  const sourceItem = Number(source_item_dcode);
  const lookupItem = Number.isFinite(sourceItem) && sourceItem > 0 ? sourceItem : item;

  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM ${TABLE}
       WHERE is_deleted = false AND item_dcode = $1
       ORDER BY sno ASC`,
      [lookupItem]
    );
    const existing = existingRes.rows || [];
    const byId = new Map(existing.map((r) => [Number(r.spec_id), r]));

    const keepIds = new Set(
      specs
        .map((s) => (s.spec_id != null ? Number(s.spec_id) : null))
        .filter((id) => id != null && byId.has(id))
    );

    for (const row of existing) {
      if (!keepIds.has(Number(row.spec_id))) {
        await client.query(
          `UPDATE ${TABLE}
           SET is_deleted = true, deleted_at = NOW(), deleted_by = $1
           WHERE spec_id = $2 AND is_deleted = false`,
          [userName ?? null, row.spec_id]
        );
      }
    }

    for (const id of keepIds) {
      await client.query(
        `UPDATE ${TABLE} SET sno = -$1 WHERE spec_id = $1 AND is_deleted = false`,
        [id]
      );
    }

    const isApproved = approval.approved === true;
    const result = [];

    for (const line of specs) {
      const matchId = line.spec_id != null && keepIds.has(Number(line.spec_id))
        ? Number(line.spec_id)
        : null;
      const documentRequired = line.document_required === true;
      const values = [
        item,
        item_code ?? null,
        item_desc ?? null,
        line.condition ?? null,
        line.grade ?? null,
        line.size ?? null,
        line.sno,
        line.type ?? null,
        line.spec_name ?? null,
        line.remarks ?? null,
        line.print_val ?? null,
        line.spec_type ?? null,
        line.min_value ?? 0,
        line.max_value ?? 0,
        line.correct_option ?? null,
        line.incorrect_option ?? null,
        documentRequired,
      ];

      if (matchId) {
        const [row] = (await client.query(
          `UPDATE ${TABLE} SET
             item_dcode = $1, item_code = $2, item_desc = $3,
             condition = $4, grade = $5, size = $6,
             sno = $7, type = $8, spec_name = $9, remarks = $10, print_val = $11,
             spec_type = $12, min_value = $13, max_value = $14,
             correct_option = $15, incorrect_option = $16,
             document_required = $17,
             approved = $18, approved_by = $19, approved_at = $20,
             updated_by = $21, updated_at = NOW()
           WHERE spec_id = $22 AND is_deleted = false
           RETURNING *`,
          [
            ...values,
            isApproved,
            isApproved ? approval.approved_by : null,
            isApproved ? approval.approved_at : null,
            userName ?? null,
            matchId,
          ]
        )).rows;
        result.push(mapRow(row));
      } else {
        const [row] = (await client.query(
          `INSERT INTO ${TABLE}
           (item_dcode, item_code, item_desc, condition, grade, size,
            sno, type, spec_name, remarks, print_val,
            spec_type, min_value, max_value, correct_option, incorrect_option,
            document_required, created_by, approved, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING *`,
          [
            ...values,
            userName ?? null,
            isApproved,
            isApproved ? approval.approved_by : null,
            isApproved ? approval.approved_at : null,
          ]
        )).rows;
        result.push(mapRow(row));
      }
    }

    return result;
  });
};

/** Soft-delete every active line for an item. */
export const deleteSpecsByItem = async (item_dcode, meta = {}) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) throw new Error("The RM item code is invalid.");
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $1
     WHERE item_dcode = $2 AND is_deleted = false`,
    [meta.deleted_by ?? null, item]
  );
};

/** Apply the same approval state to every active line for an item. */
export const setItemApproval = async (item_dcode, approvalFields = {}) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) throw new Error("The RM item code is invalid.");

  const fields = {};
  for (const k of ["approved", "approved_by", "approved_at", "updated_by", "updated_at"]) {
    if (approvalFields[k] !== undefined) fields[k] = approvalFields[k];
  }
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const values = keys.map((k) => fields[k]);
  values.push(item);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

  await dbQuery(
    `UPDATE ${TABLE} SET ${setClause}
     WHERE item_dcode = $${keys.length + 1} AND is_deleted = false`,
    values
  );
};
