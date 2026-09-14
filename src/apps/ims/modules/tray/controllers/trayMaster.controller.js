import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { createTrayBatch, deleteTrayBatch as deleteTrayBatchRows, deleteTrayById, findTray, findTrayBatches, findTrays, updateTrayApprovalById, updateTrayBatch, updateTrayBatchStatus, updateTrayStatusById, updateTrayStatusByIds } from "../models/trayMaster.model.js";
import { TRAY_TYPES, isValidTrayType, normalizeTrayType } from "../config/trayTypes.js";
import { isValidTrayStatus, normalizeTrayStatus } from "../config/trayStatuses.js";

const CFG = getCrudModuleConfig("tray_master");

const log = (req, action, entity_id, details, record = null) =>
  logActivity(req, {
    action,
    entity: "tray_master",
    entity_id,
    details,
    record,
  }).catch(() => {});

function parseTrayIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((value) => parsePositiveIntId(value)).filter(Boolean))];
}

function parseTrayRemark(body) {
  return String(body?.remark ?? "").trim();
}

export const getTrayTypes = async (_req, res) => {
  return res.json({ success: true, data: TRAY_TYPES });
};

const TRAY_VIEW_FIELDS = ["t.id", "t.code", "t.type", "t.serial_number", "t.batch_id"];

function formatTrayViewRow(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    code: row.code ?? null,
    type: row.type ?? null,
    serial_number: row.serial_number ?? null,
    batch_id: row.batch_id ?? null,
  };
}

