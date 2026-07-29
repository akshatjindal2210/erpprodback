import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { buildCoilTxJourneyFilter, hasCoilJourneyFilter } from "../../../lib/utils/logJourneyFilter.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";

const TBL = T.COIL_TRANSACTION;

/** Coil transaction list from rmstore_coil_transaction (excludes sticker downloads). */
export async function findCoilTransactions(options = {}) {
  const {
    filters = {},
    search = null,
    sort = { by: "created_at", order: "DESC" },
    page = 1,
    limit = 100,
    permission = {},
  } = options;

  const values = [];
  let i = 1;
  const conditions = [`tb.transaction_type <> $${i++}`];
  values.push(COIL_TX_TYPES.STICKER_DOWNLOAD);

  let journeyCte = "";
  const journeyMode = hasCoilJourneyFilter(filters);

  if (!journeyMode && permission?.can_view_days > 0) {
    conditions.push(`tb.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (journeyMode) {
    const built = buildCoilTxJourneyFilter({ alias: "tb", journey: filters.journey, values });
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
    if (key === "transaction_type" || key === "source_module" || key === "mrn_no") {
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
      COALESCE(tb.mrn_no,'') ILIKE $${idx} OR
      COALESCE(tb.user_name,'') ILIKE $${idx}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const allowedSort = ["id", "created_at", "transaction_type", "source_module", "mrn_no", "source_id"];
  let sortBy = "tb.created_at";
  if (allowedSort.includes(sort.by)) {
    sortBy = `tb.${sort.by}`;
  }
  const sortOrder = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const countValues = [...values];
  const [{ count }] = await dbQuery(
    `${journeyCte ? `${journeyCte} ` : ""}SELECT COUNT(*)::int AS count FROM ${TBL} tb ${whereClause}`,
    countValues
  );

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `${journeyCte ? `${journeyCte} ` : ""}SELECT tb.id, tb.transaction_type, tb.source_module, tb.source_id,
            tb.mrn_no, tb.user_id, tb.user_name, tb.details, tb.created_at
     FROM ${TBL} tb
     ${whereClause}
     ORDER BY ${sortBy} ${sortOrder}, tb.id DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );

  return {
    data: rows,
    total: Number(count || 0),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(Number(count || 0) / safeLimit),
  };
}
