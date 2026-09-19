import { findSpecItems, findSpecItemDetail, syncItemSpecs, deleteSpecsByItem, setItemApproval, findSpecHeaderValues } from "../models/specMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { loadMappedItems } from "../../production/utils/erpItems.js";
import { normalizeItemSpecsPayload } from "../utils/specPayload.js";

const CFG = getCrudModuleConfig("rm_spec_master");
const MODULE = "rm_spec_master";

const log = (req, action, entity_id, details, record = null) =>
  logRmstoreActivity(req, { action, entity: MODULE, entity_id, details, record }).catch(() => {});

const specUpper = (v) => {
  const s = v != null ? String(v).trim() : "";
  return s ? s.toUpperCase() : null;
};

const specLineKey = (line = {}) =>
  JSON.stringify({
    sno: Number(line.sno),
    type: specUpper(line.type || "RM"),
    spec_name: specUpper(line.spec_name),
    remarks: specUpper(line.remarks),
    print_val: specUpper(line.print_val),
    inspection_method: specUpper(line.inspection_method),
    spec_type: String(line.spec_type || "min").toLowerCase(),
    min_value: Number(line.min_value ?? 0),
    max_value: Number(line.max_value ?? 0),
    correct_option: String(line.correct_option || "")
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join(","),
    incorrect_option: String(line.incorrect_option || "")
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join(","),
    document_required: Boolean(line.document_required),
  });

function hasSpecBusinessChanges(existingDetail, normalized, itemChanged) {
  if (itemChanged) return true;
  if (
    specUpper(existingDetail?.condition) !== specUpper(normalized.condition) ||
    specUpper(existingDetail?.grade) !== specUpper(normalized.grade) ||
    specUpper(existingDetail?.size) !== specUpper(normalized.size) ||
    specUpper(existingDetail?.condition_color) !== specUpper(normalized.condition_color) ||
    specUpper(existingDetail?.grade_color) !== specUpper(normalized.grade_color)
  ) {
    return true;
  }
  const existingSpecs = existingDetail?.specs || [];
  const nextSpecs = normalized.specs || [];
  if (existingSpecs.length !== nextSpecs.length) return true;
  const byId = new Map(existingSpecs.filter((l) => l?.spec_id != null).map((l) => [Number(l.spec_id), l]));
  for (const next of nextSpecs) {
    const prev = next?.spec_id != null ? byId.get(Number(next.spec_id)) : existingSpecs.find((l) => Number(l.sno) === Number(next.sno));
    if (!prev || specLineKey(prev) !== specLineKey(next)) return true;
  }
  return false;
}

async function resolveRmItemSnapshot(item_dcode) {
  const rows = await loadMappedItems("item", { type: "rm" });
  const raw = rows.find((r) => String(r.itemdcode) === String(item_dcode));
  if (!raw) return { item_code: null, item_desc: null };
  return {
    item_code: raw.item_code ?? null,
    item_desc: raw.itemdesc ?? null,
  };
}

async function applySpecApprovalOnly(req, res, itemDcode, existingDetail, incomingApproved) {
  const approvalFields = {};
  applyApprovalWorkflow({
    req,
    fields: approvalFields,
    incomingApproved,
    hasBusinessChanges: false,
    alreadyApproved: existingDetail?.approved === true || existingDetail?.approval_status === "authorized",
    auditAsName: true,
  });
  await setItemApproval(itemDcode, approvalFields);
  await log(req, approvalFields.approved ? "authorize" : "update", itemDcode, {
    approval_only: true,
    approved: approvalFields.approved,
  });
  const data = await findSpecItemDetail(itemDcode);
  return res.json({
    success: true,
    data,
    toast_type: "success",
    message: approvalFields.approved
      ? "All specification lines authorized."
      : "All specification lines set to pending.",
  });
}

