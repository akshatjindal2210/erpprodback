import dbQuery from "../../../config/db.js";
import { DASHBOARD_CONFIG_TABLE } from "../config/tables/dashboardConfig.table.js";
import { buildDashboardDocument, normalizeUserIds, parseDashboardDocument } from "../utils/dashboardJsonSchema.js";

export async function listDashboardConfigs(appKey, pageKey, { includeDraft = true } = {}) {  const rows = await dbQuery(
    `SELECT * FROM ${DASHBOARD_CONFIG_TABLE}
      WHERE dashboard_json->'meta'->>'appKey' = $1
        AND dashboard_json->'meta'->>'pageKey' = $2
        AND COALESCE((dashboard_json->'meta'->>'active')::boolean, true) = true
        ${includeDraft ? "" : "AND COALESCE((dashboard_json->'meta'->>'published')::boolean, false) = true"}
      ORDER BY updated_at DESC, id DESC`,
    [appKey, pageKey],
  );
  return rows;
}

export async function getDashboardConfigByKey(
  appKey,
  pageKey,
  dashboardKey,
  { publishedOnly = false } = {},
) {
  const rows = await dbQuery(
    `SELECT * FROM ${DASHBOARD_CONFIG_TABLE}
      WHERE dashboard_json->'meta'->>'appKey' = $1
        AND dashboard_json->'meta'->>'pageKey' = $2
        AND dashboard_json->'meta'->>'dashboardKey' = $3
        AND COALESCE((dashboard_json->'meta'->>'active')::boolean, true) = true
        ${publishedOnly ? "AND COALESCE((dashboard_json->'meta'->>'published')::boolean, false) = true" : ""}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [appKey, pageKey, dashboardKey],
  );
  return rows[0] || null;
}

export async function getGlobalDashboardConfig(appKey, pageKey, { publishedOnly = false } = {}) {
  return getDashboardConfigByKey(appKey, pageKey, "default", { publishedOnly });
}

export async function getUserDashboardConfig(appKey, pageKey, userId, { publishedOnly = false } = {}) {
  const accessible = await listUserAccessibleDashboards(appKey, pageKey, userId, { publishedOnly });
  if (!accessible.length) return null;
  const defaultKey = resolveUserDefaultDashboardKey(accessible, userId);
  return getDashboardConfigByKey(appKey, pageKey, defaultKey, { publishedOnly });
}

export async function listAllPublishedDashboards(appKey, pageKey, { publishedOnly = true } = {}) {
  const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: !publishedOnly });
  const dashboards = [];

  for (const row of rows) {
    const { meta } = parseDashboardDocument(row?.dashboard_json);
    if (publishedOnly && meta?.published !== true) continue;

    const dashboardKey = String(meta?.dashboardKey || "default").trim().toLowerCase() || "default";
    dashboards.push({
      dashboardKey,
      dashboardName: String(meta?.dashboardName || dashboardKey).trim() || dashboardKey,
      scope: String(meta?.scope || "global"),
      targetUserIds: normalizeUserIds(meta?.targetUserIds || []),
      defaultForUserIds: normalizeUserIds(meta?.defaultForUserIds || []),
      targetUserCount: normalizeUserIds(meta?.targetUserIds || []).length,
      updatedAt: row.updated_at || null,
    });
  }

  return dashboards.sort((rowA, rowB) => {
    if (rowA.dashboardKey === "default") return -1;
    if (rowB.dashboardKey === "default") return 1;
    const timeA = new Date(rowA.updatedAt || 0).getTime();
    const timeB = new Date(rowB.updatedAt || 0).getTime();
    return timeB - timeA;
  });
}

export async function listUserAccessibleDashboards(appKey, pageKey, userId, { publishedOnly = true } = {}) {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return [];
  const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: !publishedOnly });
  const clones = [];
  let globalDefault = null;

  for (const row of rows) {
    const { meta } = parseDashboardDocument(row?.dashboard_json);
    if (publishedOnly && meta?.published !== true) continue;

    const dashboardKey = String(meta?.dashboardKey || "default");
    const scope = String(meta?.scope || "global");
    const targetUserIds = normalizeUserIds(meta?.targetUserIds || []);
    const defaultForUserIds = normalizeUserIds(meta?.defaultForUserIds || []);

    if (dashboardKey === "default" && scope === "global") {
      globalDefault = {
        dashboardKey,
        dashboardName: String(meta?.dashboardName || "Default").trim() || "Default",
        scope,
        targetUserIds: [],
        defaultForUserIds,
        targetUserCount: 0,
        updatedAt: row.updated_at || null,
      };
      continue;
    }

    if (scope === "users" && targetUserIds.includes(numericUserId)) {
      clones.push({
        dashboardKey,
        dashboardName: String(meta?.dashboardName || dashboardKey).trim() || dashboardKey,
        scope,
        targetUserIds,
        defaultForUserIds,
        targetUserCount: targetUserIds.length,
        updatedAt: row.updated_at || null,
      });
    }
  }

  // Assigned clone dashboards replace the app global default for that user.
  if (clones.length) return clones;
  return globalDefault ? [globalDefault] : [];
}

export function resolveUserDefaultDashboardKey(accessible = [], userId) {
  const numericUserId = Number(userId);
  if (!accessible.length) return "default";

  const markedDefault = accessible.find((item) =>
    (item.defaultForUserIds || []).includes(numericUserId),
  );
  if (markedDefault) return markedDefault.dashboardKey;

  if (accessible.length === 1) return accessible[0].dashboardKey;

  const sorted = [...accessible].sort((rowA, rowB) => {
    const sizeA = Number(rowA?.targetUserCount) || 0;
    const sizeB = Number(rowB?.targetUserCount) || 0;
    if (sizeA !== sizeB) return sizeA - sizeB;
    const timeA = new Date(rowA.updatedAt || 0).getTime();
    const timeB = new Date(rowB.updatedAt || 0).getTime();
    return timeB - timeA;
  });
  return sorted[0]?.dashboardKey || accessible[0]?.dashboardKey || "default";
}

export async function userCanAccessDashboard(appKey, pageKey, userId, dashboardKey, { publishedOnly = true } = {}) {
  const normalizedKey = String(dashboardKey || "default").trim().toLowerCase() || "default";
  const accessible = await listUserAccessibleDashboards(appKey, pageKey, userId, { publishedOnly });
  return accessible.some((item) => item.dashboardKey === normalizedKey);
}

export async function clearDefaultForUsersFromOtherDashboards(appKey, pageKey, keepDashboardKey, userIds = [], actorId = null) {
  const normalizedKeepKey = String(keepDashboardKey || "default").trim().toLowerCase() || "default";
  const normalizedUserIds = normalizeUserIds(userIds);
  if (!normalizedUserIds.length) return;

  const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: true });
  for (const row of rows) {
    const { doc, meta, widgets } = parseDashboardDocument(row?.dashboard_json);
    const dashboardKey = String(meta?.dashboardKey || "default");
    if (dashboardKey === normalizedKeepKey) continue;

    const existingDefaults = normalizeUserIds(meta?.defaultForUserIds || []);
    const nextDefaults = existingDefaults.filter((id) => !normalizedUserIds.includes(id));
    if (nextDefaults.length === existingDefaults.length) continue;

    const payload = buildDashboardDocument({
      appKey: meta.appKey || appKey,
      pageKey: meta.pageKey || pageKey,
      dashboardKey,
      dashboardName: meta.dashboardName || dashboardKey,
      scope: meta.scope || "global",
      targetUserIds: meta.targetUserIds || [],
      defaultForUserIds: nextDefaults,
      widgets,
      actorId,
      isPublished: meta.published !== false,
      isActive: meta.active !== false,
      version: doc.version || 1,
      pageModule: meta.pageModule || null,
    });
    await dbQuery(
      `UPDATE ${DASHBOARD_CONFIG_TABLE}
          SET dashboard_json = $1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [payload, row.id],
    );
  }
}

