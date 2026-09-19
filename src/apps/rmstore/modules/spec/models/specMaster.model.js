import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { hydrateCriteriaFromLegacy } from "../utils/specPayload.js";

const HEADER = T.SPEC_MASTER;
const LINES = T.SPEC_DETAIL;

const LINE_JOIN = `
  FROM ${LINES} sl
  JOIN ${HEADER} si ON si.spec_item_id = sl.spec_item_id
`;

const ALLOWED_FILTER_FIELDS = [
  "item_dcode", "spec_type", "approved", "approval_status", "from_date", "to_date",
];

const ALLOWED_ITEM_SORT_FIELDS = [
  "item_dcode", "item_code", "item_desc", "spec_count",
  "created_at", "updated_at", "approved_at",
];

const DEFAULT_FIELDS = [
  "sl.spec_id", "si.item_dcode", "si.item_code", "si.item_desc",
  "si.condition", "si.grade", "si.size", "si.condition_color", "si.grade_color",
  "si.type", "sl.sno", "sl.spec_name", "sl.remarks", "sl.print_val",
  "sl.inspection_method",
  "sl.spec_type", "sl.min_value", "sl.max_value",
  "sl.correct_option", "sl.incorrect_option",
  "sl.document_required",
  "si.approved", "si.approved_by", "si.approved_at",
  "si.created_by", "si.created_at", "si.updated_by", "si.updated_at",
  "si.deleted_by", "si.deleted_at",
  "si.created_by AS created_by_name",
  "si.updated_by AS updated_by_name",
  "si.approved_by AS approved_by_name",
  "si.deleted_by AS deleted_by_name",
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

function approvalStatus(spec_count, headerApproved) {
  if (spec_count <= 0) return "pending";
  return headerApproved ? "authorized" : "pending";
}

function mapItemGroup(row) {
  if (!row) return null;
  const spec_count = Number(row.spec_count || 0);
  const headerApproved = row.approved === true;
  const status = approvalStatus(spec_count, headerApproved);
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : null;
  const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : null;
  const hasRealUpdate = updatedMs != null && (createdMs == null || updatedMs - createdMs > 2000);
  return {
    item_dcode: row.item_dcode,
    item_code: row.item_code,
    item_desc: row.item_desc,
    condition: row.condition || null,
    grade: row.grade || null,
    size: row.size || null,
    condition_color: row.condition_color || null,
    grade_color: row.grade_color || null,
    type: row.type || null,
    spec_count,
    approval_status: status,
    approved: status === "authorized",
    spec_names: row.spec_names || null,
    inspection_methods: row.inspection_methods || null,
    created_at: row.created_at,
    updated_at: hasRealUpdate ? row.updated_at : null,
    approved_at: row.approved_at,
    created_by_name: row.created_by_name ?? null,
    updated_by_name: hasRealUpdate ? row.updated_by_name ?? null : null,
    approved_by_name: row.approved_by_name ?? null,
  };
}

async function findHeaderByItemDcode(item_dcode, { client = null, includeDeleted = false } = {}) {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) return null;
  const deletedClause = includeDeleted ? "" : "AND si.is_deleted = false";
  const sql = `SELECT si.*
     FROM ${HEADER} si
     WHERE si.item_dcode = $1 ${deletedClause}
     LIMIT 1`;
  if (client) {
    const res = await client.query(sql, [item]);
    return res.rows?.[0] ?? null;
  }
  const rows = await dbQuery(sql, [item]);
  return rows?.[0] ?? null;
}

