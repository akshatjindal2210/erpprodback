import Category from "../models/category.model.js";

// GET /task_categories
export async function getCategories(req, res) {
  try {
    const { search = "", page = 1, limit = 10, sortBy = "id", order = "ASC", dateFrom, dateTo } = req.query;

    const [task_categories, total] = await Promise.all([
      Category.getAll({ search, page, limit, sortBy, order, dateFrom, dateTo }),
      Category.count({ search, dateFrom, dateTo }),
    ]);

    res.json({
      success: true,
      message: "Categories fetched successfully",
      data: {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
        data:       task_categories,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /task_categories/:id
export async function getCategoryById(req, res) {
  try {
    const { id } = req.params;
    const rows = await Category.getById(id);

    if (!rows || rows.length === 0)
      return res.status(404).json({ success: false, message: "Category not found" });

    res.json({ success: true, message: "Category fetched successfully", data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// POST /task_categories
export async function createCategory(req, res) {
  try {
    const { name } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: "Category name is required" });

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

// PUT /task_categories/:id
export async function updateCategory(req, res) {
  try {
    const { id }   = req.params;
    const { name } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: "Category name is required" });

    const result = await Category.update(id, { name: name.trim() });

    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Category not found" });

    res.json({ success: true, message: "Category updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE /task_categories/:id
export async function deleteCategory(req, res) {
  try {
    const { id } = req.params;

    const result = await Category.delete(id);

    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Category not found" });

    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}