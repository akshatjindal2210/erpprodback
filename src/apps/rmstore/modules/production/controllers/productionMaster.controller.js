import { findProductions, findProduction, insertProduction, updateProductions, deleteProductions } from "../models/productionMaster.model.js";
import { resolveProductionSnapshot } from "../utils/erpItems.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";

const FILTER_FIELDS = ["production_id", "item_dcode", "approved", "from_date", "to_date"];
const MODULE = "rm_production_master";
const log = createRmstoreActivityLogger(MODULE);

function parseRmItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rmItemsChanged(existingItems, nextItems) {
  const a = parseRmItems(existingItems)
    .map((r) => Number(r?.rm_item_dcode))
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  const b = (nextItems || [])
    .map((r) => Number(r?.rm_item_dcode))
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

export const getProductions = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "production_id",
      order: "DESC",
    });
    const listFilters = sanitizeFilters(filters, FILTER_FIELDS);
    delete listFilters.from_date;
    delete listFilters.to_date;
    const resData = await findProductions({
      filters: listFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });
    return res.json({ success: true, ...resData });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getProductionById = async (req, res) => {
  try {
    const data = await findProduction({ production_id: req.body.production_id || req.body.id });
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, message: "Production mapping not found." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createProduction = async (req, res) => {
  try {
    const { item_dcode, rm_items, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!item_dcode || !Array.isArray(rm_items) || !rm_items.length) {
      return res.status(400).json({ success: false, message: "A production item and at least one RM item are required." });
    }

    const existing = await findProduction({ item_dcode });
    if (existing) return res.status(409).json({ success: false, message: "A mapping already exists for this production item." });

    const snap = await resolveProductionSnapshot(item_dcode, rm_items);
    const fields = { ...snap, created_by: auditUserName(req) };

    if (normalizedApproved !== undefined) {
      applyApprovalWorkflow({
        req,
        fields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: false,
        auditAsName: true,
      });
    }

    const data = await insertProduction(fields);
    const authorized = fields.approved === true;
    log(req, "create", String(data?.production_id || ""), {
      production_id: data?.production_id,
      item_dcode: data?.item_dcode,
      item_code: data?.item_code,
      approved: data?.approved === true,
    }, data);
    return res.status(201).json({
      success: true,
      data,
      toast_type: "success",
      message: authorized
        ? "Item RM mapping created and authorized."
        : "Item RM mapping created. Pending authorization.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateProduction = async (req, res) => {
  try {
    const id = req.body.production_id || req.body.id;
    const { item_dcode, rm_items, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    const existing = await findProduction({ production_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Production mapping not found." });

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const nextItemDcode = item_dcode != null && item_dcode !== "" ? Number(item_dcode) : Number(existing.item_dcode);
    const nextRmItems = Array.isArray(rm_items) ? rm_items : parseRmItems(existing.rm_items);

    if (Number(nextItemDcode) !== Number(existing.item_dcode)) {
      const duplicate = await findProduction({ item_dcode: nextItemDcode });
      if (duplicate && Number(duplicate.production_id) !== Number(id)) {
        return res.status(409).json({ success: false, message: "A mapping already exists for this production item." });
      }
    }

    const hasBusinessChanges = Number(nextItemDcode) !== Number(existing.item_dcode) || rmItemsChanged(existing.rm_items, nextRmItems);

    const fields = hasBusinessChanges ? { ...(await resolveProductionSnapshot(nextItemDcode, nextRmItems)) } : {};

    applyApprovalUpdateFields({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
    });

    if (!Object.keys(fields).length) {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    const data = await updateProductions(fields, id);
    const authorized = fields.approved === true;
    log(req, "update", String(id), hasBusinessChanges
        ? {
            production_id: id,
            approved: data?.approved === true,
            old_values: {
              item_dcode: existing?.item_dcode ?? null,
              approved: existing?.approved === true,
            },
            new_values: {
              item_dcode: data?.item_dcode ?? null,
              approved: data?.approved === true,
            },
          }
        : { production_id: id, approval_only: true, approved: data?.approved === true },
      data
    );
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: authorized
        ? "Item RM mapping updated and authorized."
        : hasBusinessChanges
          ? "Item RM mapping updated. Pending re-authorization."
          : "Item RM mapping set to pending.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteProduction = async (req, res) => {
  try {
    const id = req.body.production_id || req.body.id;
    const existing = await findProduction({ production_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Production mapping not found." });
    await deleteProductions(id, auditUserName(req));
    log(req, "delete", String(id), {
      production_id: id,
      item_dcode: existing?.item_dcode ?? null,
      item_code: existing?.item_code ?? null,
    }, existing);
    return res.json({ success: true, message: "Production mapping deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