/** List one row per RM item with aggregated approval / line counts. */
export const findSpecItems = async (options = {}) => {
  const { filters = {}, search, sort = {}, page = 1, limit = 10 } = options;
  const values = [];
  let i = 1;
  const conditions = ["si.is_deleted = false"];

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;
    if (key === "from_date") {
      values.push(val);
      conditions.push(`si.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date") {
      values.push(val);
      conditions.push(`si.created_at <= $${i++}`);
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
        conditions.push(`si.approved = true`);
        conditions.push(`EXISTS (
          SELECT 1 FROM ${LINES} sl
          WHERE sl.spec_item_id = si.spec_item_id
        )`);
      } else if (status === "pending") {
        conditions.push(`(
          si.approved = false OR NOT EXISTS (
            SELECT 1 FROM ${LINES} sl
            WHERE sl.spec_item_id = si.spec_item_id
          )
        )`);
      } else if (status === "partial") {
        conditions.push(`si.approved = false`);
        conditions.push(`EXISTS (
          SELECT 1 FROM ${LINES} sl
          WHERE sl.spec_item_id = si.spec_item_id
        )`);
      }
      continue;
    }
    if (key === "spec_type") {
      values.push(val);
      conditions.push(`EXISTS (
        SELECT 1 FROM ${LINES} sl
        WHERE sl.spec_item_id = si.spec_item_id
          AND sl.spec_type = $${i++}
      )`);
      continue;
    }
    if (!ALLOWED_FILTER_FIELDS.includes(key)) continue;
    values.push(val);
    conditions.push(`si.${key} = $${i++}`);
  }

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      si.item_dcode::text ILIKE $${idx} OR
      COALESCE(si.item_code, '') ILIKE $${idx} OR
      COALESCE(si.item_desc, '') ILIKE $${idx} OR
      COALESCE(si.condition, '') ILIKE $${idx} OR
      COALESCE(si.grade, '') ILIKE $${idx} OR
      COALESCE(si.size, '') ILIKE $${idx} OR
      COALESCE(si.condition_color, '') ILIKE $${idx} OR
      COALESCE(si.grade_color, '') ILIKE $${idx} OR
      COALESCE(si.type, '') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${LINES} sl
        WHERE sl.spec_item_id = si.spec_item_id
          AND (
            COALESCE(sl.spec_name, '') ILIKE $${idx} OR
            COALESCE(sl.print_val, '') ILIKE $${idx} OR
            COALESCE(sl.spec_type, '') ILIKE $${idx} OR
            COALESCE(sl.remarks, '') ILIKE $${idx}
          )
      )
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM ${HEADER} si ${where}`,
    values,
  );
  const count = Number(countRes[0]?.count || 0);

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const sortBy = ALLOWED_ITEM_SORT_FIELDS.includes(sort.by) ? sort.by : "item_code";
  const sortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const sortExpr = sortBy === "item_code" || sortBy === "item_desc"
    ? `si.${sortBy}`
    : sortBy === "spec_count"
      ? "spec_count"
      : sortBy === "created_at"
        ? "si.created_at"
        : sortBy === "updated_at"
          ? "COALESCE(si.updated_at, si.created_at)"
          : sortBy === "approved_at"
            ? "si.approved_at"
            : `si.${sortBy}`;

  const dataValues = [...values, safeLimit, offset];
  const rows = await dbQuery(
    `SELECT
       si.item_dcode,
       si.item_code,
       si.item_desc,
       si.condition,
       si.grade,
       si.size,
       si.condition_color,
       si.grade_color,
       si.type,
       si.approved,
       COUNT(sl.spec_id)::int AS spec_count,
       STRING_AGG(sl.spec_name, ', ' ORDER BY sl.sno) AS spec_names,
       STRING_AGG(DISTINCT sl.inspection_method, ', ') AS inspection_methods,
       si.created_at,
       si.updated_at,
       si.approved_at,
       si.created_by AS created_by_name,
       si.updated_by AS updated_by_name,
       si.approved_by AS approved_by_name
     FROM ${HEADER} si
     LEFT JOIN ${LINES} sl ON sl.spec_item_id = si.spec_item_id
     ${where}
     GROUP BY si.spec_item_id
     ORDER BY ${sortExpr} ${sortOrder}, si.item_dcode ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    dataValues,
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
     ${LINE_JOIN}
     WHERE si.is_deleted = false AND si.item_dcode = $1
     ORDER BY sl.sno ASC, sl.spec_id ASC`,
    [item],
  );
  return (rows || []).map(mapRow);
};

/** Resolve RM Spec Master by ERP item code when item_dcode is missing on MRN/coil. */
export const findSpecItemDetailByItemCode = async (item_code) => {
  const code = String(item_code ?? "").trim();
  if (!code) return null;
  const rows = await dbQuery(
    `SELECT si.item_dcode
     FROM ${HEADER} si
     WHERE si.is_deleted = false
       AND UPPER(TRIM(COALESCE(si.item_code, ''))) = UPPER($1)
     ORDER BY si.item_dcode ASC
     LIMIT 1`,
    [code],
  );
  const itemDcode = rows?.[0]?.item_dcode;
  if (itemDcode == null) return null;
  return findSpecItemDetail(itemDcode);
};

/** Resolve RM Spec Master by item description (MRN often stores full desc in item_code/item_desc). */
export const findSpecItemDetailByItemDesc = async (item_desc) => {
  const desc = String(item_desc ?? "").trim();
  if (!desc) return null;
  const rows = await dbQuery(
    `SELECT si.item_dcode
     FROM ${HEADER} si
     WHERE si.is_deleted = false
       AND (
         UPPER(TRIM(COALESCE(si.item_desc, ''))) = UPPER($1)
         OR UPPER(TRIM(COALESCE(si.item_code, ''))) = UPPER($1)
       )
     ORDER BY si.item_dcode ASC
     LIMIT 1`,
    [desc],
  );
  const itemDcode = rows?.[0]?.item_dcode;
  if (itemDcode == null) return null;
  return findSpecItemDetail(itemDcode);
};

export const findSpecItemDetail = async (item_dcode) => {
  const header = await findHeaderByItemDcode(item_dcode);
  if (!header) return null;
  const specs = await findSpecsByItem(item_dcode);
  const spec_count = specs.length;
  const status = approvalStatus(spec_count, header.approved === true);
  return {
    item_dcode: header.item_dcode,
    item_code: header.item_code,
    item_desc: header.item_desc,
    condition: header.condition || null,
    grade: header.grade || null,
    size: header.size || null,
    condition_color: header.condition_color || null,
    grade_color: header.grade_color || null,
    type: header.type || null,
    spec_count,
    approval_status: status,
    approved: status === "authorized",
    specs,
  };
};

/** Block save/print flows until an authorized RM Spec Master exists for the item. */
export async function requireAuthorizedRmSpecForItem({ item_dcode, item_code, item_desc } = {}) {
  const dcode = Number(item_dcode);
  let detail = Number.isFinite(dcode) && dcode > 0 ? await findSpecItemDetail(dcode) : null;
  if (!detail && item_code) detail = await findSpecItemDetailByItemCode(item_code);
  if (!detail && item_desc) detail = await findSpecItemDetailByItemDesc(item_desc);

  const label = String(item_desc || item_code || item_dcode || "this RM item").trim();
  if (!detail || Number(detail.spec_count) <= 0) {
    const err = new Error(
      `No RM Spec Master exists for ${label}. Create the specifications first, then save this stock adjustment.`
    );
    err.statusCode = 400;
    throw err;
  }
  if (detail.approved !== true) {
    const err = new Error(
      `RM specifications for ${label} exist but are not authorized. Approve the spec first, then save this stock adjustment.`
    );
    err.statusCode = 400;
    throw err;
  }
  return detail;
}

/**
 * Replace all active lines for an item.
 * Approval is applied at item header level (uniform authorize).
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
    const sourceHeader = await findHeaderByItemDcode(lookupItem, { client });
    const targetHeader = lookupItem === item
      ? sourceHeader
      : await findHeaderByItemDcode(item, { client });

    const isApproved = approval.approved === true;
    const headerFields = {
      item_dcode: item,
      item_code: item_code ?? null,
      item_desc: item_desc ?? null,
      condition: specs[0]?.condition ?? null,
      grade: specs[0]?.grade ?? null,
      size: specs[0]?.size ?? null,
      condition_color: specs[0]?.condition_color ?? null,
      grade_color: specs[0]?.grade_color ?? null,
      type: specs[0]?.type ?? null,
      approved: isApproved,
      approved_by: isApproved ? approval.approved_by : null,
      approved_at: isApproved ? approval.approved_at : null,
      updated_by: userName ?? null,
    };

    let specItemId = targetHeader?.spec_item_id ?? null;
    const headerValues = [
      headerFields.item_dcode,
      headerFields.item_code,
      headerFields.item_desc,
      headerFields.condition,
      headerFields.grade,
      headerFields.size,
      headerFields.condition_color,
      headerFields.grade_color,
      headerFields.type,
      headerFields.approved,
      headerFields.approved_by,
      headerFields.approved_at,
      headerFields.updated_by,
    ];
    const headerSetSql = `
           item_dcode = $1, item_code = $2, item_desc = $3,
           condition = $4, grade = $5, size = $6,
           condition_color = $7, grade_color = $8, type = $9,
           approved = $10, approved_by = $11, approved_at = $12,
           updated_by = $13, updated_at = NOW()`;

    if (specItemId) {
      await client.query(
        `UPDATE ${HEADER} SET ${headerSetSql}
         WHERE spec_item_id = $14 AND is_deleted = false`,
        [...headerValues, specItemId],
      );
    } else if (sourceHeader && lookupItem !== item) {
      await client.query(
        `UPDATE ${HEADER} SET ${headerSetSql}
         WHERE spec_item_id = $14 AND is_deleted = false`,
        [...headerValues, sourceHeader.spec_item_id],
      );
      specItemId = sourceHeader.spec_item_id;
    } else {
      // Create: set created_* (+ approved_* when authorized). Do not stamp updated_* until a real edit.
      const [inserted] = (await client.query(
        `INSERT INTO ${HEADER}
         (item_dcode, item_code, item_desc, condition, grade, size, condition_color, grade_color, type,
          approved, approved_by, approved_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING spec_item_id`,
        [...headerValues.slice(0, 12), userName ?? null],
      )).rows;
      specItemId = inserted.spec_item_id;
    }

    const existingRes = await client.query(
      `SELECT * FROM ${LINES}
       WHERE spec_item_id = $1
       ORDER BY sno ASC`,
      [specItemId],
    );
    const existing = existingRes.rows || [];
    const byId = new Map(existing.map((r) => [Number(r.spec_id), r]));

    const keepIds = new Set(
      specs
        .map((s) => (s.spec_id != null ? Number(s.spec_id) : null))
        .filter((id) => id != null && byId.has(id)),
    );

    for (const row of existing) {
      if (!keepIds.has(Number(row.spec_id))) {
        await client.query(
          `DELETE FROM ${LINES} WHERE spec_id = $1`,
          [row.spec_id],
        );
      }
    }

    for (const id of keepIds) {
      await client.query(
        `UPDATE ${LINES} SET sno = -$1 WHERE spec_id = $1`,
        [id],
      );
    }

    const result = [];

    for (const line of specs) {
      const matchId = line.spec_id != null && keepIds.has(Number(line.spec_id))
        ? Number(line.spec_id)
        : null;
      const documentRequired = line.document_required === true;
      const lineValues = [
        specItemId,
        line.sno,
        line.spec_name ?? null,
        line.remarks ?? null,
        line.print_val ?? null,
        line.inspection_method ?? null,
        line.spec_type ?? null,
        line.min_value ?? 0,
        line.max_value ?? 0,
        line.correct_option ?? null,
        line.incorrect_option ?? null,
        documentRequired,
      ];

      if (matchId) {
        const [row] = (await client.query(
          `UPDATE ${LINES} SET
             spec_item_id = $1, sno = $2, spec_name = $3, remarks = $4, print_val = $5,
             inspection_method = $6,
             spec_type = $7, min_value = $8, max_value = $9,
             correct_option = $10, incorrect_option = $11,
             document_required = $12
           WHERE spec_id = $13
           RETURNING *`,
          [...lineValues, matchId],
        )).rows;
        const mappedRes = await client.query(
          `SELECT ${DEFAULT_FIELDS.join(", ")}
           ${LINE_JOIN}
           WHERE sl.spec_id = $1`,
          [row.spec_id],
        );
        result.push(mapRow(mappedRes.rows[0]));
      } else {
        const [row] = (await client.query(
          `INSERT INTO ${LINES}
           (spec_item_id, sno, spec_name, remarks, print_val, inspection_method,
            spec_type, min_value, max_value, correct_option, incorrect_option,
            document_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          lineValues,
        )).rows;
        const mappedRes = await client.query(
          `SELECT ${DEFAULT_FIELDS.join(", ")}
           ${LINE_JOIN}
           WHERE sl.spec_id = $1`,
          [row.spec_id],
        );
        result.push(mapRow(mappedRes.rows[0]));
      }
    }

    return result;
  });
};

/** Permanently delete master + all spec lines for an item. */
export const deleteSpecsByItem = async (item_dcode) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) throw new Error("The RM item code is invalid.");
  const header = await findHeaderByItemDcode(item);
  if (!header) return;

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ${LINES} WHERE spec_item_id = $1`, [header.spec_item_id]);
    await client.query(`DELETE FROM ${HEADER} WHERE spec_item_id = $1`, [header.spec_item_id]);
  });
};

/** Apply approval state to the item header. */
export const setItemApproval = async (item_dcode, approvalFields = {}) => {
  const item = Number(item_dcode);
  if (!Number.isFinite(item)) throw new Error("The RM item code is invalid.");
  const header = await findHeaderByItemDcode(item);
  if (!header) return;

  const fields = {};
  for (const k of ["approved", "approved_by", "approved_at", "updated_by", "updated_at"]) {
    if (approvalFields[k] !== undefined) fields[k] = approvalFields[k];
  }
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const values = keys.map((k) => fields[k]);
  values.push(header.spec_item_id);
  const setClause = keys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");

  await dbQuery(
    `UPDATE ${HEADER} SET ${setClause}
     WHERE spec_item_id = $${keys.length + 1} AND is_deleted = false`,
    values,
  );
};

const SPEC_HEADER_FIELDS = new Set(["condition", "grade", "size", "condition_color", "grade_color"]);

/** Distinct header values — powers suggest / dropdown fields. */
export const findSpecHeaderValues = async ({ field, search } = {}) => {
  const col = String(field || "").trim().toLowerCase();
  if (!SPEC_HEADER_FIELDS.has(col)) return [];

  const values = [];
  let i = 1;
  const conditions = ["si.is_deleted = false", `COALESCE(TRIM(si.${col}), '') <> ''`];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`si.${col} ILIKE $${i++}`);
  }

  const colorCol = col === "condition" ? "condition_color" : col === "grade" ? "grade_color" : null;

  if (colorCol) {
    const rows = await dbQuery(
      `SELECT DISTINCT ON (TRIM(si.${col})) TRIM(si.${col}) AS value, NULLIF(TRIM(si.${colorCol}), '') AS color
       FROM ${HEADER} si
       WHERE ${conditions.join(" AND ")}
       ORDER BY TRIM(si.${col}), COALESCE(si.updated_at, si.created_at) DESC NULLS LAST
       LIMIT 200`,
      values,
    );
    return (rows || []).map((row) => ({
      id: row.value,
      value: row.value,
      color: row.color || null,
    }));
  }

  const rows = await dbQuery(
    `SELECT TRIM(si.${col}) AS value, MAX(COALESCE(si.updated_at, si.created_at)) AS last_used_at
     FROM ${HEADER} si
     WHERE ${conditions.join(" AND ")}
     GROUP BY TRIM(si.${col})
     ORDER BY last_used_at DESC NULLS LAST
     LIMIT 200`,
    values,
  );

  return (rows || []).map((row) => ({
    id: row.value,
    value: row.value,
    last_used_at: row.last_used_at,
  }));
};
