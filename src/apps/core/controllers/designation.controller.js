import { findDesignations, findDesignation, insertDesignation, updateDesignation, deleteDesignation } from "../models/designation.model.js";
import { extractListParams } from "../utils/queryHelper.js";
import { sanitizeSearch } from "../utils/helper.js";

export const getDesignations = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "id", order: "ASC" });
    
    const result = await findDesignations({
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

export const getDesignationById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const designation = await findDesignation({ id });
    if (!designation) return res.status(404).json({ success: false, message: "Designation not found" });

    res.json({ success: true, data: designation });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createDesignation = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Name required" });

    const designation = await insertDesignation({ name });

    res.status(201).json({ success: true, data: designation, message: "Designation created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateDesignationData = async (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const fields = { name, updated_at: new Date() };
    const rows = await updateDesignation(fields, { id });

    if (!rows.length) return res.status(404).json({ success: false, message: "Designation not found" });

    res.json({ success: true, data: rows[0], message: "Designation updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteDesignationData = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const rows = await deleteDesignation({ id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Designation not found" });

    res.json({ success: true, message: "Designation deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getDesignationsHelper = async (req, res) => {
  try {
    const { search } = req.body || {};
    const result = await findDesignations({
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
