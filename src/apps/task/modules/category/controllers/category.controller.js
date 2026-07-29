import Category from "../models/category.model.js";
import { assertWithinEditDays, isSuperAdminReq } from "../../../../core/lib/utils/auth/permissionDays.js";
import { paramsFromReq, idFromReq, listLimit } from "../../../lib/shared/postRequest.js";
import { resolveCategoryHelperFields } from "../../../lib/config/views/helperViews.js";

function permissionViewDays(req) {
  if (isSuperAdminReq(req)) return 0;
  return Number(req.permission?.can_view_days) || 0;
}

export async function getCategories(req, res) {
  try {
    const {
      search = "",
      page = 1,
      limit = 1000,
      sortBy = "id",
      order = "ASC",
      dateFrom,
      dateTo,
    } = paramsFromReq(req);
    const viewDays = permissionViewDays(req);
    const pageNum = Number(page) || 1;
    const lim = listLimit(limit, 1000, 5000);

    const [task_categories, total] = await Promise.all([
      Category.getAll({
        search,
        page: pageNum,
        limit: lim,
        sortBy,
        order,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        viewDays,
      }),
      Category.count({
        search,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        viewDays,
      }),
    ]);

    res.json({
      success: true,
      message: "Categories fetched successfully",
      data: {
        page: pageNum,
        limit: lim,
        total,
        totalPages: Math.ceil(total / lim) || 1,
        data: task_categories,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

/** IMS-style helper — dropdown options for allowed pages only. */
export async function getCategoriesViews(req, res) {
  try {
    const {
      id,
      permission_module,
      permission_action,
      search = "",
      page = 1,
      limit = 5000,
      sortBy = "name",
      order = "ASC",
    } = paramsFromReq(req);

    if (id) {
      const rows = await Category.getById(id);
      const row = rows?.[0];
      if (!row) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { id: row.id, name: row.name } });
    }

    const fields = resolveCategoryHelperFields({ permission_module, permission_action });
    if (fields == null) {
      return res.status(403).json({
        success: false,
        message: "This helper is not allowed from this page",
      });
    }

    const pageNum = Number(page) || 1;
    const lim = listLimit(limit, 5000, 5000);

    const [rows, total] = await Promise.all([
      Category.getAll({
        search: String(search || ""),
        page: pageNum,
        limit: lim,
        sortBy: sortBy || "name",
        order: order || "ASC",
        viewDays: 0,
      }),
      Category.count({
        search: String(search || ""),
        viewDays: 0,
      }),
    ]);

    const data = (Array.isArray(rows) ? rows : []).map((r) => ({
      id: r.id,
      name: r.name,
    }));

    res.json({
      success: true,
      data,
      total,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getCategoryById(req, res) {
  try {
    const id = idFromReq(req, "id", "category_id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid category id" });

    const rows = await Category.getById(id);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    res.json({ success: true, message: "Category fetched successfully", data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function createCategory(req, res) {
  try {
    const { name } = paramsFromReq(req);

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    const result = await Category.create({ name: name.trim() });

    res.status(201).json({
      success: true,
      message: "Category created successfully",
      data: { category_id: result.insertId },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateCategory(req, res) {
  try {
    const id = idFromReq(req, "id", "category_id");
    const { name } = paramsFromReq(req);

    if (!id) return res.status(400).json({ success: false, message: "Invalid category id" });
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    const rows = await Category.getById(id);
    const existing = rows?.[0];
    if (!existing) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const blocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (blocked) {
      return res.status(blocked.status).json({ success: false, message: blocked.message });
    }

    const result = await Category.update(id, { name: name.trim() });

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    res.json({ success: true, message: "Category updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function deleteCategory(req, res) {
  try {
    const id = idFromReq(req, "id", "category_id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid category id" });

    const result = await Category.delete(id);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
