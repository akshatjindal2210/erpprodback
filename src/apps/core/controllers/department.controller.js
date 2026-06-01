import { findDepartments, findDepartment, insertDepartment, updateDepartment, deleteDepartment } from "../models/department.model.js";
import { extractListParams } from "../utils/queryHelper.js";
import { sanitizeSearch } from "../utils/helper.js";

export const getDepartments = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "id", order: "ASC" });
    
    const result = await findDepartments({
      filters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit
    });
    
    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getDepartmentById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const department = await findDepartment({ id });
    if (!department) return res.status(404).json({ success: false, message: "Department not found" });

    res.json({ success: true, data: department });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createDepartment = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Name required" });

    const department = await insertDepartment({ name });

    res.status(201).json({ success: true, data: department, message: "Department created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateDepartmentData = async (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const fields = { name, updated_at: new Date() };
    const rows = await updateDepartment(fields, { id });

    if (!rows.length) return res.status(404).json({ success: false, message: "Department not found" });

    res.json({ success: true, data: rows[0], message: "Department updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteDepartmentData = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const rows = await deleteDepartment({ id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Department not found" });

    res.json({ success: true, message: "Department deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getDepartmentsHelper = async (req, res) => {
  try {
    const { search } = req.body || {};
    const result = await findDepartments({
      search: sanitizeSearch(search),
      page: 1,
      limit: 5000,
      fields: ["id", "name"]
    });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
