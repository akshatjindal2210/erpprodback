import { findModules, findModule, insertModule, updateModules } from "../models/module.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { clearAllCachedPermissions } from "../config/permissionCache.js";
import { sanitizeSearch } from "../utils/helper.js";
import { io } from "../../app.js";

const MODULE_CFG = getCrudModuleConfig("modules");

// ─── GET List ─────────────────────────────────────────────────────
export const getModules = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "sort_order", order: "ASC" });
    
    const result = await findModules({
      filters: sanitizeFilters(filters, MODULE_CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: MODULE_CFG.listFields,
      permission: req.permission
    });
    
    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET Single ───────────────────────────────────────────────────
export const getModuleById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const module = await findModule({ id });
    if (!module) return res.status(404).json({ success: false, message: "Module not found" });

    res.json({ success: true, data: module });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE ───────────────────────────────────────────────────────
export const createModule = async (req, res) => {
  try {
    const { name, label } = req.body;
    if (!name || !label) return res.status(400).json({ success: false, message: "Name/Label required" });

    const module = await insertModule({ name, label });

    await logActivity(req, { action: "create", entity: "modules", entity_id: module.id, details: { name } });
    res.status(201).json({ success: true, data: module, message: "Module created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE (Dynamic) ─────────────────────────────────────────────
export const updateModuleData = async (req, res) => { // Route calls updateModules
  try {
    const { id, ...updateFields } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const fields = { ...updateFields, updated_by: req.user.id, updated_at: new Date() };
    const rows = await updateModules(fields, { id });

    if (!rows.length) return res.status(404).json({ success: false, message: "Module not found" });

    if (Object.prototype.hasOwnProperty.call(updateFields, "is_active")) {
      clearAllCachedPermissions();
      io.emit("module_status_updated", { id, is_active: rows[0]?.is_active });
    }

    await logActivity(req, { action: "update", entity: "modules", entity_id: id });
    res.json({ success: true, data: rows[0], message: "Module updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── TOGGLE STATUS ────────────────────────────────────────────────
export const toggleModuleStatus = async (req, res) => {
  try {
    const { id } = req.body;
    if (id === undefined || id === null || id === "") {
      return res.status(400).json({ success: false, message: "ID required" });
    }

    const module = await findModule({ id });
    if (!module) return res.status(404).json({ success: false, message: "Module not found" });

    const rows = await updateModules(
      {
        is_active: !module.is_active,
        updated_by: req.user.id,
        updated_at: new Date(),
      },
      { id }
    );
    const updated = rows[0];
    if (!updated) return res.status(404).json({ success: false, message: "Module not found" });

    clearAllCachedPermissions();
    io.emit("module_status_updated", { id, is_active: updated.is_active });

    await logActivity(req, {
      action: "toggle",
      entity: "modules",
      entity_id: id,
      details: {
        is_active: updated.is_active,
        previous_is_active: module.is_active,
        updated_by: req.user.id,
      },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET Views (Helper API for other modules) ──────────────────
export const getModulesViews = async (req, res) => {
  try {
    const { id, page, limit, sortBy, order, search } = req.body || {};

    if (id) {
      const module = await findModule({ id });
      if (!module || !module.is_active) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { id: module.id, name: module.name, label: module.label } });
    }

    const rawOrder = order != null && String(order).trim() !== "" ? String(order).trim().toUpperCase() : "ASC";
    const normalizedOrder = rawOrder === "DESC" ? "DESC" : "ASC";

    const result = await findModules({
      search: sanitizeSearch(search),
      sort: { by: sortBy || "sort_order", order: normalizedOrder },
      page: page || 1,
      limit: limit || 5000,
      fields: ["id", "name", "label", "sort_order"],
      filters: { is_active: true }
    });
    
    return res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};