import dbQuery from "../../../../../config/db/db.js";
import { getCachedPermissions, setCachedPermissions } from "../../../../../config/auth/permissionCache.js";
import { MST_TABLES as M } from "../../../../../config/db/dbTables.js";
import { getDashboardConfigByKey, listDashboardConfigs, getDashboardWidgetsFromConfig, saveDashboardWidgetsToConfig, upsertDashboardConfig, deactivateDashboardByKey, listUserAccessibleDashboards, listAllPublishedDashboards, resolveUserDefaultDashboardKey, userCanAccessDashboard, clearDefaultForUsersFromOtherDashboards } from "../models/dashboardConfig.model.js";
import { parseDashboardDocument, remapDashboardWidgetIds, sanitizeLayoutCoords, widgetToRuntimeRow, widgetToStoredJson, normalizeDeviceTarget } from "../../../lib/utils/schema/dashboardJsonSchema.js";
import { executeReadOnlyWidgetQuery } from "../../../lib/utils/query/queryExecutor.js";
import { HybridQueryEngine, resolveHybridPgSql } from "../../../lib/utils/query/hybridQueryEngine.js";
import { validateErpMssqlWidgetQuery, resolveErpMssqlSqlFromRequest, resolveErpMssqlRuntimeFilters, isErpMssqlDirectRequest, parseErpMssqlDirectRequest, isExternalMssqlSource, resolveExternalMssqlConfig, validateExternalMssqlWidgetQuery } from "../../../lib/utils/mssql/erpMssqlQuery.js";
import { validateSelectSql } from "../../../lib/utils/query/sqlGenerator.js";
import { isConfiguredWidgetQuery } from "../../../lib/utils/query/widgetQuery.js";
import { fetchImsDataRaw } from "../../../../ims/lib/services/ims.service.js";
import { clearImsMetaForResponse } from "../../../../ims/lib/utils/erp-api/lookup/imsMeta.js";

const ALLOWED_APP_KEYS = new Set(["home", "ims", "task", "settings", "rmstore"]);
const ALLOWED_DB_SOURCES = new Set(["ims_postgresql", "erp_mssql", "hrms_mssql", "hybrid"]);
const ALLOWED_AUDIENCE_SCOPES = new Set(["global", "users"]);
const APP_TABLE_PREFIX = {
  ims: ["ims_"],
  task: ["task_"],
  settings: ["mst_", "sys_"],
  home: [],
  rmstore: ["rmstore_"],
};

const TABLE_MODULE_OVERRIDES = {
  ims_location_master: "location_master",
  rmstore_master_location: "rm_store_location_master",
  rmstore_master_production: "rm_production_master",
  rmstore_master_spec: "rm_spec_master",
  rmstore_mrn: "rm_mrn_portal",
  ims_packing_standard: "packing_standard",
  ims_inventory_inwards: "inventory_inwards",
  ims_forwarding_note_master: "forwarding_note_master",
  ims_forwarding_note_item_wise: "forwarding_note_master",
  ims_out_entry: "out_entry",
  ims_box_table: "boxes",
  ims_stock_adjustment: "stock_adjustment",
  ims_schedule_plan: "schedule_planning",
  ims_schedule_plan_transaction: "schedule_planning",
  ims_qc_hold_material: "qc_hold_material",
  ims_audit_master: "audit",
  ims_audit_locations: "audit",
  ims_audit_scans: "audit",
};

function extractReferencedTables(rawSql = "") {
  const sql = String(rawSql).toLowerCase();
  const tables = new Set();
  const re = /\b(?:from|join)\s+([a-z0-9_."`]+)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const token = String(m[1] || "").trim();
    if (!token || token.startsWith("(")) continue;
    const cleaned = token.replace(/["`]/g, "");
    const table = cleaned.includes(".") ? cleaned.split(".").pop() : cleaned;
    if (table) tables.add(table);
  }
  return [...tables];
}

function modulesFromQuery(rawSql = "") {
  const tables = extractReferencedTables(rawSql);
  const modules = new Set();
  for (const table of tables) {
    if (TABLE_MODULE_OVERRIDES[table]) {
      modules.add(TABLE_MODULE_OVERRIDES[table]);
      continue;
    }
    const stem = table.replace(/^(ims_|mst_|task_)/, "");
    modules.add(stem);
    if (stem.endsWith("s")) modules.add(stem.slice(0, -1));
  }
  return [...modules];
}

function canUserSeeWidgetByAudience(widget, userId, isSuperAdmin) {
  if (isSuperAdmin) return true;
  const scope = String(widget?.audience_scope || "global").toLowerCase();
  if (scope !== "users") return true;
  const ids = Array.isArray(widget?.target_user_ids) ? widget.target_user_ids : [];
  const numericUserId = Number(userId);
  return ids.some((value) => Number(value) === numericUserId);
}

async function userCanViewPageModule(user, pageModule) {
  const moduleName = String(pageModule || "").trim();
  if (!moduleName) return true;
  const userType = String(user?.type || user?.role || "").toLowerCase().trim();
  if (userType === "super_admin" || userType === "super admin") return true;
  if (!user?.id) return false;

  let permissions = getCachedPermissions(user.id);
  if (!permissions) {
    permissions = await dbQuery(
      `SELECT up.can_view, m.name AS module_name, m.is_active AS module_is_active
         FROM ${M.USER_PERMISSIONS} up
         JOIN ${M.MODULES} m ON m.id = up.module_id
        WHERE up.user_id = $1
          AND m.is_active = true`,
      [user.id],
    );
    setCachedPermissions(user.id, permissions);
  }

  const perm = permissions.find((row) => String(row?.module_name || "") === moduleName);
  return Boolean(perm?.can_view);
}

function dedupeWidgets(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, row);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0));
}

function isTopLevelDashboardWidget(widget = {}) {
  const sectionId = widget?.chart_config?.section_id;
  return sectionId == null || String(sectionId).trim() === "";
}

