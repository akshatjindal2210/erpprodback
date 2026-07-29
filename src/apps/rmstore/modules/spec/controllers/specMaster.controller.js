import { findSpecItems, findSpecItemDetail, findSpecsByItem, syncItemSpecs, deleteSpecsByItem, setItemApproval } from "../models/specMaster.model.js";
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

async function resolveRmItemSnapshot(item_dcode) {
  const rows = await loadMappedItems("item", { type: "rm" });
  const raw = rows.find((r) => String(r.itemdcode) === String(item_dcode));
  if (!raw) return { item_code: null, item_desc: null };
  return {
    item_code: raw.item_code ?? null,
    item_desc: raw.itemdesc ?? null,
  };
}

function buildApprovalState(req, incomingApproved, hasBusinessChanges) {
  const fields = {};
  applyApprovalWorkflow({
    req,
    fields,
    incomingApproved,
    hasBusinessChanges,
    auditAsName: true,
  });
  return {
    approved: fields.approved === true,
    approved_by: fields.approved_by ?? null,
    approved_at: fields.approved_at ?? null,
  };
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

    const existing = await findSpecsByItem(normalized.item_dcode);
    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: "Specifications already exist for this RM item. Use Edit to change them.",
      });
    }

    const itemSnap = await resolveRmItemSnapshot(normalized.item_dcode);
    const approval = buildApprovalState(req, normalizedApproved === true ? true : false, false);

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
      { item_dcode: normalized.item_dcode, spec_count: rows.length },
      data
    );
    return res.status(201).json({
      success: true,
      data,
      message: "RM spec created successfully.",
    });
  } catch (err) {
    console.error("[rmstore/spec/create]", err?.message || err);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This serial number is already used for this RM item.",
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

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
      const targetExisting = await findSpecsByItem(targetItemDcode);
      if (targetExisting.length) {
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

    // Approve / keep-pending — all lines together (RM item change requires specs body)
    if (!hasSpecsBody) {
      if (itemChanged) {
        return res.status(400).json({
          success: false,
          message: "To change the RM item, save the record together with its specification lines.",
        });
      }
      const approvalFields = {
        updated_by: auditUserName(req),
        updated_at: new Date(),
      };
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: false,
        auditAsName: true,
      });
      await setItemApproval(sourceItemDcode, approvalFields);
      await log(req, "update", sourceItemDcode, { approval_only: true, approved: approvalFields.approved });
      const data = await findSpecItemDetail(sourceItemDcode);
      return res.json({
        success: true,
        data,
        message: approvalFields.approved
          ? "All specification lines authorized successfully."
          : "All specification lines set to pending.",
      });
    }

    const normalized = normalizeItemSpecsPayload({
      item_dcode: targetItemDcode,
      specs: req.body.specs,
      condition: req.body.condition,
      grade: req.body.grade,
      size: req.body.size,
    });
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error });
    }

    const itemSnap = await resolveRmItemSnapshot(targetItemDcode);
    // Approve with edits → authorize; plain edit → pending re-approval
    const approveWithSpecs = normalizedApproved === true;
    const approval = approveWithSpecs
      ? buildApprovalState(req, true, false)
      : { approved: false, approved_by: null, approved_at: null };

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
    const data = await findSpecItemDetail(targetItemDcode);
    return res.json({
      success: true,
      data,
      message: approval.approved
        ? "RM spec updated and all lines authorized."
        : "RM spec updated. All lines are pending re-approval.",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This serial number is already used for this RM item.",
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/** Soft-delete all lines for an RM item. */
export const deleteSpec = async (req, res) => {
  try {
    const itemDcode = parsePositiveIntId(req.body?.item_dcode ?? req.body?.id);
    if (!itemDcode) {
      return res.status(400).json({ success: false, message: "A valid RM item code is required." });
    }
    const existing = await findSpecItemDetail(itemDcode);
    if (!existing) return res.status(404).json({ success: false, message: "RM spec record not found." });

    await deleteSpecsByItem(itemDcode, { deleted_by: auditUserName(req) });
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
