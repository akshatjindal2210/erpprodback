import { findAttributes, findAttribute, insertAttribute, updateAttribute, softDeleteAttribute, normalizeAttributeName, ATTRIBUTE_NAME_MAX_LENGTH } from "../models/attribute.model.js";
import { extractListParams } from "../../../lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../lib/utils/helper/helper.js";

const PG_UNIQUE_VIOLATION = "23505";

const validateName = (raw) => {
  const name = normalizeAttributeName(raw);
  if (!name) return { error: "Name required" };
  if (name.length > ATTRIBUTE_NAME_MAX_LENGTH) {
    return { error: `Name must be at most ${ATTRIBUTE_NAME_MAX_LENGTH} characters` };
  }
  return { name };
};

export const getAttributes = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "name", order: "ASC" });

    const result = await findAttributes({
      filters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getAttributeById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const attribute = await findAttribute({ id });
    if (!attribute) return res.status(404).json({ success: false, message: "Attribute not found" });

    res.json({ success: true, data: attribute });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createAttribute = async (req, res) => {
  try {
    const { name, error } = validateName(req.body?.name);
    if (error) return res.status(400).json({ success: false, message: error });

    const attribute = await insertAttribute({ name });
    if (!attribute) return res.status(409).json({ success: false, message: "Attribute already exists" });

    res.status(201).json({ success: true, data: attribute, message: "Attribute created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateAttributeData = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });
    const { name, error } = validateName(req.body?.name);
    if (error) return res.status(400).json({ success: false, message: error });

    const rows = await updateAttribute({ name }, { id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Attribute not found" });

    res.json({ success: true, data: rows[0], message: "Attribute updated successfully" });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ success: false, message: "Attribute already exists" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteAttributeData = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const rows = await softDeleteAttribute({ id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Attribute not found" });

    res.json({ success: true, message: "Attribute deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getAttributesHelper = async (req, res) => {
  try {
    const { search } = req.body || {};
    const result = await findAttributes({
      search: sanitizeSearch(search),
      sort: { by: "name", order: "ASC" },
      page: 1,
      limit: 5000,
      fields: ["id", "name"],
    });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