/** Full saved layout slots (incl. permission-hidden widgets) for live gap packing. */
function buildLayoutBlueprint(widgets = []) {
  const topLevel = (widgets || []).filter(isTopLevelDashboardWidget);
  return {
    desktop: topLevel.map((widget, idx) =>
      sanitizeLayoutCoords(widget?.layout, widget.id, idx)),
    mobile: topLevel.map((widget, idx) =>
      sanitizeLayoutCoords(widget?.mobile_layout || widget?.layout, widget.id, idx)),
  };
}

function normalizeDashboardJson(raw = {}) {
  const { doc, widgets } = parseDashboardDocument(raw);
  return { ...doc, widgets };
}

async function getWidgetsForBuilder(appKey, pageKey, dashboardKey = "default") {
  const storedWidgets = await getDashboardWidgetsFromConfig(appKey, pageKey, dashboardKey);
  return storedWidgets.map((widget, idx) => widgetToRuntimeRow(widget, idx));
}

async function saveWidgetsForBuilder({
  appKey,
  pageKey,
  dashboardKey = "default",
  dashboardName = "Default",
  scope = "global",
  targetUserIds = [],
  widgets = [],
  actorId = null,
  isPublished,
}) {
  let publishedFlag = isPublished;
  if (publishedFlag === undefined) {
    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    const { meta } = parseDashboardDocument(existing?.dashboard_json);
    publishedFlag = meta?.published === true;
  }

  const storedWidgets = widgets.map((widget) => widgetToStoredJson(widget));
  await saveDashboardWidgetsToConfig({
    appKey,
    pageKey,
    dashboardKey,
    dashboardName,
    scope,
    targetUserIds,
    widgets: storedWidgets,
    actorId,
    isPublished: publishedFlag,
  });
}

function normalizeAppKey(rawValue = "ims") {
  const appKey = String(rawValue || "ims").trim().toLowerCase();
  return ALLOWED_APP_KEYS.has(appKey) ? appKey : "ims";
}

function normalizeDbSource(rawValue = "ims_postgresql") {
  const source = String(rawValue || "ims_postgresql").trim().toLowerCase();
  return ALLOWED_DB_SOURCES.has(source) ? source : "ims_postgresql";
}

function normalizeAudienceScope(rawValue = "global") {
  const scope = String(rawValue || "global").trim().toLowerCase();
  return ALLOWED_AUDIENCE_SCOPES.has(scope) ? scope : "global";
}

function normalizeDashboardKey(rawValue = "default") {
  return (
    String(rawValue || "default")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "default"
  );
}

function isAppMainDashboardView(appKey = "ims", viewPageKey = "dashboard") {
  const normalizedAppKey = String(appKey || "ims").trim().toLowerCase();
  const normalizedPageKey = String(viewPageKey || "dashboard").trim().toLowerCase();
  if (normalizedAppKey === "home") {
    return normalizedPageKey === "default" || normalizedPageKey === "dashboard";
  }
  return normalizedPageKey === "dashboard";
}

function normalizeTargetUserIds(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return rawValue
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function normalizeWidgetFilters(rawFilters = {}) {
  const fromDate = rawFilters?.fromDate ? String(rawFilters.fromDate).trim() : "";
  const toDate = rawFilters?.toDate ? String(rawFilters.toDate).trim() : "";
  const userIdRaw = rawFilters?.userId;
  const userId = userIdRaw !== undefined && userIdRaw !== null && String(userIdRaw).trim() !== ""
    ? Number(userIdRaw)
    : null;
  const fyuidRaw = rawFilters?.fyuid ?? rawFilters?.fy_uid ?? rawFilters?.fin_year_id;
  const fyuid = fyuidRaw !== undefined && fyuidRaw !== null && String(fyuidRaw).trim() !== ""
    ? Number(fyuidRaw)
    : null;
  return {
    fromDate,
    toDate,
    userId: Number.isInteger(userId) && userId > 0 ? userId : null,
    fyuid: Number.isInteger(fyuid) && fyuid > 0 ? fyuid : null,
  };
}

function isSuperAdminUser(user) {
  const userType = String(user?.type || user?.role || "").toLowerCase().trim();
  return userType === "super_admin" || userType === "super admin";
}

function resolveWidgetFiltersForUser(req, rawFilters = {}) {
  const normalized = normalizeWidgetFilters(rawFilters);
  if (isSuperAdminUser(req.user)) {
    return normalized;
  }
  return { ...normalized, userId: null };
}

export const getTables = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.query?.app || req.body?.app_key || "ims");
    const dbSource = normalizeDbSource(req.query?.db_source || req.body?.db_source || "ims_postgresql");
    const effectiveDbSource = dbSource === "hybrid" ? "ims_postgresql" : dbSource;
    if (isExternalMssqlSource(effectiveDbSource)) {
      const { tablesRequestedData } = resolveExternalMssqlConfig(effectiveDbSource);
      const imsRes = await fetchImsDataRaw(tablesRequestedData);
      const rows = Array.isArray(imsRes?.records) ? imsRes.records : [];
      const values = rows
        .map((row) => String(row?.table_name || row?.name || "").trim())
        .filter(Boolean);
      // Schema browser only — don't attach a global IMS toast when the list is empty/soft-failed.
      clearImsMetaForResponse();
      return res.json({ success: true, data: values });
    }

    const query = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `;
    const tables = await dbQuery(query);
    const allowedPrefixes = APP_TABLE_PREFIX[appKey] || [];
    const filtered = tables
      .map((t) => String(t.table_name || "").trim())
      .filter(Boolean)
      .filter((tableName) => {
        if (allowedPrefixes.length === 0) return true;
        return allowedPrefixes.some((prefix) => tableName.startsWith(prefix));
      });
    res.json({ success: true, data: filtered });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getColumns = async (req, res) => {
  const { table } = req.params;
  try {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      return res.status(400).json({ success: false, message: "Invalid table name." });
    }
    const query = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1 
      AND table_schema = 'public'
    `;
    const columns = await dbQuery(query, [table]);
    res.json({ success: true, data: columns });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

