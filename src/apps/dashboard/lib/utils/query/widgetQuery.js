export const DASHBOARD_WIDGET_QUERY_PLACEHOLDER =
  "SELECT ... FROM ... WHERE created_at BETWEEN {{fromDate}} AND {{toDate}} AND user_id = {{userId}}";

export function isConfiguredWidgetQuery(query) {
  const normalized = String(query || "").trim();
  if (!normalized) return false;
  if (normalized === DASHBOARD_WIDGET_QUERY_PLACEHOLDER) return false;
  if (/SELECT\s+\.\.\.\s+FROM/i.test(normalized)) return false;
  return true;
}