export async function upsertDashboardConfig({
  appKey,
  pageKey,
  dashboardKey,
  dashboardName,
  scope = "global",
  targetUserIds = [],
  dashboardJson,
  actorId = null,
  isPublished = true,
  pageModule = null,
  defaultForUserIds = undefined,
}) {
  const normalizedDashboardKey = String(dashboardKey || "default").trim().toLowerCase() || "default";
  const normalizedScope = scope === "users" ? "users" : "global";
  const normalizedTargetUsers = normalizedScope === "users" ? normalizeUserIds(targetUserIds) : [];
  const incoming = parseDashboardDocument(dashboardJson);
  const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: true });
  const existing = rows.find((row) => {
    const { meta } = parseDashboardDocument(row?.dashboard_json);
    return String(meta?.dashboardKey || "") === normalizedDashboardKey;
  });
  const existingMeta = existing ? parseDashboardDocument(existing.dashboard_json).meta : {};
  const resolvedPageModule =
    pageModule !== undefined && pageModule !== null
      ? String(pageModule || "").trim() || null
      : existingMeta?.pageModule || null;
  const resolvedDefaultForUserIds =
    defaultForUserIds !== undefined
      ? normalizeUserIds(defaultForUserIds)
      : normalizeUserIds(existingMeta?.defaultForUserIds || []);

  const payload = buildDashboardDocument({
    appKey,
    pageKey,
    dashboardKey: normalizedDashboardKey,
    dashboardName: String(dashboardName || normalizedDashboardKey || "Dashboard").trim(),
    scope: normalizedScope,
    targetUserIds: normalizedTargetUsers,
    defaultForUserIds: resolvedDefaultForUserIds,
    widgets: incoming.widgets,
    actorId,
    isPublished,
    version: incoming.doc?.version || 1,
    pageModule: resolvedPageModule,
  });

  if (existing?.id) {
    const updated = await dbQuery(
      `UPDATE ${DASHBOARD_CONFIG_TABLE}
          SET dashboard_json = $1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *`,
      [payload, existing.id],
    );
    return updated[0] || null;
  }

  const inserted = await dbQuery(
    `INSERT INTO ${DASHBOARD_CONFIG_TABLE} (dashboard_json) VALUES ($1) RETURNING *`,
    [payload],
  );
  return inserted[0] || null;
}