function sanitizeWidgetBody(body = {}) {
  const allowedTypes = new Set(["count", "sum", "table", "graph", "heading", "section", "hybrid"]);
  const title = String(body.title || "").trim();
  const type = String(body.type || "").trim().toLowerCase();
  const query = String(body.query || "").trim();
  const dbSource = normalizeDbSource(body?.chart_config?.data_source || "ims_postgresql");
  const isHybridWidget = body.chart_config?.is_hybrid === true || dbSource === "hybrid";
  const hybridExternalSource = normalizeDbSource(
    body?.chart_config?.hybrid_external_source
      || (isExternalMssqlSource(dbSource) ? dbSource : "erp_mssql"),
  );
  const requiresQuery = type === "count" || type === "sum" || type === "table" || type === "graph" || type === "hybrid";
  const isDraft = body.is_published === false;

  if (!allowedTypes.has(type)) throw new Error("Invalid widget type.");
  if (requiresQuery && !query && !isDraft) throw new Error("Query is required.");

  if (isHybridWidget || type === "hybrid") {
    if (!isDraft) {
      const hybridMssql = String(body.chart_config?.hybrid_mssql_query || "").trim();
      if (!hybridMssql) {
        throw new Error("Hybrid widgets require an external MSSQL query.");
      }
      validateExternalMssqlWidgetQuery(hybridMssql, hybridExternalSource);
      if (query) resolveHybridPgSql(query, {});
    }
  } else {
    if (requiresQuery && query && !isDraft) {
      if (!isExternalMssqlSource(dbSource)) {
        validateSelectSql(query);
      } else {
        validateExternalMssqlWidgetQuery(query, dbSource);
      }
    }
  }

  const autoTitle =
    type === "count"
      ? "Count KPI"
      : type === "sum"
        ? "Sum KPI"
        : type === "table"
          ? "Table Widget"
          : type === "graph"
            ? "Graph Widget"
            : type === "hybrid"
              ? "Hybrid Widget"
              : type === "heading"
                ? "Dashboard Heading"
                : type === "section"
                  ? ""
                  : "Widget";

  const audienceScope = normalizeAudienceScope(body.audience_scope || "global");
  const targetUserIds = normalizeTargetUserIds(body.target_user_ids);

  return {
    audience_scope: audienceScope,
    target_user_ids: audienceScope === "users" ? targetUserIds : [],
    title: type === "section" ? title : (title || autoTitle),
    description: String(body.description || "").trim(),
    type,
    query: requiresQuery ? query : "",
    chart_config: {
      ...(body.chart_config && typeof body.chart_config === "object" ? body.chart_config : {}),
      data_source: isHybridWidget ? "hybrid" : dbSource,
      is_hybrid: isHybridWidget,
      hybrid_external_source: isHybridWidget ? hybridExternalSource : undefined,
      erp_filter:
        body?.chart_config?.erp_filter && typeof body.chart_config.erp_filter === "object"
          ? body.chart_config.erp_filter
          : {},
    },
    layout: body.layout && typeof body.layout === "object" ? body.layout : {},
    mobile_layout:
      body.mobile_layout && typeof body.mobile_layout === "object"
        ? body.mobile_layout
        : body.layout && typeof body.layout === "object"
          ? body.layout
          : {},
    device_target: normalizeDeviceTarget(body.device_target || "desktop"),
    app_key: normalizeAppKey(body.app_key),
    page_key: String(body.page_key || "default").trim().toLowerCase() || "default",
    dashboard_key: normalizeDashboardKey(body.dashboard_key || "default"),
    dashboard_name: String(body.dashboard_name || "Default").trim() || "Default",
    dashboard_scope: String(body.dashboard_scope || "global").trim().toLowerCase() === "users" ? "users" : "global",
    dashboard_target_user_ids: normalizeTargetUserIds(body.dashboard_target_user_ids || body.target_user_ids || []),
    is_active: body.is_active !== false,
    is_published: body.is_published !== false,
  };
}