/** List: one row per RM item (aggregated specs + approval mix). */
export const getSpecs = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "item_code",
      order: "ASC",
    });
    const result = await findSpecItems({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Get all spec lines for an RM item. */
export const getSpecById = async (req, res) => {
  try {
    const itemDcode = parsePositiveIntId(req.body?.item_dcode);
    if (!itemDcode) {
      return res.status(400).json({ success: false, message: "A valid RM item code is required." });
    }
    const data = await findSpecItemDetail(itemDcode);
    if (!data) return res.status(404).json({ success: false, message: "RM spec record not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Create all spec lines for a new RM item (all share one approval state). */
export const createSpec = async (req, res) => {
  try {
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const normalized = normalizeItemSpecsPayload(req.body || {});
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error });
    }

    const existing = await findSpecItemDetail(normalized.item_dcode);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Specifications already exist for this RM item. Use Edit to change them.",
      });
    }

    const itemSnap = await resolveRmItemSnapshot(normalized.item_dcode);
    const approvalFields = {};
    applyApprovalWorkflow({
      req,
      fields: approvalFields,
      incomingApproved: normalizedApproved === true ? true : false,
      hasBusinessChanges: false,
      alreadyApproved: false,
      auditAsName: true,
    });
    const approval = {
      approved: approvalFields.approved === true,
      approved_by: approvalFields.approved_by ?? null,
      approved_at: approvalFields.approved_at ?? null,
    };

    const rows = await syncItemSpecs({
      item_dcode: normalized.item_dcode,
      item_code: itemSnap.item_code,
      item_desc: itemSnap.item_desc,
      specs: normalized.specs,
      userName: auditUserName(req),
      approval,
    });

    const data = await findSpecItemDetail(normalized.item_dcode);
    await log(
      req,
      "create",
      normalized.item_dcode,
      { item_dcode: normalized.item_dcode, spec_count: rows.length, approved: approval.approved === true },
      data
    );
    if (approval.approved) {
      await log(req, "authorize", normalized.item_dcode, {
        approval_only: true,
        approved: true,
        with_create: true,
      });
    }
    return res.status(201).json({
      success: true,
      data,
      toast_type: "success",
      message: approval.approved
        ? "RM spec created and authorized."
        : "RM spec created. Pending authorization.",
    });
  } catch (err) {
    console.error("[rmstore/spec/create]", err?.message || err);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: specUniqueViolationMessage(err),
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

function specUniqueViolationMessage(err) {
  const constraint = String(err?.constraint || err?.detail || "").toLowerCase();
  if (constraint.includes("dcode")) {
    return "Specifications already exist for this RM item. Use Edit to change them.";
  }
  if (constraint.includes("sno")) {
    return "This serial number is already used for this RM item.";
  }
  return "Could not save this RM specification because it conflicts with an existing record.";
}

/**
 * Update:
 * - specs[] + approved true → rewrite lines and authorize all together
 * - specs[] without approve → rewrite lines and reset all to pending
 * - approved only → authorize / unauthorize ALL lines together
 */
export const updateSpec = async (req, res) => {
  try {
    const targetItemDcode = parsePositiveIntId(req.body?.item_dcode);
    const sourceItemDcode =
      parsePositiveIntId(req.body?.source_item_dcode) || targetItemDcode;
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    if (!targetItemDcode) {
      return res.status(400).json({ success: false, message: "A valid RM item code is required." });
    }

    const existingDetail = await findSpecItemDetail(sourceItemDcode);
    if (!existingDetail) {
      return res.status(404).json({ success: false, message: "RM spec record not found." });
    }

    const itemChanged = sourceItemDcode !== targetItemDcode;
    if (itemChanged) {
      const targetExisting = await findSpecItemDetail(targetItemDcode);
      if (targetExisting) {
        return res.status(409).json({
          success: false,
          message: "Specifications already exist for this RM item. Choose another item, or edit the existing record.",
        });
      }
    }

    const earliest = existingDetail.specs.reduce(
      (min, s) => (!min || (s.created_at && s.created_at < min) ? s.created_at : min),
      null
    );
    const editDaysLimit = Number(req.permission?.can_edit_days) || 0;
    if (req.user.type !== "super_admin" && !!req.permission?.can_edit && editDaysLimit > 0 && earliest) {
      const diffDays = Math.ceil(Math.abs(Date.now() - new Date(earliest)) / 86400000);
      if (diffDays > editDaysLimit) {
        return res.status(403).json({
          success: false,
          message: `Edit time limit exceeded. You can only edit records from the last ${editDaysLimit} days.`,
        });
      }
    }

    const hasSpecsBody = Array.isArray(req.body?.specs);
    if (!hasSpecsBody && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    if (!hasSpecsBody) {
      if (itemChanged) {
        return res.status(400).json({
          success: false,
          message: "To change the RM item, save the record together with its specification lines.",
        });
      }
      return applySpecApprovalOnly(req, res, sourceItemDcode, existingDetail, normalizedApproved);
    }

    const normalized = normalizeItemSpecsPayload({
      item_dcode: targetItemDcode,
      specs: req.body.specs,
      condition: req.body.condition,
      grade: req.body.grade,
      size: req.body.size,
      condition_color: req.body.condition_color,
      grade_color: req.body.grade_color,
    });
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error });
    }

    const hasBusinessChanges = hasSpecBusinessChanges(existingDetail, normalized, itemChanged);

    if (!hasBusinessChanges) {
      if (normalizedApproved === undefined) {
        return res.status(400).json({ success: false, message: "There are no fields to update." });
      }
      return applySpecApprovalOnly(req, res, sourceItemDcode, existingDetail, normalizedApproved);
    }

    const itemSnap = await resolveRmItemSnapshot(targetItemDcode);
    const approvalFields = {};
    if (normalizedApproved === true) {
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: true,
        alreadyApproved: existingDetail?.approved === true || existingDetail?.approval_status === "authorized",
        auditAsName: true,
      });
    }
    const approval = {
      approved: approvalFields.approved === true,
      approved_by: approvalFields.approved_by ?? null,
      approved_at: approvalFields.approved_at ?? null,
    };

    await syncItemSpecs({
      item_dcode: targetItemDcode,
      source_item_dcode: sourceItemDcode,
      item_code: itemSnap.item_code ?? existingDetail.item_code,
      item_desc: itemSnap.item_desc ?? existingDetail.item_desc,
      specs: normalized.specs,
      userName: auditUserName(req),
      approval,
    });

    await log(req, "update", targetItemDcode, {
      item_dcode: targetItemDcode,
      source_item_dcode: sourceItemDcode,
      item_changed: itemChanged,
      spec_count: normalized.specs.length,
      approved: approval.approved === true,
    });
    if (approval.approved) {
      await log(req, "authorize", targetItemDcode, {
        approval_only: false,
        approved: true,
        with_update: true,
      });
    }
    const data = await findSpecItemDetail(targetItemDcode);
    return res.json({
      success: true,
      data,
      toast_type: "success",
      message: approval.approved
        ? "RM spec updated and authorized."
        : "RM spec updated. Pending re-authorization.",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: specUniqueViolationMessage(err),
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/** Permanently delete the spec master and all of its lines. */
export const deleteSpec = async (req, res) => {
  try {
    const itemDcode = parsePositiveIntId(req.body?.item_dcode ?? req.body?.id);
    if (!itemDcode) {
      return res.status(400).json({ success: false, message: "A valid RM item code is required." });
    }
    const existing = await findSpecItemDetail(itemDcode);
    if (!existing) return res.status(404).json({ success: false, message: "RM spec record not found." });

    await deleteSpecsByItem(itemDcode);
    await log(
      req,
      "delete",
      itemDcode,
      { item_dcode: itemDcode, spec_count: existing.spec_count },
      existing
    );
    return res.json({ success: true, message: "RM spec deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Distinct condition / grade / size values for typeable suggest fields. */
export const getSpecHeaderValuesViews = async (req, res) => {
  try {
    const field = String(req.body?.field ?? "").trim().toLowerCase();
    if (!["condition", "grade", "size", "condition_color", "grade_color"].includes(field)) {
      return res.status(400).json({
        success: false,
        message: "Field must be condition, grade, size, condition_color, or grade_color.",
      });
    }
    const rows = await findSpecHeaderValues({field, search: sanitizeSearch(req.body?.search)});
    return res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
