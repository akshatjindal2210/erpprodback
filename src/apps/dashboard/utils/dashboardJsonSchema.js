/**
 * Single-table JSON document shape for mst_dashboard_configs.
 *
 * {
 *   version: 1,
 *   meta: {
 *     appKey, pageKey, dashboardKey, dashboardName,
 *     scope: "global" | "users",
 *     targetUserIds: number[],
 *     published: boolean,
 *     active: boolean,
 *     updatedAt, updatedBy
 *   },
 *   widgets: [
 *     { id, type, title, query, layout, style, dataSource, erpFilter, ... }
 *   ]
 * }
 */

export function normalizeUserIds(userIds = []) {
  if (!Array.isArray(userIds)) return [];
  return userIds
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

export function parseDashboardDocument(raw = {}) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  const widgets = Array.isArray(doc.widgets) ? doc.widgets : [];
  return { doc, meta, widgets };
}

export function buildDashboardDocument({
  appKey,
  pageKey,
  dashboardKey,
  dashboardName,
  scope = "global",
  targetUserIds = [],
  widgets = [],
  actorId = null,
  isPublished = true,
  isActive = true,
  version = 1,
  pageModule = null,
}) {
  const normalizedScope = scope === "users" ? "users" : "global";
  return {
    version,
    meta: {
      appKey,
      pageKey,
      pageModule: pageModule ? String(pageModule).trim() : null,
      dashboardKey,
      dashboardName,
      scope: normalizedScope,
      targetUserIds: normalizedScope === "users" ? normalizeUserIds(targetUserIds) : [],
      published: Boolean(isPublished),
      active: isActive !== false,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    },
    widgets: Array.isArray(widgets) ? widgets : [],
  };
}

export function sanitizeLayoutCoords(rawLayout = {}, widgetId = "", idx = 0) {
  const fallbackX = (idx * 2) % 12;
  const fallbackY = idx * 2;
  const toNum = (value, fallback) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;

  return {
    i: String(widgetId || rawLayout.i || `cfg_${idx}`),
    x: toNum(rawLayout.x, fallbackX),
    y: toNum(rawLayout.y, fallbackY),
    w: Math.max(1, toNum(rawLayout.w, 3)),
    h: Math.max(1, toNum(rawLayout.h, 2)),
  };
}

export function widgetToStoredJson(widget = {}, idx = 0) {
  if (widget?.rawType || widget?.dataSource) {
    const rawType = String(widget.rawType || widget.type || "table").toLowerCase();
    return {
      id: widget.id,
      rawType,
      type: widget.type || rawType,
      title: String(widget.title || "").trim(),
      description: String(widget.description || "").trim(),
      query: String(widget.query || "").trim(),
      dataSource: String(widget.dataSource || "ims_postgresql").toLowerCase(),
      erpFilter: widget.erpFilter && typeof widget.erpFilter === "object" ? widget.erpFilter : {},
      emptyText: String(widget.emptyText || "Click edit and add query"),
      sectionId: widget.sectionId || null,
      style: widget.style && typeof widget.style === "object" ? widget.style : {},
      layout: sanitizeLayoutCoords(widget.layout, widget.id, idx),
      isActive: widget.is_active !== false,
      targetPageKey: String(widget.targetPageKey || widget.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
      targetPageModule: widget.targetPageModule || widget.target_page_module || null,
    };
  }

  const chartConfig = widget?.chart_config && typeof widget.chart_config === "object" ? widget.chart_config : {};
  const type = String(widget.type || "table").toLowerCase();
  const rawType =
    type === "count" || type === "sum" ? "kpi" : type === "graph" ? "graph" : type === "heading" ? "heading" : "table";

  return {
    id: widget.id,
    rawType,
    type: type === "graph" ? chartConfig.chart_type || "bar" : rawType,
    title: String(widget.title || "").trim(),
    description: String(widget.description || "").trim(),
    query: String(widget.query || "").trim(),
    dataSource: String(chartConfig.data_source || "ims_postgresql").toLowerCase(),
    erpFilter: chartConfig.erp_filter && typeof chartConfig.erp_filter === "object" ? chartConfig.erp_filter : {},
    emptyText: String(chartConfig.emptyText || "Click edit and add query"),
    sectionId: chartConfig.section_id ?? null,
    style: {
      color: chartConfig.color,
      bg: chartConfig.bg,
      fontSize: chartConfig.fontSize,
      borderRadius: chartConfig.borderRadius,
      fontFamily: chartConfig.fontFamily,
      padding: chartConfig.padding,
      margin: chartConfig.margin,
      contentAlign: chartConfig.contentAlign,
      emptyTextPosition: chartConfig.emptyTextPosition,
      kpiLabelPosition: chartConfig.kpiLabelPosition,
      kpiLabelFontSize: chartConfig.kpiLabelFontSize,
    },
    layout: sanitizeLayoutCoords(widget.layout, widget.id, idx),
    isActive: widget.is_active !== false,
    targetPageKey: String(widget.targetPageKey || widget.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
    targetPageModule: widget.targetPageModule || widget.target_page_module || null,
  };
}

export function widgetToRuntimeRow(widget = {}, idx = 0) {
  const stored = widgetToStoredJson(widget, idx);
  const rawType = String(stored.rawType || "table").toLowerCase();
  const type =
    rawType === "kpi"
      ? "count"
      : rawType === "graph"
        ? "graph"
        : rawType === "heading"
          ? "heading"
          : rawType === "count" || rawType === "sum" || rawType === "section"
            ? rawType
            : "table";

  return {
    id: stored.id || `cfg_${idx}`,
    title: stored.title || "Widget",
    description: stored.description || "",
    type,
    query: stored.query || "",
    chart_config: {
      ...(stored.style || {}),
      chart_type: rawType === "graph" ? String(stored.type || "bar") : undefined,
      data_source: stored.dataSource || "ims_postgresql",
      erp_filter: stored.erpFilter || {},
      emptyText: stored.emptyText || "Click edit and add query",
      section_id: stored.sectionId || null,
      bg: stored.style?.bg,
      color: stored.style?.color,
      fontSize: stored.style?.fontSize,
      borderRadius: stored.style?.borderRadius,
      fontFamily: stored.style?.fontFamily,
      padding: stored.style?.padding,
      margin: stored.style?.margin,
      contentAlign: stored.style?.contentAlign,
      emptyTextPosition: stored.style?.emptyTextPosition,
      kpiLabelPosition: stored.style?.kpiLabelPosition,
      kpiLabelFontSize: stored.style?.kpiLabelFontSize,
    },
    layout: sanitizeLayoutCoords(stored.layout, stored.id || `cfg_${idx}`, idx),
    is_active: stored.isActive !== false,
    is_published: true,
    target_page_key: stored.targetPageKey || "dashboard",
    target_page_module: stored.targetPageModule || null,
  };
}
