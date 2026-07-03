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
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return null;
  const rows = await listDashboardConfigs(appKey, pageKey, { includeDraft: !publishedOnly });
  const matches = rows.filter((row) => {
    const { meta } = parseDashboardDocument(row?.dashboard_json);
    if (String(meta?.dashboardKey || "default") === "default") return false;
    if (String(meta?.scope || "global") !== "users") return false;
    if (publishedOnly && meta?.published !== true) return false;
    return normalizeUserIds(meta?.targetUserIds || []).includes(numericUserId);
  });
  if (!matches.length) return null;

  // Prefer the most specific assignment (smallest user list), then latest update.
  matches.sort((rowA, rowB) => {
    const metaA = parseDashboardDocument(rowA.dashboard_json).meta;
    const metaB = parseDashboardDocument(rowB.dashboard_json).meta;
    const sizeA = normalizeUserIds(metaA?.targetUserIds || []).length;
    const sizeB = normalizeUserIds(metaB?.targetUserIds || []).length;
    if (sizeA !== sizeB) return sizeA - sizeB;
    const timeA = new Date(rowA.updated_at || 0).getTime();
    const timeB = new Date(rowB.updated_at || 0).getTime();
    return timeB - timeA;
  });

  return matches[0];
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

  const payload = buildDashboardDocument({
    appKey,
    pageKey,
    dashboardKey: normalizedDashboardKey,
    dashboardName: String(dashboardName || normalizedDashboardKey || "Dashboard").trim(),
    scope: normalizedScope,
    targetUserIds: normalizedTargetUsers,
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
