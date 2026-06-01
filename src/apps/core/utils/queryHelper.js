export const sanitizeFilters = (filters = {}, allowedFields = []) => {
  const appliedFilters = {};

  for (const key of allowedFields) {
    if (filters[key] !== undefined) {
      appliedFilters[key] = filters[key];
    }
  }

  return appliedFilters;
};

export const extractListParams = (body = {}, defaults = {}) => {
  const rawOrder = body.order ?? body.sortDir ?? defaults.order ?? "DESC";
  const order =
    typeof rawOrder === "string" && rawOrder.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const {
    page    = defaults.page    ?? 1,
    limit   = defaults.limit   ?? 100,
    filters = {},
    sortBy  = body.sortBy ?? body.sortKey ?? defaults.sortBy ?? "created_at",
    search,
    fields
  } = body;

  return { page, limit, filters, sortBy, order, search, fields };
};
