import dbQuery from "../../../config/db.js";
import { createWidget, deleteWidget, ensureWidgetsTable, getUserViewableModuleNames, listActiveWidgets, listWidgets, publishWidget, updateWidget } from "../models/widget.model.js";
import { executeReadOnlyWidgetQuery } from "../utils/queryExecutor.js";
import { validateSelectSql } from "../utils/sqlGenerator.js";

const TABLE_MODULE_OVERRIDES = {
  ims_location_master: "location_master",
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

function canUserSeeWidgetByQuery(widgetQuery, allowedModuleSet, isSuperAdmin) {
  if (isSuperAdmin) return true;
  const requiredModules = modulesFromQuery(widgetQuery);
  if (requiredModules.length === 0) return true;
  return requiredModules.some((moduleName) => allowedModuleSet.has(moduleName));
}

export const getTables = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const query = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `;
    const tables = await dbQuery(query);
    res.json({ success: true, data: tables.map((t) => t.table_name) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getColumns = async (req, res) => {
  const { table } = req.params;
  try {
    await ensureWidgetsTable();
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
  const allowedTypes = new Set(["count", "sum", "table", "graph", "heading", "section"]);
  const title = String(body.title || "").trim();
  const type = String(body.type || "").trim().toLowerCase();
  const query = String(body.query || "").trim();
  const requiresQuery = type === "count" || type === "sum" || type === "table" || type === "graph";

  if (!allowedTypes.has(type)) throw new Error("Invalid widget type.");
  if (requiresQuery) {
    validateSelectSql(query);
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
            : type === "heading"
              ? "Dashboard Heading"
              : "Section";

  return {
    title: title || autoTitle,
    description: String(body.description || "").trim(),
    type,
    query: requiresQuery ? query : "",
    chart_config: body.chart_config && typeof body.chart_config === "object" ? body.chart_config : {},
    layout: body.layout && typeof body.layout === "object" ? body.layout : {},
    permission_key: null,
    is_active: body.is_active !== false,
    // create/update should always stay draft; publish endpoint makes it live.
    is_published: false,
  };
}

export const createWidgetHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const payload = sanitizeWidgetBody(req.body);
    const row = await createWidget({
      ...payload,
      created_by: req.user?.id ?? null,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateWidgetHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const payload = sanitizeWidgetBody(req.body);
    const row = await updateWidget(id, payload);
    if (!row) return res.status(404).json({ success: false, message: "Widget not found." });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteWidgetHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const deleted = await deleteWidget(id);
    if (!deleted) return res.status(404).json({ success: false, message: "Widget not found." });
    res.json({ success: true, data: deleted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const publishWidgetHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid widget id." });
    }
    const row = await publishWidget(id);
    if (!row) return res.status(404).json({ success: false, message: "Widget not found." });
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listWidgetsHandler = async (_req, res) => {
  try {
    await ensureWidgetsTable();
    const rows = await listWidgets();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const previewWidgetHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const rawSql = String(req.body?.query || req.query?.query || "").trim();
    validateSelectSql(rawSql);
    const data = await executeReadOnlyWidgetQuery(rawSql);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getDashboardWidgetsHandler = async (req, res) => {
  try {
    await ensureWidgetsTable();
    const userType = String(req.user?.type || "").toLowerCase().trim();
    const isSuperAdmin = userType === "super_admin" || userType === "super admin";
    const allWidgets = await listActiveWidgets();

    let allowedModuleSet = null;
    if (!isSuperAdmin) {
      const moduleNames = await getUserViewableModuleNames(req.user.id);
      allowedModuleSet = new Set(moduleNames);
    }

    const visible = allWidgets.filter((w) =>
      canUserSeeWidgetByQuery(w.query, allowedModuleSet || new Set(), isSuperAdmin),
    );

    const results = [];
    for (const widget of visible) {
      try {
        if (widget.type === "heading" || widget.type === "section") {
          results.push({ ...widget, data: [], error: null });
          continue;
        }
        const data = await executeReadOnlyWidgetQuery(widget.query);
        results.push({ ...widget, data, error: null });
      } catch (error) {
        // Keep dashboard resilient: one bad widget should not break all.
        results.push({ ...widget, data: [], error: error.message });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
