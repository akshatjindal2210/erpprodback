import { extractListParams } from "../../core/lib/utils/query/queryHelper.js";

/** HRMS list params — offset computed here, not in shared queryHelper. */
export function extractHrmsListParams(body = {}, defaults = {}) {
  const { page, limit, filters, sortBy, order, search, fields } = extractListParams(body, defaults);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || (defaults.limit ?? 100));
  const offset = (safePage - 1) * safeLimit;
  return { page: safePage, limit: safeLimit, offset, filters, sortBy, order, search, fields };
}
