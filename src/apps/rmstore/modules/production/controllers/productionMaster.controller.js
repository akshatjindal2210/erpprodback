import { findProductions, findProduction, findProductionDuplicate, insertProduction, updateProductions, deleteProductions } from "../models/productionMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { resolveProductionSnapshot } from "../utils/erpItems.js";

const CFG = getCrudModuleConfig("rm_production_master");
const MODULE = "rm_production_master";

function uniqueViolationMessage(err) {
  const constraint = err?.constraint || "";
  if (constraint === "rmstore_master_production_pkey") {
    return "Could not save production mapping: database ID is out of sync. Restart the backend and try again.";
  }
  if (constraint === "rmstore_master_production_item_rm_unique_active") {
    return "A mapping for this production item and RM item already exists.";
  }
  if (err?.code === "23505") {
    return "Could not save because a duplicate production mapping exists.";
  }
  return err?.message || "Could not save production mapping.";
}

const log = (req, action, entity_id, details, record = null) =>
  logRmstoreActivity(req, {
    action,
    entity: MODULE,
    entity_id,
    details,
    record,
  }).catch(() => {});

function parsePositiveDcode(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `${label} is required.` };
  }
  return { value: n };
}

export const getProductions = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "production_id",
      order: "DESC",
    });

    // Codes/desc live on the row — no ERP round-trip on list.
    const result = await findProductions({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG.listFields,
      permission: req.permission,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getProductionById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.production_id ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid production mapping ID is required." });
    }

    const data = await findProduction({ production_id: id });
    if (!data) {
      return res.status(404).json({ success: false, message: "Production mapping not found." });
    }

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createProduction = async (req, res) => {
  try {
    const { item_dcode, rm_item_dcode, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    const prod = parsePositiveDcode(item_dcode, "Production item");
    if (prod.error) return res.status(400).json({ success: false, message: prod.error });

    const rm = parsePositiveDcode(rm_item_dcode, "RM item");
    if (rm.error) return res.status(400).json({ success: false, message: rm.error });

    const duplicate = await findProductionDuplicate({
      item_dcode: prod.value,
      rm_item_dcode: rm.value,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A mapping for this production item and RM item already exists.",
      });
    }

    const snapshot = await resolveProductionSnapshot(prod.value, rm.value);

    const row = await insertProduction({
      item_dcode: snapshot.item_dcode ?? prod.value,
      item_code: snapshot.item_code,
      item_desc: snapshot.item_desc,
      rm_item_dcode: snapshot.rm_item_dcode ?? rm.value,
      rm_item_code: snapshot.rm_item_code,
      rm_item_desc: snapshot.rm_item_desc,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false,
        auditAsName: true,
      });
      await updateProductions(approvalFields, { production_id: row.production_id });
    }

    const data = await findProduction({ production_id: row.production_id });

    await log(req, "create", row.production_id, {
      item_dcode: prod.value,
      rm_item_dcode: rm.value,
    }, row);

    return res.status(201).json({
      success: true,
      data: data ?? row,
      message: "Production mapping created successfully.",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err) });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateProduction = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.production_id ?? req.body?.id);
    const { item_dcode, rm_item_dcode, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!id) {
      return res.status(400).json({ success: false, message: "A valid production mapping ID is required." });
    }

    const existing = await findProduction({ production_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Production mapping not found." });
    }

    // Edit-day window only when the user has edit permission (not authorize-only).
    const editDaysLimit = Number(req.permission?.can_edit_days) || 0;
    if (req.user.type !== "super_admin" && !!req.permission?.can_edit && editDaysLimit > 0) {
      const createdAt = new Date(existing.created_at);
      const diffDays = Math.ceil(Math.abs(Date.now() - createdAt) / (1000 * 60 * 60 * 24));
      if (diffDays > editDaysLimit) {
        return res.status(403).json({
          success: false,
          message: `Edit time limit exceeded. You can only edit records from the last ${editDaysLimit} days.`,
        });
      }
    }

    const hasBusinessChanges = item_dcode !== undefined || rm_item_dcode !== undefined;

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    let nextItem = Number(existing.item_dcode);
    let nextRm = Number(existing.rm_item_dcode);

    if (item_dcode !== undefined) {
      const parsed = parsePositiveDcode(item_dcode, "Production item");
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      nextItem = parsed.value;
    }
    if (rm_item_dcode !== undefined) {
      const parsed = parsePositiveDcode(rm_item_dcode, "RM item");
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      nextRm = parsed.value;
    }

    if (hasBusinessChanges) {
      const duplicate = await findProductionDuplicate({
        item_dcode: nextItem,
        rm_item_dcode: nextRm,
        excludeProductionId: id,
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: "A mapping for this production item and RM item already exists.",
        });
      }
    }

    const fields = {
      ...(item_dcode !== undefined && { item_dcode: nextItem }),
      ...(rm_item_dcode !== undefined && { rm_item_dcode: nextRm }),
      updated_by: auditUserName(req),
      updated_at: new Date(),
    };

    if (hasBusinessChanges) {
      const snapshot = await resolveProductionSnapshot(nextItem, nextRm);
      fields.item_dcode = snapshot.item_dcode ?? nextItem;
      fields.item_code = snapshot.item_code;
      fields.item_desc = snapshot.item_desc;
      fields.rm_item_dcode = snapshot.rm_item_dcode ?? nextRm;
      fields.rm_item_code = snapshot.rm_item_code;
      fields.rm_item_desc = snapshot.rm_item_desc;
    }

    applyApprovalWorkflow({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges,
      auditAsName: true,
    });

    await updateProductions(fields, { production_id: id });
    await log(req, "update", id, { updated_fields: fields });

    const data = await findProduction({ production_id: id });

    return res.json({
      success: true,
      data,
      message: "Production mapping updated successfully.",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err) });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteProduction = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.production_id ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid production mapping ID is required." });
    }

    const existing = await findProduction({ production_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Production mapping not found." });
    }

    await deleteProductions({ production_id: id }, { deleted_by: auditUserName(req) });
    await log(req, "delete", id, {
      item_dcode: existing.item_dcode,
      rm_item_dcode: existing.rm_item_dcode,
    }, existing);

    return res.json({ success: true, message: "Production mapping deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