function createWidgetId() {
  return `w_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function layoutFromWidgetRow(widget = {}) {
  const layout = widget?.layout && typeof widget.layout === "object" ? widget.layout : {};
  return {
    i: String(widget.id),
    x: Number(layout.x) || 0,
    y: Number(layout.y) || 0,
    w: Math.max(1, Number(layout.w) || 3),
    h: Math.max(1, Number(layout.h) || 2),
  };
}

function upsertChildInContainerNestedLayout(widgets = [], childWidget = {}) {
  const sectionId = childWidget?.chart_config?.section_id;
  if (!sectionId) return widgets;
  const childId = String(childWidget.id);
  const parentIdx = widgets.findIndex((widget) => String(widget.id) === String(sectionId));
  if (parentIdx < 0) return widgets;

  const parent = widgets[parentIdx];
  const chartConfig = parent.chart_config && typeof parent.chart_config === "object" ? parent.chart_config : {};
  const upsertInList = (items = []) => {
    const list = Array.isArray(items) ? [...items] : [];
    const entry = layoutFromWidgetRow(childWidget);
    const idx = list.findIndex((item) => String(item.i) === childId);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    return list;
  };

  widgets[parentIdx] = {
    ...parent,
    chart_config: {
      ...chartConfig,
      nested_layout: upsertInList(chartConfig.nested_layout),
      mobile_nested_layout: upsertInList(chartConfig.mobile_nested_layout || chartConfig.nested_layout),
    },
  };
  return widgets;
}

function removeChildFromContainerNestedLayout(widgets = [], childId = "", sectionId = null) {
  const resolvedSectionId = sectionId || null;
  if (!resolvedSectionId) return widgets;
  const parentIdx = widgets.findIndex((widget) => String(widget.id) === String(resolvedSectionId));
  if (parentIdx < 0) return widgets;

  const parent = widgets[parentIdx];
  const chartConfig = parent.chart_config && typeof parent.chart_config === "object" ? parent.chart_config : {};
  const filterList = (items = []) =>
    (Array.isArray(items) ? items : []).filter((item) => String(item.i) !== String(childId));

  widgets[parentIdx] = {
    ...parent,
    chart_config: {
      ...chartConfig,
      nested_layout: filterList(chartConfig.nested_layout),
      mobile_nested_layout: filterList(chartConfig.mobile_nested_layout),
    },
  };
  return widgets;
}

export const createWidgetHandler = async (req, res) => {
  try {
    const payload = sanitizeWidgetBody(req.body);
    const widgets = await getWidgetsForBuilder(payload.app_key, payload.page_key, payload.dashboard_key);
    const row = {
      ...payload,
      target_page_key: String(req.body?.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
      target_page_module: req.body?.target_page_module || null,
      id: createWidgetId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    widgets.push(row);
    upsertChildInContainerNestedLayout(widgets, row);
    await saveWidgetsForBuilder({
      appKey: payload.app_key,
      pageKey: payload.page_key,
      dashboardKey: payload.dashboard_key,
      dashboardName: payload.dashboard_name,
      scope: payload.dashboard_scope,
      targetUserIds: payload.dashboard_target_user_ids,
      widgets,
      actorId: req.user?.id ?? null,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateWidgetHandler = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const payload = sanitizeWidgetBody(req.body);
    const widgets = await getWidgetsForBuilder(payload.app_key, payload.page_key, payload.dashboard_key);
    const index = widgets.findIndex((widget) => String(widget.id) === id);
    if (index < 0) return res.status(404).json({ success: false, message: "Widget not found." });
    const row = {
      ...widgets[index],
      ...payload,
      target_page_key: String(req.body?.target_page_key || widgets[index]?.target_page_key || "dashboard").trim().toLowerCase() || "dashboard",
      target_page_module: req.body?.target_page_module ?? widgets[index]?.target_page_module ?? null,
      id,
      updated_at: new Date().toISOString(),
    };
    widgets[index] = row;
    upsertChildInContainerNestedLayout(widgets, row);
    await saveWidgetsForBuilder({
      appKey: payload.app_key,
      pageKey: payload.page_key,
      dashboardKey: payload.dashboard_key,
      dashboardName: payload.dashboard_name,
      scope: payload.dashboard_scope,
      targetUserIds: payload.dashboard_target_user_ids,
      widgets,
      actorId: req.user?.id ?? null,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteWidgetHandler = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app);
    const pageKey = String(req.body?.page_key || req.query?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || req.query?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || req.query?.dashboard_name || "Default").trim() || "Default";
    const dashboardScope =
      String(req.body?.dashboard_scope || req.query?.dashboard_scope || "global").toLowerCase() === "users"
        ? "users"
        : "global";
    const dashboardUsers = normalizeTargetUserIds(req.body?.dashboard_target_user_ids || req.query?.dashboard_target_user_ids || []);
    const widgets = await getWidgetsForBuilder(appKey, pageKey, dashboardKey);
    const index = widgets.findIndex((widget) => String(widget.id) === id);
    if (index < 0) return res.status(404).json({ success: false, message: "Widget not found." });
    const [deleted] = widgets.splice(index, 1);
    removeChildFromContainerNestedLayout(
      widgets,
      id,
      deleted?.chart_config?.section_id ?? deleted?.section_id ?? null,
    );
    await saveWidgetsForBuilder({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: dashboardScope,
      targetUserIds: dashboardUsers,
      widgets,
      actorId: req.user?.id ?? null,
    });
    res.json({ success: true, data: deleted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const publishWidgetHandler = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app);
    const pageKey = String(req.body?.page_key || req.query?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || req.query?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || req.query?.dashboard_name || "Default").trim() || "Default";
    const dashboardScope =
      String(req.body?.dashboard_scope || req.query?.dashboard_scope || "global").toLowerCase() === "users"
        ? "users"
        : "global";
    const dashboardUsers = normalizeTargetUserIds(req.body?.dashboard_target_user_ids || req.query?.dashboard_target_user_ids || []);
    const widgets = await getWidgetsForBuilder(appKey, pageKey, dashboardKey);
    const index = widgets.findIndex((widget) => String(widget.id) === id);
    if (index < 0) return res.status(404).json({ success: false, message: "Widget not found." });
    const row = { ...widgets[index], is_published: true, updated_at: new Date().toISOString() };
    widgets[index] = row;
    await saveWidgetsForBuilder({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: dashboardScope,
      targetUserIds: dashboardUsers,
      widgets,
      actorId: req.user?.id ?? null,
      isPublished: true,
    });
    if (!row) return res.status(404).json({ success: false, message: "Widget not found." });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const unpublishWidgetHandler = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app);
    const pageKey = String(req.body?.page_key || req.query?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || req.query?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || req.query?.dashboard_name || "Default").trim() || "Default";
    const dashboardScope =
      String(req.body?.dashboard_scope || req.query?.dashboard_scope || "global").toLowerCase() === "users"
        ? "users"
        : "global";
    const dashboardUsers = normalizeTargetUserIds(req.body?.dashboard_target_user_ids || req.query?.dashboard_target_user_ids || []);
    const widgets = await getWidgetsForBuilder(appKey, pageKey, dashboardKey);
    const index = widgets.findIndex((widget) => String(widget.id) === id);
    if (index < 0) return res.status(404).json({ success: false, message: "Widget not found." });
    const row = { ...widgets[index], is_published: false, updated_at: new Date().toISOString() };
    widgets[index] = row;
    await saveWidgetsForBuilder({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: dashboardScope,
      targetUserIds: dashboardUsers,
      widgets,
      actorId: req.user?.id ?? null,
      isPublished: false,
    });
    if (!row) return res.status(404).json({ success: false, message: "Widget not found." });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listWidgetsHandler = async (_req, res) => {
  try {
    const appKey = normalizeAppKey(_req.body?.app_key || _req.query?.app);
    const storagePageKey = "default";
    const dashboardKey = normalizeDashboardKey(_req.body?.dashboard_key || _req.query?.dashboard_key || "default");
    const configRow = await getDashboardConfigByKey(appKey, storagePageKey, dashboardKey, { publishedOnly: false });
    const parsed = normalizeDashboardJson(configRow?.dashboard_json || {});
    const rows = (parsed.widgets || []).map((widget, idx) => widgetToRuntimeRow(widget, idx));
    res.json({
      success: true,
      data: rows,
      layout_px: Array.isArray(parsed.layout_px) ? parsed.layout_px : [],
      canvas_width: Number.isFinite(Number(parsed.canvas_width)) && Number(parsed.canvas_width) >= 200
        ? Math.round(Number(parsed.canvas_width))
        : null,
      layout_px_mobile: Array.isArray(parsed.layout_px_mobile) ? parsed.layout_px_mobile : [],
      canvas_width_mobile: Number.isFinite(Number(parsed.canvas_width_mobile)) && Number(parsed.canvas_width_mobile) >= 200
        ? Math.round(Number(parsed.canvas_width_mobile))
        : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const previewWidgetHandler = async (req, res) => {
  try {
    const body = req.body || {};
    const q = req.query || {};

    if (isErpMssqlDirectRequest(body, q)) {
      const { filter, runtimeFilters, requestedData } = parseErpMssqlDirectRequest(body, q);
      const resolvedRuntime = resolveWidgetFiltersForUser(req, runtimeFilters);
      validateExternalMssqlWidgetQuery(filter, requestedData);
      const result = await executeReadOnlyWidgetQuery(filter, {
        source: requestedData,
        filters: resolvedRuntime,
      });
      return res.json({
        success: true,
        data: result.rows,
        erp_request: result.erpRequest,
        row_count: result.rows?.length || 0,
      });
    }

    const dbSource = normalizeDbSource(body.db_source || q.db_source || "ims_postgresql");
    const isHybridWidget = body.chart_config?.is_hybrid === true || dbSource === "hybrid";
    const hybridExternalSource = normalizeDbSource(
      body?.chart_config?.hybrid_external_source
        || (isExternalMssqlSource(dbSource) ? dbSource : "erp_mssql"),
    );
    if (isExternalMssqlSource(dbSource) && !isHybridWidget) {
      const rawSql = resolveErpMssqlSqlFromRequest(body, q);
      const runtimeFilters = resolveWidgetFiltersForUser(
        req,
        resolveErpMssqlRuntimeFilters(body, q),
      );
      validateExternalMssqlWidgetQuery(rawSql, dbSource);
      const result = await executeReadOnlyWidgetQuery(rawSql, { 
        source: dbSource, 
        filters: runtimeFilters,
        is_hybrid: body.chart_config?.is_hybrid === true,
        hybrid_mssql_query: body.chart_config?.hybrid_mssql_query
      });
      return res.json({
        success: true,
        data: result.rows,
        erp_request: result.erpRequest,
        row_count: result.rows?.length || 0,
      });
    }

    const rawSql = String(body.query || q.query || "").trim();
    const filters = resolveWidgetFiltersForUser(req, body.filters || q.filters || {});
    const result = await executeReadOnlyWidgetQuery(rawSql, {
      source: dbSource, 
      filters,
      is_hybrid: isHybridWidget,
      hybrid_mssql_query: body.chart_config?.hybrid_mssql_query,
      hybrid_external_source: hybridExternalSource,
    });
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const hybridPreviewHandler = async (req, res) => {
  try {
    const { mssql_query, pg_query, db_source, filters, stage_only } = req.body;

    if (!mssql_query) {
      throw new Error("External MSSQL query is required.");
    }

    const source = normalizeDbSource(db_source || "erp_mssql");
    const externalSource = source === "hybrid" ? "erp_mssql" : source;
    if (!isExternalMssqlSource(externalSource)) {
      throw new Error("Hybrid staging requires an external SQL Server source (ERP / HRMS).");
    }
    const runtimeFilters = resolveWidgetFiltersForUser(req, filters || {});

    if (stage_only === true || !pg_query) {
      validateExternalMssqlWidgetQuery(mssql_query, externalSource);
      const preview = await HybridQueryEngine.previewExternal(
        { mssqlQuery: mssql_query, source: externalSource },
        runtimeFilters,
      );
      return res.json({
        success: true,
        data: preview.sampleRows,
        columns: preview.columns,
        placeholder: preview.placeholder,
        row_count: preview.sampleRows.length,
        external_row_count: preview.externalRowCount,
      });
    }

    validateExternalMssqlWidgetQuery(mssql_query, externalSource);

    const result = await HybridQueryEngine.executeHybridPreview(
      { mssqlQuery: mssql_query, source: externalSource },
      pg_query,
      runtimeFilters,
    );

    res.json({
      success: true,
      data: result.rows,
      row_count: result.rowCount,
      external_row_count: result.externalRowCount,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

async function resolveRuntimeDashboardConfig(appKey, userId, requestedDashboardKey = "default", { isSuperAdmin = false } = {}) {
  const storagePageKey = "default";
  const normalizedRequestedKey = normalizeDashboardKey(requestedDashboardKey);

  if (isSuperAdmin) {
    return getDashboardConfigByKey(appKey, storagePageKey, normalizedRequestedKey, { publishedOnly: true });
  }

  if (normalizedRequestedKey !== "default") {
    const hasAccess = await userCanAccessDashboard(appKey, storagePageKey, userId, normalizedRequestedKey, {
      publishedOnly: true,
    });
    if (!hasAccess) return null;
    return getDashboardConfigByKey(appKey, storagePageKey, normalizedRequestedKey, { publishedOnly: true });
  }

  const accessible = await listUserAccessibleDashboards(appKey, storagePageKey, userId, { publishedOnly: true });
  if (!accessible.length) return null;

  const resolvedKey = resolveUserDefaultDashboardKey(accessible, userId);
  return getDashboardConfigByKey(appKey, storagePageKey, resolvedKey, { publishedOnly: true });
}

function resolveDefaultForUserIds({
  dashboardKey = "default",
  defaultForUserIds = undefined,
  existingMeta = {},
  targetUserIds = [],
} = {}) {
  if (defaultForUserIds === undefined) {
    return normalizeTargetUserIds(existingMeta?.defaultForUserIds || []);
  }
  const normalized = normalizeTargetUserIds(defaultForUserIds);
  const allowedTargets = normalizeTargetUserIds(targetUserIds.length ? targetUserIds : existingMeta?.targetUserIds || []);
  if (!allowedTargets.length) return normalized;
  return normalized.filter((id) => allowedTargets.includes(id));
}

async function applyDashboardDefaultForUsers(appKey, pageKey, dashboardKey, defaultForUserIds = [], actorId = null) {
  const normalized = normalizeTargetUserIds(defaultForUserIds);
  if (!normalized.length) return;
  await clearDefaultForUsersFromOtherDashboards(appKey, pageKey, dashboardKey, normalized, actorId);
}

function resolveDashboardScopeAndUsers({
  dashboardKey = "default",
  scope = "global",
  targetUserIds = [],
  existingMeta = {},
} = {}) {
  const normalizedKey = normalizeDashboardKey(dashboardKey);
  const incomingUsers = normalizeTargetUserIds(targetUserIds);
  const existingUsers = normalizeTargetUserIds(existingMeta?.targetUserIds || []);
  const existingScope = String(existingMeta?.scope || "global").toLowerCase();

  if (normalizedKey === "default") {
    return { scope: "global", targetUserIds: [] };
  }

  if (String(scope || "").toLowerCase() === "users" || existingScope === "users") {
    return {
      scope: "users",
      targetUserIds: incomingUsers.length ? incomingUsers : existingUsers,
    };
  }

  return {
    scope: incomingUsers.length ? "users" : "global",
    targetUserIds: incomingUsers.length ? incomingUsers : [],
  };
}

export const getDashboardStatusHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app_key || req.query?.app || "ims");
    const requestedDashboardKey = normalizeDashboardKey(
      req.body?.dashboard_key || req.query?.dashboard_key || "default",
    );
    const configRow = await resolveRuntimeDashboardConfig(appKey, req.user?.id, requestedDashboardKey, {
      isSuperAdmin: isSuperAdminUser(req.user),
    });
    res.json({
      success: true,
      data: {
        active: Boolean(configRow),
        published: Boolean(configRow),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getDashboardWidgetsHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app);
    const viewPageKey = String(req.body?.page_key || req.query?.page_key || "dashboard").trim().toLowerCase() || "dashboard";
    const requestedDashboardKey = normalizeDashboardKey(req.body?.dashboard_key || req.query?.dashboard_key || "default");
    const userType = String(req.user?.type || "").toLowerCase().trim();
    const isSuperAdmin = userType === "super_admin" || userType === "super admin";
    const runtimeFilters = resolveWidgetFiltersForUser(req, req.body?.filters || req.query?.filters || {});

    const configRow = await resolveRuntimeDashboardConfig(appKey, req.user?.id, requestedDashboardKey, {
      isSuperAdmin,
    });
    const parsedConfig = configRow ? normalizeDashboardJson(configRow.dashboard_json) : { widgets: [] };
    const allWidgets = configRow
      ? parsedConfig.widgets.map((widget, idx) => widgetToRuntimeRow(widget, idx))
      : [];

    // Page Access controls which widgets a user sees on the main dashboard (by permission).
    // Widgets are NOT embedded on individual app pages.
    const pageWidgets = isAppMainDashboardView(appKey, viewPageKey) ? allWidgets : [];

    const visible = [];
    for (const widget of pageWidgets) {
      const canByAudience = canUserSeeWidgetByAudience(widget, req.user?.id, isSuperAdmin);
      if (!canByAudience) continue;
      const canViewPage = await userCanViewPageModule(req.user, widget?.target_page_module);
      if (!canViewPage) continue;
      visible.push(widget);
    }
    const dedupedVisible = dedupeWidgets(visible);

    const toPublicWidget = (widget, extra = {}) => {
      const chartConfig = widget?.chart_config && typeof widget.chart_config === "object" ? widget.chart_config : {};
      const layout = widget?.layout && typeof widget.layout === "object" ? widget.layout : {};
      return {
        id: widget.id,
        title: widget.title || "",
        description: widget.description || "",
        type: widget.type,
        chart_config: chartConfig,
        layout,
        mobile_layout: widget?.mobile_layout && typeof widget.mobile_layout === "object" ? widget.mobile_layout : layout,
        audience_scope: String(widget.audience_scope || "global").toLowerCase(),
        target_user_ids: Array.isArray(widget.target_user_ids) ? widget.target_user_ids : [],
        ...extra,
      };
    };

    const results = [];
    for (const widget of dedupedVisible) {
      try {
        if (widget.type === "heading" || widget.type === "section") {
          results.push(toPublicWidget(widget, { data: [], error: null, has_query: false }));
          continue;
        }
        const queryConfigured = isConfiguredWidgetQuery(widget.query);
        if (!queryConfigured) {
          results.push(toPublicWidget(widget, { data: [], error: null, has_query: false }));
          continue;
        }
        const widgetSource = normalizeDbSource(widget?.chart_config?.data_source || "ims_postgresql");
        const isHybridWidget = widget?.chart_config?.is_hybrid === true || widgetSource === "hybrid";
        const hybridExternalSource = normalizeDbSource(
          widget?.chart_config?.hybrid_external_source
            || (isExternalMssqlSource(widgetSource) ? widgetSource : "erp_mssql"),
        );
        const result = await executeReadOnlyWidgetQuery(widget.query, {
          source: widgetSource,
          filters: runtimeFilters,
          is_hybrid: isHybridWidget,
          hybrid_mssql_query: widget?.chart_config?.hybrid_mssql_query,
          hybrid_external_source: hybridExternalSource,
        });
        results.push(toPublicWidget(widget, { data: result.rows, error: null, has_query: true }));
      } catch (error) {
        results.push(toPublicWidget(widget, {
          data: [],
          error: error?.message || "Failed to load this widget.",
          has_query: true,
        }));
      }
    }

    // Only strip global IMS meta when something actually rendered. If every
    // IMS-backed widget failed and returned no rows, leave ims_meta so the
    // client canasts at failure time (not as a false positive beside content).
    const hasUsableWidgetRows = results.some(
      (widget) => Array.isArray(widget?.data) && widget.data.length > 0,
    );
    if (hasUsableWidgetRows) {
      clearImsMetaForResponse();
    }
    res.json({
      success: true,
      data: results,
      layout_blueprint: buildLayoutBlueprint(pageWidgets),
      layout_px: Array.isArray(parsedConfig.layout_px) ? parsedConfig.layout_px : [],
      canvas_width: Number.isFinite(Number(parsedConfig.canvas_width)) && Number(parsedConfig.canvas_width) >= 200
        ? Math.round(Number(parsedConfig.canvas_width))
        : null,
      layout_px_mobile: Array.isArray(parsedConfig.layout_px_mobile) ? parsedConfig.layout_px_mobile : [],
      canvas_width_mobile: Number.isFinite(Number(parsedConfig.canvas_width_mobile)) && Number(parsedConfig.canvas_width_mobile) >= 200
        ? Math.round(Number(parsedConfig.canvas_width_mobile))
        : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const saveDashboardDraftHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || dashboardKey || "Dashboard").trim() || "Dashboard";
    const dashboardJson = normalizeDashboardJson(req.body?.dashboard_json || {});
    const scope = String(req.body?.scope || "global").trim().toLowerCase();
    const targetUserIds = normalizeTargetUserIds(req.body?.target_user_ids);
    if (!dashboardJson.widgets.length) {
      return res.status(400).json({ success: false, message: "Dashboard widgets are required." });
    }

    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    const { meta: existingMeta } = parseDashboardDocument(existing?.dashboard_json);
    const keepPublished = existingMeta?.published === true;
    const { scope: resolvedScope, targetUserIds: resolvedTargetUserIds } = resolveDashboardScopeAndUsers({
      dashboardKey,
      scope,
      targetUserIds,
      existingMeta,
    });
    const resolvedDefaultForUserIds = resolveDefaultForUserIds({
      dashboardKey,
      defaultForUserIds: req.body?.default_for_user_ids,
      existingMeta,
      targetUserIds: resolvedTargetUserIds,
    });
    await applyDashboardDefaultForUsers(appKey, pageKey, dashboardKey, resolvedDefaultForUserIds, req.user?.id ?? null);

    const { widgets: normalizedWidgets, layoutPx: normalizedLayoutPx, layoutPxMobile: normalizedLayoutPxMobile } = remapDashboardWidgetIds(
      dashboardJson.widgets,
      dashboardJson.layout_px,
      dashboardJson.layout_px_mobile,
    );

    const row = await upsertDashboardConfig({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: resolvedScope,
      targetUserIds: resolvedTargetUserIds,
      defaultForUserIds: resolvedDefaultForUserIds,
      dashboardJson: {
        ...dashboardJson,
        widgets: normalizedWidgets,
        ...(normalizedLayoutPx.length ? { layout_px: normalizedLayoutPx } : {}),
        ...(normalizedLayoutPxMobile.length ? { layout_px_mobile: normalizedLayoutPxMobile } : {}),
      },
      actorId: req.user?.id ?? null,
      isPublished: keepPublished,
      pageModule: null,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const publishDashboardConfigHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || dashboardKey || "Dashboard").trim() || "Dashboard";
    const dashboardJson = normalizeDashboardJson(req.body?.dashboard_json || {});
    const scope = String(req.body?.scope || "global").trim().toLowerCase();
    const targetUserIds = normalizeTargetUserIds(req.body?.target_user_ids);
    if (!dashboardJson.widgets.length) {
      return res.status(400).json({ success: false, message: "Dashboard widgets are required." });
    }
    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    const { meta: existingMeta } = parseDashboardDocument(existing?.dashboard_json || {});
    const { scope: resolvedScope, targetUserIds: resolvedTargetUserIds } = resolveDashboardScopeAndUsers({
      dashboardKey,
      scope,
      targetUserIds,
      existingMeta,
    });
    const resolvedDefaultForUserIds = resolveDefaultForUserIds({
      dashboardKey,
      defaultForUserIds: req.body?.default_for_user_ids,
      existingMeta,
      targetUserIds: resolvedTargetUserIds,
    });
    await applyDashboardDefaultForUsers(appKey, pageKey, dashboardKey, resolvedDefaultForUserIds, req.user?.id ?? null);
    const { widgets: normalizedWidgets, layoutPx: normalizedLayoutPx, layoutPxMobile: normalizedLayoutPxMobile } = remapDashboardWidgetIds(
      dashboardJson.widgets,
      dashboardJson.layout_px,
      dashboardJson.layout_px_mobile,
    );
    const row = await upsertDashboardConfig({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: resolvedScope,
      targetUserIds: resolvedTargetUserIds,
      defaultForUserIds: resolvedDefaultForUserIds,
      dashboardJson: {
        ...dashboardJson,
        widgets: normalizedWidgets,
        ...(normalizedLayoutPx.length ? { layout_px: normalizedLayoutPx } : {}),
        ...(normalizedLayoutPxMobile.length ? { layout_px_mobile: normalizedLayoutPxMobile } : {}),
      },
      actorId: req.user?.id ?? null,
      isPublished: true,
      pageModule: null,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const unpublishDashboardConfigHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || "default");
    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Dashboard not found." });
    }
    const { doc, meta, widgets } = parseDashboardDocument(existing.dashboard_json);
    const row = await upsertDashboardConfig({
      appKey: meta.appKey || appKey,
      pageKey: meta.pageKey || pageKey,
      dashboardKey: meta.dashboardKey || dashboardKey,
      dashboardName: meta.dashboardName || dashboardKey,
      scope: meta.scope || "global",
      targetUserIds: meta.targetUserIds || [],
      dashboardJson: { version: doc.version || 1, widgets },
      actorId: req.user?.id ?? null,
      isPublished: false,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteDashboardConfigHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || "default");
    if (dashboardKey === "default") {
      return res.status(400).json({ success: false, message: 'Default dashboard cannot be deleted.' });
    }
    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Dashboard not found." });
    }
    const row = await deactivateDashboardByKey(appKey, pageKey, dashboardKey, req.user?.id ?? null);
    if (!row) {
      return res.status(404).json({ success: false, message: "Dashboard not found." });
    }
    res.json({ success: true, data: { dashboard_key: dashboardKey, deleted: true } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const cloneDashboardToUsersHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const sourceDashboardKey = normalizeDashboardKey(req.body?.source_dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || "").trim() || `Clone ${Date.now()}`;
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || dashboardName);
    const cloneForAll = Boolean(req.body?.clone_for_all);
    const userIds = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    if (!userIds.length) {
      return res.status(400).json({
        success: false,
        message: cloneForAll
          ? "No active users found to assign this clone."
          : "Select at least one user for this clone.",
      });
    }

    const sourceConfig = await getDashboardConfigByKey(appKey, pageKey, sourceDashboardKey, { publishedOnly: false });
    let dashboardJson = req.body?.dashboard_json
      ? normalizeDashboardJson(req.body.dashboard_json)
      : sourceConfig
        ? normalizeDashboardJson(sourceConfig.dashboard_json)
        : { version: 1, widgets: [] };
    if (!dashboardJson.widgets.length && sourceConfig) {
      dashboardJson = {
        ...dashboardJson,
        widgets: normalizeDashboardJson(sourceConfig.dashboard_json).widgets,
      };
    }
    if (!dashboardJson.widgets.length) {
      return res.status(400).json({ success: false, message: "No widgets found to clone. Add widgets first." });
    }
    if (dashboardKey === "default") {
      return res.status(400).json({ success: false, message: 'Clone dashboard key cannot be "default".' });
    }

    const normalizedWidgets = dashboardJson.widgets.map((widget, idx) => {
      const stored = widgetToStoredJson(widget, idx);
      stored.layout = sanitizeLayoutCoords(stored.layout, stored.id, idx);
      return stored;
    });
    dashboardJson = { ...dashboardJson, widgets: normalizedWidgets };

    const setAsDefault = Boolean(req.body?.set_as_default_for_users);
    const defaultForUserIds = setAsDefault ? userIds : [];
    if (defaultForUserIds.length) {
      await applyDashboardDefaultForUsers(appKey, pageKey, dashboardKey, defaultForUserIds, req.user?.id ?? null);
    }

    const row = await upsertDashboardConfig({
      appKey,
      pageKey,
      dashboardKey,
      dashboardName,
      scope: "users",
      targetUserIds: userIds,
      defaultForUserIds,
      dashboardJson,
      actorId: req.user?.id ?? null,
      isPublished: true,
    });
    res.json({
      success: true,
      data: {
        id: row?.id,
        dashboard_key: dashboardKey,
        dashboard_name: dashboardName,
        target_user_ids: cloneForAll ? "all" : userIds,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const listDashboardConfigsHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app_key || "ims");
    const pageKey = String(req.body?.page_key || req.query?.page_key || "default").trim().toLowerCase() || "default";
    const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: true });
    const seen = new Map();
    const data = [];
    for (const row of rows) {
      const { meta } = parseDashboardDocument(row?.dashboard_json);
      const dashboardKey = normalizeDashboardKey(meta.dashboardKey || "default");
      if (seen.has(dashboardKey)) continue;
      seen.set(dashboardKey, true);
      data.push({
        id: row.id,
        dashboard_key: dashboardKey,
        dashboard_name: dashboardKey === "default"
          ? "Default"
          : String(meta.dashboardName || meta.dashboardKey || "Dashboard"),
        scope: String(meta.scope || "global"),
        target_user_ids: Array.isArray(meta.targetUserIds) ? meta.targetUserIds : [],
        default_for_user_ids: Array.isArray(meta.defaultForUserIds) ? meta.defaultForUserIds : [],
        published: meta.published === true,
      });
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserDashboardsHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || req.query?.app_key || req.query?.app || "ims");
    const pageKey = "default";
    const userId = req.user?.id;
    const isSuperAdmin = isSuperAdminUser(req.user);
    const accessible = isSuperAdmin
      ? await listAllPublishedDashboards(appKey, pageKey, { publishedOnly: true })
      : await listUserAccessibleDashboards(appKey, pageKey, userId, { publishedOnly: true });
    const defaultKey = resolveUserDefaultDashboardKey(accessible, userId);
    const dashboards = accessible.map((item) => ({
      dashboard_key: item.dashboardKey,
      dashboard_name: item.dashboardName,
      is_default: item.dashboardKey === defaultKey,
      scope: item.scope || "global",
      target_user_count: Number(item.targetUserCount) || 0,
    }));

    res.json({
      success: true,
      data: {
        default_key: defaultKey,
        has_clone_access: accessible.some((item) => item.scope === "users"),
        show_switcher: isSuperAdmin ? dashboards.length > 0 : dashboards.length > 1,
        dashboards,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const renameDashboardConfigHandler = async (req, res) => {
  try {
    const appKey = normalizeAppKey(req.body?.app_key || "ims");
    const pageKey = String(req.body?.page_key || "default").trim().toLowerCase() || "default";
    const dashboardKey = normalizeDashboardKey(req.body?.dashboard_key || "default");
    const dashboardName = String(req.body?.dashboard_name || "").trim();
    if (dashboardKey === "default") {
      return res.status(400).json({ success: false, message: "Default dashboard cannot be renamed." });
    }
    if (!dashboardName) {
      return res.status(400).json({ success: false, message: "Dashboard name is required." });
    }
    const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Dashboard not found." });
    }
    const { doc, meta, widgets } = parseDashboardDocument(existing.dashboard_json);
    const row = await upsertDashboardConfig({
      appKey: meta.appKey || appKey,
      pageKey: meta.pageKey || pageKey,
      dashboardKey: meta.dashboardKey || dashboardKey,
      dashboardName,
      scope: meta.scope || "global",
      targetUserIds: meta.targetUserIds || [],
      defaultForUserIds: meta.defaultForUserIds || [],
      dashboardJson: { version: doc.version || 1, widgets },
      actorId: req.user?.id ?? null,
      isPublished: meta.published !== false,
      pageModule: meta.pageModule || null,
    });
    res.json({
      success: true,
      data: {
        dashboard_key: dashboardKey,
        dashboard_name: dashboardName,
        row,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
