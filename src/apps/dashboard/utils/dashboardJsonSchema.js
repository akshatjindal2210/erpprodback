/**
 * Single-table JSON document shape for mst_dashboard_configs.
 *
 * {
 *   version: 1,
 *   meta: {
 *     appKey, pageKey, dashboardKey, dashboardName,
 *     scope: "global" | "users",
 *     targetUserIds: number[],
 *     defaultForUserIds: number[],
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
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      doc = {};
    }
  }
  doc = doc && typeof doc === "object" ? doc : {};
  const meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  const widgets = Array.isArray(doc.widgets) ? doc.widgets : [];
  return { doc, meta, widgets };
}

function createPersistedWidgetId(seed = Date.now()) {
  return `w_${seed}_${Math.floor(Math.random() * 100000)}`;
}

export function remapDashboardWidgetIds(rawWidgets = [], layoutPx = [], layoutPxMobile = []) {
  const widgets = rawWidgets.map((widget, idx) => widgetToStoredJson(widget, idx));
  const idMap = new Map();
  let seed = Date.now();

  widgets.forEach((widget) => {
    const oldId = String(widget.id || "").trim();
    if (!oldId || oldId.startsWith("tmp_")) {
      const newId = createPersistedWidgetId(seed++);
      if (oldId) idMap.set(oldId, newId);
      widget.id = newId;
      return;
    }
    idMap.set(oldId, oldId);
  });

  const remapRef = (rawId) => {
    const key = String(rawId || "").trim();
    if (!key) return null;
    return idMap.get(key) || key;
  };

  const remapLayoutList = (items = []) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        const nextId = remapRef(item?.i);
        if (!nextId) return null;
        return { ...item, i: String(nextId) };
      })
      .filter(Boolean);

  const remappedWidgets = widgets.map((widget, idx) => {
    const newId = String(remapRef(widget.id) || widget.id);
    const sectionId = widget.sectionId ? remapRef(widget.sectionId) : null;

    return {
      ...widget,
      id: newId,
      sectionId,
      nestedLayout: remapLayoutList(widget.nestedLayout),
      nestedLayoutPx: remapLayoutList(widget.nestedLayoutPx),
      mobileNestedLayout: remapLayoutList(widget.mobileNestedLayout),
      mobileNestedLayoutPx: remapLayoutList(widget.mobileNestedLayoutPx),
      layout: sanitizeLayoutCoords({ ...(widget.layout || {}), i: newId }, newId, idx),
      mobileLayout: sanitizeLayoutCoords({ ...(widget.mobileLayout || {}), i: newId }, newId, idx),
      style: widget.style?.boxPx
        ? {
          ...(widget.style || {}),
          boxPx: {
            ...(widget.style.boxPx || {}),
          },
        }
        : (widget.style || {}),
    };
  });

  return {
    widgets: remappedWidgets,
    layoutPx: remapLayoutList(layoutPx),
    layoutPxMobile: remapLayoutList(layoutPxMobile),
  };
}

export function buildDashboardDocument({
  appKey,
  pageKey,
  dashboardKey,
  dashboardName,
  scope = "global",
  targetUserIds = [],
  defaultForUserIds = [],
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
      defaultForUserIds: normalizeUserIds(defaultForUserIds),
      published: Boolean(isPublished),
      active: isActive !== false,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    },
    widgets: Array.isArray(widgets) ? widgets : [],
  };
}

export function resolveContainerPreset(widget = {}, layoutItem = {}) {
  const preset = String(widget.containerPreset || widget.container_preset || "").trim().toLowerCase();
  const layoutW = Number(layoutItem?.w ?? widget.layout?.w);
  if (preset === "half") return "half";
  if (preset === "full") {
    if (Number.isFinite(layoutW) && layoutW <= 6) return "half";
    return "full";
  }
  if (Number.isFinite(layoutW) && layoutW <= 6) return "half";
  return "full";
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

export function normalizeDeviceTarget(rawValue = "") {
  const value = String(rawValue || "").trim().toLowerCase();
  if (value === "mobile") return "mobile";
  if (value === "desktop") return "desktop";
  return "both";
}

function readWidgetLayoutPixels(widget = {}) {
  const style = widget.style && typeof widget.style === "object" ? widget.style : {};
  const widthPx = Number(style.layoutWidthPx ?? widget.layoutWidthPx);
  const heightPx = Number(style.layoutHeightPx ?? widget.layoutHeightPx);
  return {
    widthPx: Number.isFinite(widthPx) && widthPx > 0 ? Math.round(widthPx) : null,
    heightPx: Number.isFinite(heightPx) && heightPx > 0 ? Math.round(heightPx) : null,
  };
}

function hasManualWidgetLayout(widget = {}) {
  if (widget.layoutLocked === true || widget.layout_locked === true) return true;
  const { widthPx, heightPx } = readWidgetLayoutPixels(widget);
  return widthPx != null || heightPx != null;
}

function readTableWidgetOptions(widget = {}, chartConfig = {}) {
  const cfg = chartConfig && typeof chartConfig === "object" ? chartConfig : {};
  const rawPos = String(widget.tableSearchPosition ?? cfg.table_search_position ?? "right").trim().toLowerCase();
  const tableSearchPosition =
    rawPos === "left" || rawPos === "center" || rawPos === "full" ? rawPos : "right";
  const widthRaw = Number(widget.tableSearchWidth ?? cfg.table_search_width);
  const tableSearchWidth = Number.isFinite(widthRaw)
    ? Math.max(160, Math.min(600, Math.round(widthRaw)))
    : 280;
  return {
    tableSearchEnabled: widget.tableSearchEnabled === true || cfg.table_search_enabled === true,
    tableSearchPlaceholder: String(
      widget.tableSearchPlaceholder ?? cfg.table_search_placeholder ?? "",
    ).trim(),
    tableSearchPosition,
    tableSearchWidth,
    tableColumnSortEnabled: widget.tableColumnSortEnabled === true || cfg.table_column_sort_enabled === true,
    tableExportEnabled: widget.tableExportEnabled === true || cfg.table_export_enabled === true,
  };
}

function tableWidgetOptionsToChartConfig(options = {}) {
  const rawPos = String(options.tableSearchPosition || "right").trim().toLowerCase();
  const tableSearchPosition =
    rawPos === "left" || rawPos === "center" || rawPos === "full" ? rawPos : "right";
  const widthRaw = Number(options.tableSearchWidth);
  const tableSearchWidth = Number.isFinite(widthRaw)
    ? Math.max(160, Math.min(600, Math.round(widthRaw)))
    : 280;
  return {
    table_search_enabled: options.tableSearchEnabled === true,
    table_search_placeholder: String(options.tableSearchPlaceholder || "").trim(),
    table_search_position: tableSearchPosition,
    table_search_width: tableSearchWidth,
    table_column_sort_enabled: options.tableColumnSortEnabled === true,
    table_export_enabled: options.tableExportEnabled === true,
  };
}

function tableStyleToChartConfig(style = {}) {
  const src = style && typeof style === "object" ? style : {};
  return {
    table_header_color: src.tableHeaderColor,
    table_header_bg: src.tableHeaderBg,
    table_body_color: src.tableBodyColor,
    table_body_bg: src.tableBodyBg,
    table_border_color: src.tableBorderColor,
    table_header_font_size: src.tableHeaderFontSize,
    table_body_font_size: src.tableBodyFontSize,
    table_row_hover_bg: src.tableRowHoverBg,
  };
}

function readTableStyleFromChartConfig(chartConfig = {}) {
  const cfg = chartConfig && typeof chartConfig === "object" ? chartConfig : {};
  return {
    tableHeaderColor: cfg.table_header_color ?? cfg.tableHeaderColor,
    tableHeaderBg: cfg.table_header_bg ?? cfg.tableHeaderBg,
    tableBodyColor: cfg.table_body_color ?? cfg.tableBodyColor,
    tableBodyBg: cfg.table_body_bg ?? cfg.tableBodyBg,
    tableBorderColor: cfg.table_border_color ?? cfg.tableBorderColor,
    tableHeaderFontSize: cfg.table_header_font_size ?? cfg.tableHeaderFontSize,
    tableBodyFontSize: cfg.table_body_font_size ?? cfg.tableBodyFontSize,
    tableRowHoverBg: cfg.table_row_hover_bg ?? cfg.tableRowHoverBg,
  };
}

export function widgetToStoredJson(widget = {}, idx = 0) {
  if (widget?.rawType || widget?.dataSource) {
    const rawTypeInput = String(widget.rawType || widget.type || "table").toLowerCase();
    const rawType = rawTypeInput === "container" ? "container" : rawTypeInput;
    const tableOptions = readTableWidgetOptions(widget);
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
      ...tableOptions,
      sectionId: widget.containerId || widget.sectionId || null,
      containerPreset: resolveContainerPreset(
        { containerPreset: widget.containerPreset },
        widget.layout,
      ),
      layoutLocked: widget.layoutLocked === true || hasManualWidgetLayout(widget),
      nestedLayout: Array.isArray(widget.nestedLayout) ? widget.nestedLayout : [],
      nestedLayoutPx: Array.isArray(widget.nestedLayoutPx) ? widget.nestedLayoutPx : [],
      mobileNestedLayout: Array.isArray(widget.mobileNestedLayout) ? widget.mobileNestedLayout : [],
      mobileNestedLayoutPx: Array.isArray(widget.mobileNestedLayoutPx) ? widget.mobileNestedLayoutPx : [],
      mobilePaddingLeft: widget.mobilePaddingLeft ?? 8,
      mobilePaddingRight: widget.mobilePaddingRight ?? 8,
      mobilePaddingTop: widget.mobilePaddingTop ?? 8,
      mobilePaddingBottom: widget.mobilePaddingBottom ?? 8,
      style: widget.style && typeof widget.style === "object" ? widget.style : {},
      layout: sanitizeLayoutCoords(widget.layout, widget.id, idx),
      mobileLayout: sanitizeLayoutCoords(
        widget.mobileLayout || widget.mobile_layout || widget.layout,
        widget.id,
        idx,
      ),
      deviceTarget: normalizeDeviceTarget(widget.deviceTarget || widget.device_target),
      isActive: widget.is_active !== false,
      targetPageKey: String(widget.targetPageKey || widget.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
      targetPageModule: widget.targetPageModule || widget.target_page_module || null,
      linkType: String(widget.linkType || widget.link_type || "NONE").toUpperCase() === "APP"
        ? "APP"
        : String(widget.linkType || widget.link_type || "NONE").toUpperCase() === "URL"
          ? "URL"
          : "NONE",
      linkUrl: String(widget.linkUrl || widget.link_url || "").trim(),
      linkAppId: String(widget.linkAppId || widget.link_app_id || "").trim(),
      linkPageId: String(widget.linkPageId || widget.link_page_id || "").trim(),
      chart_config: {
        ...(widget.chart_config || {}),
        is_hybrid: widget.chart_config?.is_hybrid === true || String(widget.dataSource || "").toLowerCase() === "hybrid",
        hybrid_mssql_query: widget.chart_config?.hybrid_mssql_query || "",
        hybrid_external_source: widget.chart_config?.hybrid_external_source || "erp_mssql",
      },
    };
  }

  const chartConfig = widget?.chart_config && typeof widget.chart_config === "object" ? widget.chart_config : {};
  const type = String(widget.type || "table").toLowerCase();
  const rawType =
    type === "count" || type === "sum"
      ? "kpi"
      : type === "graph"
        ? "graph"
        : type === "heading"
          ? "heading"
          : type === "section"
            ? "container"
            : type === "hybrid"
              ? "table"
              : "table";
  const hybridMode = chartConfig.is_hybrid === true || type === "hybrid" || String(chartConfig.data_source || "").toLowerCase() === "hybrid";
  const tableOptions = readTableWidgetOptions(widget, chartConfig);

  return {
    id: widget.id,
    rawType,
    type: type === "graph" ? chartConfig.chart_type || "bar" : rawType,
    title: String(widget.title || "").trim(),
    description: String(widget.description || "").trim(),
    query: String(widget.query || "").trim(),
    dataSource: hybridMode ? "hybrid" : String(chartConfig.data_source || "ims_postgresql").toLowerCase(),
    erpFilter: chartConfig.erp_filter && typeof chartConfig.erp_filter === "object" ? chartConfig.erp_filter : {},
    emptyText: String(chartConfig.emptyText || "Click edit and add query"),
    ...tableOptions,
    sectionId: chartConfig.section_id ?? null,
      containerPreset: resolveContainerPreset(
        { containerPreset: chartConfig.container_preset },
        widget.layout,
      ),
    layoutLocked: chartConfig.layout_locked === true
      || hasManualWidgetLayout({
        layoutLocked: chartConfig.layout_locked === true,
        style: {
          layoutWidthPx: chartConfig.layout_width_px,
          layoutHeightPx: chartConfig.layout_height_px,
        },
      }),
    nestedLayout: Array.isArray(chartConfig.nested_layout) ? chartConfig.nested_layout : [],
    nestedLayoutPx: Array.isArray(chartConfig.nested_layout_px) ? chartConfig.nested_layout_px : [],
    mobileNestedLayout: Array.isArray(chartConfig.mobile_nested_layout) ? chartConfig.mobile_nested_layout : [],
    mobileNestedLayoutPx: Array.isArray(chartConfig.mobile_nested_layout_px) ? chartConfig.mobile_nested_layout_px : [],
    mobilePaddingLeft: chartConfig.mobile_padding_left ?? 8,
    mobilePaddingRight: chartConfig.mobile_padding_right ?? 8,
    mobilePaddingTop: chartConfig.mobile_padding_top ?? 8,
    mobilePaddingBottom: chartConfig.mobile_padding_bottom ?? 8,
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
      titlePosition: chartConfig.titlePosition === "bottom" ? "bottom" : "top",
      kpiLabelPosition: chartConfig.kpiLabelPosition,
      kpiLabelFontSize: chartConfig.kpiLabelFontSize,
      layoutWidthPx: Number.isFinite(Number(chartConfig.layout_width_px))
        ? Math.round(Number(chartConfig.layout_width_px))
        : undefined,
      layoutHeightPx: Number.isFinite(Number(chartConfig.layout_height_px))
        ? Math.round(Number(chartConfig.layout_height_px))
        : undefined,
      boxPx: Number.isFinite(Number(chartConfig.box_width))
        ? {
          left: Math.max(0, Math.round(Number(chartConfig.box_left ?? 0))),
          top: Math.max(0, Math.round(Number(chartConfig.box_top ?? 0))),
          width: Math.max(40, Math.round(Number(chartConfig.box_width))),
          height: Math.max(32, Math.round(Number(chartConfig.box_height ?? 64))),
        }
        : (chartConfig.boxPx && Number.isFinite(Number(chartConfig.boxPx.width)) ? chartConfig.boxPx : undefined),
      ...readTableStyleFromChartConfig(chartConfig),
    },
    layout: sanitizeLayoutCoords(widget.layout, widget.id, idx),
    mobileLayout: sanitizeLayoutCoords(
      widget.mobile_layout || widget.mobileLayout || widget.layout,
      widget.id,
      idx,
    ),
    deviceTarget: normalizeDeviceTarget(widget.device_target || widget.deviceTarget),
    isActive: widget.is_active !== false,
    targetPageKey: String(widget.targetPageKey || widget.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
    targetPageModule: widget.targetPageModule || widget.target_page_module || null,
    linkType: String(chartConfig.link_type || widget.linkType || widget.link_type || "NONE").toUpperCase() === "APP"
      ? "APP"
      : String(chartConfig.link_type || widget.linkType || widget.link_type || "NONE").toUpperCase() === "URL"
        ? "URL"
        : "NONE",
    linkUrl: String(chartConfig.link_url || widget.linkUrl || widget.link_url || "").trim(),
    linkAppId: String(chartConfig.link_app_id || widget.linkAppId || widget.link_app_id || "").trim(),
    linkPageId: String(chartConfig.link_page_id || widget.linkPageId || widget.link_page_id || "").trim(),
    chart_config: {
      ...chartConfig,
      is_hybrid: hybridMode,
      hybrid_mssql_query: chartConfig.hybrid_mssql_query || "",
      hybrid_external_source: chartConfig.hybrid_external_source
        || (String(chartConfig.data_source || "").toLowerCase() === "erp_mssql" ? "erp_mssql"
          : String(chartConfig.data_source || "").toLowerCase() === "hrms_mssql" ? "hrms_mssql"
            : "erp_mssql"),
    },
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
          : rawType === "container"
            ? "section"
            : rawType === "hybrid"
              ? "table"
              : rawType === "count" || rawType === "sum" || rawType === "section"
                ? rawType
                : "table";
  const tableChartConfig = tableWidgetOptionsToChartConfig(stored);
  const tableStyleChartConfig = tableStyleToChartConfig(stored.style);

  return {
    id: stored.id || `cfg_${idx}`,
    title: stored.title || "",
    description: stored.description || "",
    type,
    query: stored.query || "",
    chart_config: {
      ...(stored.style || {}),
      chart_type: rawType === "graph" ? String(stored.type || "bar") : undefined,
      data_source: stored.dataSource || "ims_postgresql",
      erp_filter: stored.erpFilter || {},
      emptyText: stored.emptyText || "Click edit and add query",
      ...tableChartConfig,
      ...tableStyleChartConfig,
      section_id: stored.sectionId || null,
      container_preset: stored.containerPreset || "full",
      layout_locked: stored.layoutLocked === true,
      nested_layout: Array.isArray(stored.nestedLayout) ? stored.nestedLayout : [],
      nested_layout_px: Array.isArray(stored.nestedLayoutPx) ? stored.nestedLayoutPx : [],
      mobile_nested_layout: Array.isArray(stored.mobileNestedLayout) ? stored.mobileNestedLayout : [],
      mobile_nested_layout_px: Array.isArray(stored.mobileNestedLayoutPx) ? stored.mobileNestedLayoutPx : [],
      mobile_padding_left: stored.mobilePaddingLeft ?? 8,
      mobile_padding_right: stored.mobilePaddingRight ?? 8,
      mobile_padding_top: stored.mobilePaddingTop ?? 8,
      mobile_padding_bottom: stored.mobilePaddingBottom ?? 8,
      bg: stored.style?.bg,
      color: stored.style?.color,
      fontSize: stored.style?.fontSize,
      borderRadius: stored.style?.borderRadius,
      fontFamily: stored.style?.fontFamily,
      padding: stored.style?.padding,
      margin: stored.style?.margin,
      contentAlign: stored.style?.contentAlign,
      emptyTextPosition: stored.style?.emptyTextPosition,
      titlePosition: stored.style?.titlePosition === "bottom" ? "bottom" : "top",
      kpiLabelPosition: stored.style?.kpiLabelPosition,
      kpiLabelFontSize: stored.style?.kpiLabelFontSize,
      layout_width_px: Number.isFinite(Number(stored.style?.layoutWidthPx))
        ? Math.round(Number(stored.style.layoutWidthPx))
        : undefined,
      layout_height_px: Number.isFinite(Number(stored.style?.layoutHeightPx))
        ? Math.round(Number(stored.style.layoutHeightPx))
        : undefined,
      box_left: Number.isFinite(Number(stored.style?.boxPx?.left)) ? Math.round(Number(stored.style.boxPx.left)) : undefined,
      box_top: Number.isFinite(Number(stored.style?.boxPx?.top)) ? Math.round(Number(stored.style.boxPx.top)) : undefined,
      box_width: Number.isFinite(Number(stored.style?.boxPx?.width)) ? Math.round(Number(stored.style.boxPx.width)) : undefined,
      box_height: Number.isFinite(Number(stored.style?.boxPx?.height)) ? Math.round(Number(stored.style.boxPx.height)) : undefined,
      boxPx: stored.style?.boxPx && typeof stored.style.boxPx === "object" ? stored.style.boxPx : undefined,
      link_type: stored.linkType || "NONE",
      link_url: stored.linkUrl || "",
      link_app_id: stored.linkAppId || "",
      link_page_id: stored.linkPageId || "",
      is_hybrid: stored.chart_config?.is_hybrid === true
        || String(stored.dataSource || "").toLowerCase() === "hybrid",
      hybrid_mssql_query: stored.chart_config?.hybrid_mssql_query || "",
      hybrid_external_source: stored.chart_config?.hybrid_external_source || "erp_mssql",
    },
    layout: sanitizeLayoutCoords(stored.layout, stored.id || `cfg_${idx}`, idx),
    mobile_layout: sanitizeLayoutCoords(stored.mobileLayout, stored.id || `cfg_${idx}`, idx),
    device_target: stored.deviceTarget || "both",
    is_active: stored.isActive !== false,
    is_published: true,
    target_page_key: stored.targetPageKey || "dashboard",
    target_page_module: stored.targetPageModule || null,
  };
}
