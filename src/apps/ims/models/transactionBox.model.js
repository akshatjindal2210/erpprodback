import dbQuery from "../../../config/db.js";
import { buildJourneyFilter, hasJourneyFilter } from "../utils/logJourneyFilter.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

export const findTransactionBoxes = async (options = {}, req_user = {}) => {
  const {
    filters = {},
    search = null,
    sort = { by: "created_at", order: "DESC" },
    page = 1,
    limit = 20,
    fields = ["tb.*"],
    permission = {},
  } = options;

  const values = [];
  let i = 1;
  const conditions = [];
  let journeyCte = "";
  const journeyMode = hasJourneyFilter(filters);

  if (!journeyMode && permission?.can_view_days > 0) {
    conditions.push(`tb.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (journeyMode) {
    const built = buildJourneyFilter({ alias: "tb", journey: filters.journey, values });
    if (built) {
      journeyCte = `WITH ${built.cte}`;
      conditions.push(built.condition);
    }
    i = values.length + 1;
  }

  for (const [key, val] of Object.entries(filters)) {
    if (key === "journey") continue;
    if (journeyMode && (key === "from_date" || key === "fromDate" || key === "to_date" || key === "toDate")) {
      continue;
    }
    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`tb.created_at >= $${i++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`tb.created_at <= $${i++}`);
      continue;
    }
    if (val === null || val === undefined || val === "") continue;
    if (key === "transaction_type" || key === "source_module") {
      values.push(val);
      conditions.push(`tb.${key} = $${i++}`);
      continue;
    }
    if (Array.isArray(val) && val.length) {
      const placeholders = val.map(() => `$${i++}`).join(", ");
      values.push(...val);
      conditions.push(`tb.${key} IN (${placeholders})`);
    } else {
      values.push(val);
      conditions.push(`tb.${key} = $${i++}`);
    }
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      tb.transaction_type ILIKE $${idx} OR
      tb.source_module ILIKE $${idx} OR
      tb.source_id::text ILIKE $${idx} OR
      tb.packing_number ILIKE $${idx} OR
      tb.user_name ILIKE $${idx}
    )`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const allowedSort = ["id", "created_at", "transaction_type", "source_module", "packing_number", "source_id"];
  const sortBy = allowedSort.includes(sort.by) ? `tb.${sort.by}` : "tb.created_at";
  const sortOrder = ["ASC", "DESC"].includes(sort.order?.toUpperCase()) ? sort.order.toUpperCase() : "DESC";
  const orderClause =
    sortOrder === "DESC"
      ? `ORDER BY ${sortBy} DESC, tb.id DESC`
      : `ORDER BY ${sortBy} ASC, tb.id ASC`;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100000, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  values.push(safeLimit, offset);
  const paginationClause = `LIMIT $${i++} OFFSET $${i++}`;

  const countValues = values.slice(0, values.length - 2);

  const [{ count }] = await dbQuery(
    `${journeyCte ? `${journeyCte} ` : ""}SELECT COUNT(*)::int AS count FROM ims_transaction_box tb
     ${whereClause}`,
    countValues
  );

  const selectFields = fields.includes("tb.*")
    ? [
        "tb.id",
        "tb.transaction_type",
        "tb.source_module",
        "tb.source_id",
        "tb.packing_number",
        "tb.user_id",
        "tb.user_name",
        "tb.details",
        "tb.created_at",
      ]
    : fields;

  const rows = await dbQuery(
    `${journeyCte ? `${journeyCte} ` : ""}SELECT ${selectFields.join(", ")}
     FROM ims_transaction_box tb
     ${whereClause}
     ${orderClause}
     ${paginationClause}`,
    values
  );

  return {
    data: rows,
    total: parseInt(count, 10) || 0,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil((parseInt(count, 10) || 0) / safeLimit),
  };
};
