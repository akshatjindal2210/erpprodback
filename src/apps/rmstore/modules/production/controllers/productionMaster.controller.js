import { findProductions, findProduction, insertProduction, updateProductions, deleteProductions } from "../models/productionMaster.model.js";
import { resolveProductionSnapshot, enrichProductionMasterRows } from "../utils/erpItems.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";

const FILTER_FIELDS = ["production_id", "item_dcode", "approved", "from_date", "to_date", "has_prime_process", "has_finish_process"];
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

function parsePrimeProcess(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
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
    const data = await enrichProductionMasterRows(resData.data || []);
    return res.json({ success: true, ...resData, data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/**
 * Engineering Prime Process Master list — saved `prime_process` only.
 * Item lookup (`filters.item_dcode`) skips that filter so the modal can load Item RM Master
 * RM wire for items that do not have a prime mapping yet.
 */
export const listPrimeProcesses = async (req, res) => {
  const filters = { ...(req.body?.filters || {}) };
  const lookupByItem = filters.item_dcode != null && filters.item_dcode !== "";
  if (lookupByItem) delete filters.has_prime_process;
  else filters.has_prime_process = true;
  req.body = { ...(req.body || {}), filters };
  return getProductions(req, res);
};

/**
 * Engineering Finish Process Master list — saved `finish_process` only.
 * Item lookup (`filters.item_dcode`) skips that filter for form hydration + RM wire.
 */
export const listFinishProcesses = async (req, res) => {
  const filters = { ...(req.body?.filters || {}) };
  const lookupByItem = filters.item_dcode != null && filters.item_dcode !== "";
  if (lookupByItem) delete filters.has_finish_process;
  else filters.has_finish_process = true;
  req.body = { ...(req.body || {}), filters };
  return getProductions(req, res);
};

export const getProductionById = async (req, res) => {
  try {
    const row = await findProduction({ production_id: req.body.production_id || req.body.id });
    if (!row) return res.status(404).json({ success: false, message: "Production mapping not found." });
    const [data] = await enrichProductionMasterRows([row]);
    return res.json({ success: true, data });
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
      data,
      existing
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

/**
 * Engineering Prime Process Master — write only `prime_process` JSON.
 * No approve / audit / timestamp changes (RM Store owns those).
 */
export const savePrimeProcess = async (req, res) => {
  try {
    const production_id = req.body.production_id || req.body.id || null;
    const item_dcode = req.body.item_dcode != null && req.body.item_dcode !== "" ? Number(req.body.item_dcode) : null;
    const prime_process = parsePrimeProcess(req.body.prime_process);

    if (!prime_process || typeof prime_process !== "object") {
      return res.status(400).json({ success: false, message: "prime_process JSON is required." });
    }
    if (!Array.isArray(prime_process.stages) || !prime_process.stages.length) {
      return res.status(400).json({ success: false, message: "prime_process.stages must be a non-empty array." });
    }

    let existing = null;
    if (production_id) existing = await findProduction({ production_id });
    if (!existing && item_dcode) existing = await findProduction({ item_dcode });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Item RM mapping not found. Create the item in Item RM Master first.",
      });
    }

    const data = await updateProductions({ prime_process }, existing.production_id);
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: existing.prime_process ? "Prime process mapping updated." : "Prime process mapping saved.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/** Clear prime_process JSON only — does not soft-delete the Item RM row. */
export const clearPrimeProcess = async (req, res) => {
  try {
    const id = req.body.production_id || req.body.id;
    const existing = await findProduction({ production_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Production mapping not found." });

    const data = await updateProductions({ prime_process: null }, id);
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: "Prime process mapping cleared.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Engineering Finish Process Master — write only `finish_process` JSON.
 * Same table / lookup as prime; no approve / audit / timestamps.
 */
export const saveFinishProcess = async (req, res) => {
  try {
    const production_id = req.body.production_id || req.body.id || null;
    const item_dcode = req.body.item_dcode != null && req.body.item_dcode !== "" ? Number(req.body.item_dcode) : null;
    const finish_process = parsePrimeProcess(req.body.finish_process);

    if (!finish_process || typeof finish_process !== "object") {
      return res.status(400).json({ success: false, message: "finish_process JSON is required." });
    }
    if (!Array.isArray(finish_process.stages) || !finish_process.stages.length) {
      return res.status(400).json({ success: false, message: "finish_process.stages must be a non-empty array." });
    }

    let existing = null;
    if (production_id) existing = await findProduction({ production_id });
    if (!existing && item_dcode) existing = await findProduction({ item_dcode });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Item RM mapping not found. Create the item in Item RM Master first.",
      });
    }

    const data = await updateProductions({ finish_process }, existing.production_id);
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: existing.finish_process ? "Finish process mapping updated." : "Finish process mapping saved.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const clearFinishProcess = async (req, res) => {
  try {
    const id = req.body.production_id || req.body.id;
    const existing = await findProduction({ production_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Production mapping not found." });

    const data = await updateProductions({ finish_process: null }, id);
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: "Finish process mapping cleared.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
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