export const getTraysViews = async (req, res) => {
  try {
    const { id, code } = req.body;
    const lookupId = parsePositiveIntId(id);
    const lookupCode = code != null && String(code).trim() !== "" ? String(code).trim().toUpperCase() : null;
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "code", order: "ASC" });

    const viewFields =
      resolveViewsFields("trays", {
        permission_module: req.body.permission_module,
        permission_action: req.body.permission_action,
      }) || TRAY_VIEW_FIELDS;

    if (lookupId || lookupCode) {
      const tray = await findTray(
        {
          ...(lookupId ? { id: lookupId } : {}),
          ...(lookupCode ? { code: lookupCode } : {}),
          status: "active",
          approved: true,
        },
        { fields: viewFields }
      );
      if (!tray) {
        return res.json({
          success: true,
          data: null,
          message: lookupCode || lookupId ? "Tray not found or not authorized." : undefined,
        });
      }
      return res.json({ success: true, data: formatTrayViewRow(tray) });
    }

    const safeFilters = sanitizeFilters(filters, CFG.filterFields);
    const result = await findTrays({
      filters: { ...safeFilters, status: "active", approved: true },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields: viewFields,
    });

    const rows = (result.data || []).map(formatTrayViewRow);

    if (rows.length === 0 && !search) {
      const anyTrays = await findTrays({ filters: { status: "active" }, limit: 1, fields: ["t.id"] });
      if (anyTrays.total > 0) {
        return res.json({
          success: true,
          data: [],
          message: "No authorized trays found. Approve trays in Tray Master first.",
        });
      }
    }

    return res.json({ success: true, ...result, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getTrays = async (req, res) => {
  try {
    const view = String(req.body?.view || "batch").trim().toLowerCase();
    const defaults = view === "tray" ? { sortBy: "id", order: "DESC" } : { sortBy: "created_at", order: "DESC" };
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, defaults);
    const safeFilters = sanitizeFilters(filters, CFG.filterFields);

    if (view === "tray") {
      const result = await findTrays({
        filters: safeFilters,
        search: sanitizeSearch(search),
        sort: { by: sortBy, order },
        page,
        limit,
        fields: CFG.listFields,
        permission: req.permission,
      });
      return res.json({ success: true, ...result, data: result.data || [] });
    }

    const result = await findTrayBatches({
      filters: safeFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });

    return res.json({ success: true, ...result, data: result.data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createTray = async (req, res) => {
  try {
    const type = normalizeTrayType(req.body?.type);
    const quantity = Number(req.body?.quantity);

    if (!isValidTrayType(type)) {
      return res.status(400).json({ success: false, message: "Invalid tray type" });
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.trunc(quantity) !== quantity) {
      return res.status(400).json({ success: false, message: "quantity must be a positive whole number" });
    }

    const created = await createTrayBatch({
      type,
      quantity,
      created_by: auditUserName(req),
    });

    await log(req, "create", created.batch.batch_id, {
      type,
      quantity: created.batch.quantity,
      batch_id: created.batch.batch_id,
      start_code: created.batch.start_code,
      end_code: created.batch.end_code,
    });

    return res.status(201).json({
      success: true,
      data: created,
      message: `Created ${created.batch.quantity} tray(s) in batch ${created.batch.start_code} to ${created.batch.end_code}`,
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Tray code conflict detected. Please retry." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateTray = async (req, res) => {
  try {
    const batch_id = String(req.body?.batch_id || "").trim();
    const id = parsePositiveIntId(req.body?.id);
    const hasQuantity = req.body?.quantity !== undefined && req.body?.quantity !== null && String(req.body.quantity).trim() !== "";
    const normalizedApproved = req.body?.approved !== undefined ? normalizeApprovedInput(req.body?.approved) : undefined;
    const hasStatus = req.body?.status !== undefined && req.body?.status !== null && String(req.body.status).trim() !== "";

    if (hasStatus) {
      const nextStatus = normalizeTrayStatus(req.body.status);
      if (!isValidTrayStatus(nextStatus)) {
        return res.status(400).json({ success: false, message: "Invalid tray status" });
      }
      const remark = parseTrayRemark(req.body);
      if ((nextStatus === "inactive" || nextStatus === "deleted") && !remark) {
        return res.status(400).json({ success: false, message: "Remark is required" });
      }

      const trayIds = parseTrayIds(req.body?.ids);
      if (trayIds.length) {
        const result = await updateTrayStatusByIds(trayIds, nextStatus, auditUserName(req), remark || null);
        if (!result.updated) {
          return res.status(400).json({ success: false, message: "No trays matched this status change." });
        }
        await log(req, "update", trayIds.join(","), { ids: trayIds, status: nextStatus, remark, updated_count: result.updated });
        return res.json({
          success: true,
          data: result,
          message: `Updated ${result.updated} tray(s) to ${nextStatus}`,
        });
      }

      if (batch_id) {
        const result = await updateTrayBatchStatus(batch_id, nextStatus, auditUserName(req), remark || null);
        if (!result.updated) {
          return res.status(400).json({ success: false, message: "No trays matched this status change." });
        }
        await log(req, "update", batch_id, { batch: true, status: nextStatus, remark, updated_count: result.updated });
        return res.json({
          success: true,
          data: result,
          message: `Updated ${result.updated} tray(s) to ${nextStatus}`,
        });
      }

      if (!id) return res.status(400).json({ success: false, message: "Valid tray id or batch_id required" });

      const existing = await findTray({ id });
      if (!existing) return res.status(404).json({ success: false, message: "Not found" });
      if (normalizeTrayStatus(existing.status) === "deleted") {
        return res.status(400).json({ success: false, message: "Deleted tray cannot be changed." });
      }
      if (normalizeTrayStatus(existing.status) === nextStatus) {
        return res.status(400).json({ success: false, message: "Tray is already in this status." });
      }

      const updated = await updateTrayStatusById(id, nextStatus, auditUserName(req), remark || null);
      if (!updated) return res.status(400).json({ success: false, message: "Failed to update tray status" });

      await log(req, "update", id, { status: nextStatus, remark, code: existing.code, batch_id: existing.batch_id }, existing);
      return res.json({
        success: true,
        data: updated,
        message: `Tray marked as ${nextStatus}`,
      });
    }

    if (batch_id) {
      const nextType = req.body?.type ? normalizeTrayType(req.body.type) : undefined;
      const hasType = !!nextType;
      if (hasType && !isValidTrayType(nextType)) {
        return res.status(400).json({ success: false, message: "Invalid tray type" });
      }
      if (!hasQuantity && normalizedApproved === undefined && !hasType) {
        return res.status(400).json({ success: false, message: "type, quantity or approved is required for batch update" });
      }

      let quantity;
      if (hasQuantity) {
        quantity = Number(req.body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || Math.trunc(quantity) !== quantity) {
          return res.status(400).json({ success: false, message: "quantity must be a positive whole number" });
        }
      }

      const result = await updateTrayBatch({
        batch_id,
        type: hasType ? nextType : undefined,
        quantity: hasQuantity ? quantity : undefined,
        approved: normalizedApproved,
        actor: auditUserName(req),
      });

      if (!result.changed) {
        return res.status(400).json({ success: false, message: "No changes to update." });
      }

      await log(req, "update", result.batch_id, {
        batch: true,
        quantity: result.quantity,
        approved: normalizedApproved,
        previous_batch_id: batch_id !== result.batch_id ? batch_id : undefined,
      });

      return res.json({
        success: true,
        data: result,
        message: "Batch updated successfully",
      });
    }

    if (normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "approved field is required" });
    }

    if (!id) return res.status(400).json({ success: false, message: "Valid tray id or batch_id required" });

    const existing = await findTray({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (normalizeTrayStatus(existing.status) === "deleted") {
      return res.status(400).json({ success: false, message: "Deleted tray cannot be updated" });
    }
    if (existing.approved === normalizedApproved) {
      return res.status(400).json({ success: false, message: "Approval status is already set." });
    }

    const updated = await updateTrayApprovalById(id, normalizedApproved, auditUserName(req));
    if (!updated) return res.status(400).json({ success: false, message: "Failed to update tray" });

    await log(req, "update", id, { approved: normalizedApproved }, existing);

    return res.json({
      success: true,
      data: updated,
      message: normalizedApproved ? "Tray approved successfully" : "Tray moved to pending",
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Tray code conflict detected. Please retry." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteTray = async (req, res) => {
  try {
    const remark = parseTrayRemark(req.body);
    if (!remark) {
      return res.status(400).json({ success: false, message: "Remark is required" });
    }

    const batch_id = String(req.body?.batch_id || "").trim();
    if (batch_id) {
      const result = await deleteTrayBatchRows(batch_id, auditUserName(req), remark);
      if (!result.updated) {
        return res.status(400).json({ success: false, message: "No active trays to delete in this batch." });
      }
      await log(req, "delete", batch_id, { batch: true, remark, deleted_count: result.updated });
      return res.json({
        success: true,
        data: result,
        message: `Deleted ${result.updated} tray(s) in batch ${batch_id}`,
      });
    }

    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Valid tray id or batch_id required" });

    const existing = await findTray({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (existing.status === "deleted") {
      return res.status(400).json({ success: false, message: "Tray already deleted" });
    }

    const deleted = await deleteTrayById(id, auditUserName(req), remark);
    if (!deleted) return res.status(400).json({ success: false, message: "Tray already deleted" });

    await log(req, "delete", id, { remark, code: existing.code, type: existing.type, batch_id: existing.batch_id }, existing);

    return res.json({ success: true, message: "Tray deleted successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
