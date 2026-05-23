const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const parsePagination = (payload = {}) => {
  const page = Number.parseInt(payload.page, 10);
  const limit = Number.parseInt(payload.limit, 10);

  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE;
  const safeLimit = Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, limit)) : DEFAULT_LIMIT;
  const offset = (safePage - 1) * safeLimit;

  return { page: safePage, limit: safeLimit, offset };
};

export const parseSort = (payload = {}, { defaultSortBy, allowedSortFields = [] } = {}) => {
  const rawSortBy = payload.sortBy ?? payload?.sort?.by ?? defaultSortBy;
  const rawOrder = payload.order ?? payload?.sort?.order ?? "DESC";

  const order = String(rawOrder).toUpperCase() === "ASC" ? "ASC" : "DESC";
  const sortBy = allowedSortFields.includes(rawSortBy) ? rawSortBy : defaultSortBy;

  return { sortBy, order };
};

export const parseFilters = (filters = {}) => {
  if (Array.isArray(filters)) return filters;

  if (filters && typeof filters === "object") {
    return Object.entries(filters).map(([field, value]) => ({
      field,
      operator: "eq",
      value,
      logic: "AND"
    }));
  }

  return [];
};
