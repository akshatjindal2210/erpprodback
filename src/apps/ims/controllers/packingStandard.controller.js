import { findPackingStandards, findPackingStandard, findPackingStandardDuplicate, insertPackingStandard, updatePackingStandards, deletePackingStandards } from "../models/packingStandard.model.js";

import { logActivity } from "../../core/utils/logActivity.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { resolveViewsFields } from "../config/helperViews.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../../core/utils/approval.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { enrichRowsWithIMS } from "../utils/erp-api/imsLookup.js";

const CFG = getCrudModuleConfig("packing_standard");

async function enrichPackingRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    itemCodeField: "item_dcode",
    accCodeField: "acc_code",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
    accNameOut: "acc_name"
  });
}
  
export const getPackingStandards = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "standard_id", order: "DESC" });

    const result = await findPackingStandards({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG.listFields,
      permission: req.permission
    });

    const enrichedRows = await enrichPackingRows(result.data || []);
    res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    res.status(500).json({success: false, message: err.message });
  }
};

export const getPackingStandardById = async (req, res) => {
  try {
    const { standard_id } = req.body;

    if (!standard_id) {
      return res.status(400).json({ success: false, message: "ID required" });
    }

    const data = await findPackingStandard({ standard_id });

    if (!data) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const [enriched] = await enrichPackingRows([data]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPackingStandard = async (req, res) => {
  try {
    let { item_dcode, qty, unit, type, sticker_type, acc_code, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    item_dcode = item_dcode?.toString().trim();
    unit = unit?.toString().trim();

    if (!item_dcode) {
      return res.status(400).json({ success: false, message: "item_dcode required" });
    }

    if (!type) {
      return res.status(400).json({ success: false, message: "type required" });
    }

    if (qty !== undefined && Number.isNaN(Number(qty))) {
      return res.status(400).json({ success: false, message: "qty must be a valid number" });
    }

    const duplicate = await findPackingStandardDuplicate({ item_dcode, type, acc_code: acc_code ?? null });

    if (duplicate) {
      return res.status(409).json({ success: false, message: "Record already exists" });
    }

    const row = await insertPackingStandard({
      item_dcode,
      qty,
      unit,
      type,
      sticker_type,
      acc_code: acc_code ?? null,
      created_by: req.user.id
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false
      });
      await updatePackingStandards(approvalFields, { standard_id: row.standard_id });
    }

    const data = await findPackingStandard({ standard_id: row.standard_id });
    const [enriched] = await enrichPackingRows(data ? [data] : []);

    await logActivity(req, { action: "create", entity: "packing_standard", entity_id: row.standard_id, record: row });

    res.status(201).json({ success: true, data: enriched ?? data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePackingStandard = async (req, res) => {
  try {
    let { standard_id, item_dcode, qty, unit, type, sticker_type, acc_code, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!standard_id) {
      return res.status(400).json({ success: false, message: "ID required" });
    }

    const existing = await findPackingStandard({ standard_id });

    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    // Edit-day window applies only when the user has edit permission (not authorize-only updates).
    const editDaysLimit = Number(req.permission?.can_edit_days) || 0;
    if (req.user.type !== "super_admin" && !!req.permission?.can_edit && editDaysLimit > 0) {
      const createdAt = new Date(existing.created_at);
      const now = new Date();
      const diffTime = Math.abs(now - createdAt);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays > editDaysLimit) {
        return res.status(403).json({
          success: false,
          message: `Edit time limit exceeded. You can only edit records from the last ${editDaysLimit} days.`
        });
      }
    }

    item_dcode = item_dcode?.toString().trim();
    unit = unit?.toString().trim();

    const hasChanges =
      item_dcode !== undefined ||
      qty !== undefined ||
      unit !== undefined ||
      type !== undefined ||
      sticker_type !== undefined ||
      acc_code !== undefined;

    if (!hasChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    /* ── DUPLICATE CHECK SAFE ── */
    if (hasChanges) {
      const duplicate = await findPackingStandardDuplicate({
        item_dcode: item_dcode ?? existing.item_dcode,
        type: type ?? existing.type,
        acc_code: acc_code ?? existing.acc_code
      });

      if (duplicate && Number(duplicate.standard_id) !== Number(standard_id)) {
        return res.status(409).json({ success: false, message: "Duplicate record exists" });
      }
    }

    const fields = {
      ...(item_dcode !== undefined && { item_dcode }),
      ...(qty !== undefined && { qty }),
      ...(unit !== undefined && { unit }),
      ...(type !== undefined && { type }),
      ...(sticker_type !== undefined && { sticker_type }),
      ...(acc_code !== undefined && { acc_code }),
      updated_by: req.user.id,
      updated_at: new Date()
    };

    applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges: hasChanges });

    await updatePackingStandards(fields, { standard_id });

    const data = await findPackingStandard({ standard_id });
    const [enriched] = await enrichPackingRows(data ? [data] : []);

    await logActivity(req, { action: "update", entity: "packing_standard", entity_id: standard_id, details: { updated_fields: fields } });

    res.json({ success: true, message: "Packing standard updated", data: enriched ?? data });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
};

export const deletePackingStandard = async (req, res) => {
  try {
    const { standard_id } = req.body;

    if (!standard_id) {
      return res.status(400).json({ success: false, message: "ID required"});
    }

    const existing = await findPackingStandard({ standard_id });

    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deletePackingStandards(
      { standard_id },
      { deleted_by: req.user.id }
    );

    await logActivity(req, { action: "delete", entity: "packing_standard", entity_id: standard_id, record: existing });

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPackingStandardsViews = async (req, res) => {
  try {
    const { id, permission_module, permission_action } = req.body;
    const { search } = req.body || {};

    if (id) {
      const data = await findPackingStandard({ standard_id: id });
      if (!data || data.is_deleted || !data.approved) return res.json({ success: true, data: null });
      const [enriched] = await enrichPackingRows([data]);
      return res.json({
        success: true,
        data: {
          standard_id: enriched.standard_id,
          item_dcode: enriched.item_dcode,
          qty: enriched.qty,
          unit: enriched.unit,
          type: enriched.type,
          sticker_type: enriched.sticker_type,
          item_code: enriched.item_code,
          item_desc: enriched.item_desc,
          acc_name: enriched.acc_name
        }
      });
    }

    const fields = resolveViewsFields("packingStandard", { permission_module, permission_action });

    const result = await findPackingStandards({
      filters: { approved: true },
      search: sanitizeSearch(search),
      sort: { by: "created_at", order: "DESC" },
      page: 1,
      limit: 5000,
      fields: fields || ["standard_id", "item_dcode", "qty", "unit", "type", "sticker_type"]
    });
    const enrichedRows = await enrichPackingRows(result.data || []);
    res.json({ success: true, data: enrichedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
