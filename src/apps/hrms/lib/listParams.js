import { extractListParams } from "../../core/lib/utils/query/queryHelper.js";

export function extractHrmsListParams(body = {}, defaults = {}) {
  const { page, limit, filters, sortBy, order, search, fields } = extractListParams(body, defaults);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || (defaults.limit ?? 100));
  const offset = (safePage - 1) * safeLimit;
  return { page: safePage, limit: safeLimit, offset, filters, sortBy, order, search, fields };
}

/** Simple IN (...$n) — no ANY/array cast. */
export function addIn(parts, params, column, values) {
  if (!values?.length) return;
  const ph = values.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  parts.push(`${column} IN (${ph})`);
  params.push(...values);
}

export function whereSql(parts) {
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}
