import { findPermissions, findUserPermissions, findPermission, findPermissionById, upsertPermission, upsertBulkPermissions, updatePermissionById, deletePermission, deletePermissionById } from "../models/permission.model.js";
import { findUser } from "../models/user.model.js";
import { findModule } from "../models/module.model.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";

const PERM_CFG = getCrudModuleConfig("user_permissions");

// ─── GET all permissions for a user ─────────────────────────────
export const getUserPermissions = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "up.id",
      order: "DESC"
    });
    const appliedFilters = sanitizeFilters(filters, PERM_CFG.filterFields);
    const result = await findPermissions({
      filters: appliedFilters,
      search,
      sort: { by: sortBy, order },
      page,
      limit
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPermissionById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "Permission ID required" });
    const data = await findPermissionById(id);
    if (!data) return res.status(404).json({ success: false, message: "Permission not found" });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── SET single permission ──────────────────────────────────────
export const setPermission = async (req, res) => {
  try {
    const { user_id, module_id, can_view, can_add, can_edit, can_delete } = req.body;

    const user = await findUser({ id: user_id });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const module = await findModule({ id: module_id });
    if (!module) return res.status(404).json({ success: false, message: "Module not found" });

    const permission = await upsertPermission(user_id, module_id, { can_view, can_add, can_edit, can_delete });
    res.json({ success: true, data: permission });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── SET bulk permissions ───────────────────────────────────────
export const setBulkPermissions = async (req, res) => {
  try {
    const { user_id, permissions } = req.body;

    if (!Array.isArray(permissions) || permissions.length === 0)
      return res.status(400).json({ success: false, message: "permissions array required" });

    const user = await findUser({ id: user_id });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const result = await upsertBulkPermissions(user_id, permissions);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── REMOVE single permission ───────────────────────────────────
export const removePermission = async (req, res) => {
  try {
    const { id, user_id, module_id } = req.body;
    if (id) {
      const deleted = await deletePermissionById(id, { deleted_by: req.user?.id });
      if (!deleted) return res.status(404).json({ success: false, message: "Permission not found" });
      return res.json({ success: true, message: "Permission removed" });
    }

    const permission = await findPermission(user_id, module_id);
    if (!permission) return res.status(404).json({ success: false, message: "Permission not found" });

    await deletePermission(user_id, module_id, { deleted_by: req.user?.id });
    res.json({ success: true, message: "Permission removed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePermission = async (req, res) => {
  try {
    const { id, can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "Permission ID required" });

    const updated = await updatePermissionById(
      id,
      { can_view, can_view_days, can_add, can_edit, can_edit_days, can_delete, can_authorize },
      { updated_by: req.user?.id }
    );

    if (!updated) return res.status(404).json({ success: false, message: "Permission not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};