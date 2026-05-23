import {
  findModuleSops,
  findModuleSop,
  findModuleSopByModulePermission,
  insertModuleSop,
  updateModuleSop,
  deleteModuleSop,
} from "../models/moduleSop.model.js";
import { findModule } from "../models/module.model.js";
import { findUser } from "../models/user.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";

const SOP_FILTER_FIELDS = ["id", "module_id", "permission_type", "is_required", "from_date", "to_date"];

export const getModuleSops = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order } = extractListParams(req.body, {
      sortBy: "id",
      order: "ASC",
    });
    const finalFilters = sanitizeFilters(filters, SOP_FILTER_FIELDS);

    const result = await findModuleSops({
      filters: finalFilters,
      sort: { by: sortBy, order },
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getModuleSopById = async (req, res) => {
  try {
    const { id } = req.body;
    const row = await findModuleSop({ id });
    if (!row) return res.status(404).json({ success: false, message: "SOP not found" });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createModuleSop = async (req, res) => {
  try {
    const { module_id, permission_type, description, is_required } = req.body;
    const allowedPerm = ["view", "add", "edit", "delete", "authorize"];
    if (!allowedPerm.includes(permission_type)) {
      return res.status(400).json({ success: false, message: "Invalid permission_type" });
    }
    const created_by = req.user.id;

    const module = await findModule({ id: module_id });
    if (!module) return res.status(404).json({ success: false, message: "Module not found" });

    const user = await findUser({ id: created_by });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const dup = await findModuleSopByModulePermission(module_id, permission_type);
    if (dup) {
      return res.status(400).json({ success: false, message: "An SOP already exists for this module and permission" });
    }

    const row = await insertModuleSop({
      module_id,
      permission_type,
      description,
      is_required,
      created_by,
    });

    await logActivity(req, {
      action: "create",
      entity: "module_sops",
      entity_id: row.id,
      details: { module_id, permission_type, is_required: row.is_required },
    });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateModuleSopController = async (req, res) => {
  try {
    const { id, description, is_required } = req.body;
    const fields = { updated_by: req.user.id, updated_at: new Date() };
    if (description !== undefined) fields.description = description;
    if (is_required !== undefined) fields.is_required = !!is_required;

    const row = await updateModuleSop(fields, { id });
    if (!row) return res.status(404).json({ success: false, message: "SOP not found" });

    await logActivity(req, {
      action: "update",
      entity: "module_sops",
      entity_id: id,
      details: {
        description: description !== undefined,
        is_required: is_required !== undefined,
      },
    });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteModuleSopController = async (req, res) => {
  try {
    const { id } = req.body;
    await deleteModuleSop({ id }, { deleted_by: req.user.id });
    await logActivity(req, { action: "delete", entity: "module_sops", entity_id: id });
    res.json({ success: true, message: "SOP deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Resolve SOP for a module + permission (for forms / training UI). */
export const getModuleSopHelper = async (req, res) => {
  try {
    const { module_id, permission_type, module_slug } = req.body || {};

    let modId = module_id;
    if (!modId && module_slug) {
      const m = await findModule({ name: module_slug });
      if (!m) return res.status(404).json({ success: false, message: "Module not found" });
      modId = m.id;
    }

    if (modId == null || !permission_type) {
      return res.status(400).json({ success: false, message: "module_id (or module_slug) and permission_type are required" });
    }

    const row = await findModuleSopByModulePermission(modId, permission_type);
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
