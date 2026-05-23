import { findCategories, findCategory } from "../models/category.model.js";
import { sanitizeSearch } from "../utils/helper.js";
import { resolveCategoryViewsSelectFields } from "../config/view-fields/category.js";
import { extractListParams } from "../utils/queryHelper.js";

// ─── GET LIST ─────────────────────────────
export const getCategories = async (req, res) => {
  try {
    const { page = 1, limit = 10, filters = {}, sortBy = "id", order = "ASC", search } = req.body;

    const result = await findCategories({
      filters,
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

// ─── GET BY ID ────────────────────────────
export const getCategoryById = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id)
      return res.status(400).json({ success: false, message: "ID required" });

    const data = await findCategory({ id });

    if (!data)
      return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data: { ...data, id: data.id } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET Views (Helper API for other modules) ──────────────────
export const getCategoriesViews = async (req, res) => {
  try {
    const { id, permission_module, permission_action } = req.body;
    const { page, limit, sortBy, order, search } = extractListParams(req.body, { sortBy: "name", order: "DESC" });

    if (id) {
      const data = await findCategory({ id });
      if (!data) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { id: data.id, name: data.name } });
    }

    const fields = resolveCategoryViewsSelectFields({ permission_module, permission_action });
    if (fields == null) {
      return res.status(400).json({
        success: false,
        message: "Invalid permission_module / permission_action for category views"
      });
    }

    const result = await findCategories({
      filters: {},
      search: sanitizeSearch(search),
      sort: { by: sortBy || "name", order: order || "DESC" },
      page: page || 1,
      limit: limit || 5000,
      fields: fields || ["id", "name"],
    });
    
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};