export async function getDashboardWidgetsFromConfig(appKey, pageKey, dashboardKey = "default") {
  const row = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
  if (!row) return [];
  const { widgets } = parseDashboardDocument(row.dashboard_json);
  return widgets;
}

export async function saveDashboardWidgetsToConfig({
  appKey,
  pageKey,
  dashboardKey = "default",
  dashboardName = "Default",
  scope = "global",
  targetUserIds = [],
  widgets = [],
  actorId = null,
  isPublished = false,
}) {
  return upsertDashboardConfig({
    appKey,
    pageKey,
    dashboardKey,
    dashboardName,
    scope,
    targetUserIds,
    dashboardJson: { version: 1, widgets },
    actorId,
    isPublished,
  });
}

export async function deactivateDashboardByKey(appKey, pageKey, dashboardKey, actorId = null) {
  const existing = await getDashboardConfigByKey(appKey, pageKey, dashboardKey, { publishedOnly: false });
  if (!existing?.id) return null;
  const { doc, meta, widgets } = parseDashboardDocument(existing.dashboard_json);
  const updatedPayload = buildDashboardDocument({
    appKey: meta.appKey || appKey,
    pageKey: meta.pageKey || pageKey,
    dashboardKey: meta.dashboardKey || dashboardKey,
    dashboardName: meta.dashboardName || dashboardKey,
    scope: meta.scope || "global",
    targetUserIds: meta.targetUserIds || [],
    defaultForUserIds: meta.defaultForUserIds || [],
    widgets,
    actorId,
    isPublished: meta.published !== false,
    isActive: false,
    version: doc.version || 1,
    pageModule: meta.pageModule || null,
  });
  const rows = await dbQuery(
    `UPDATE ${DASHBOARD_CONFIG_TABLE}
        SET dashboard_json = $1,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *`,
    [updatedPayload, existing.id],
  );
  return rows[0] || null;
}
