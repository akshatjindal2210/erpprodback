import { withTransaction } from "../../../config/db.js";
import { findAdjustments, findAdjustmentById, insertAdjustment, updateAdjustments, insertAdjustmentTx, updateAdjustmentsTx } from "../models/stockAdjustment.model.js";
import { findDailyProdByDocNo, findBoxesByUids, purgeSaStickerBoxesTx, resolveItemDcodeForMinusAdjustment } from "../models/box.model.js";
import { boxBelongsToPackingNumber } from "../utils/boxInventory.js";
import { fetchPackRowsForFinancialYearDoc, rowInIndianFinancialYear } from "../services/ims.service.js";
import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { enrichRowsWithIMS } from "../utils/imsLookup.js";
import { syncAdjustmentMetadataOnly } from "../utils/stockAdjustmentSync.js";
import { applyStockAdjustmentOnApproveTx, revertStockAdjustmentOnUnapproveTx } from "../utils/stockAdjustmentApply.js";
import { purgeStockAdjustmentTransactionLogs } from "../utils/logBoxTransaction.js";
import { isBoxAvailableForMinus } from "../utils/boxInventory.js";

const STOCK_CFG = getCrudModuleConfig("stock_adjustment");

/** Minus / box removal — add, edit, authorize, or delete on stock_adjustment (not delete-only). */
function canUserRemoveInventoryBoxes(req) {
  if (req.user?.type === "super_admin") return true;
  const p = req.permission;
  if (!p) return false;
  return !!(p.can_delete || p.can_add || p.can_edit || p.can_authorize);
}

async function enrichAdjustments(rows = []) {
  return enrichRowsWithIMS(rows, {
    itemCodeField: "item_dcode",
    accCodeField: "acc_code",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
    accNameOut: "acc_name"
  });
}

export const getAdjustments = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC"
    });
    const result = await findAdjustments({
      page,
      limit,
      filters: sanitizeFilters(filters, STOCK_CFG.filterFields),
      sort: { by: sortBy, order },
      search,
      permission: req.permission
    });
    const enriched = await enrichAdjustments(result.data || []);
    res.json({ success: true, ...result, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createAdjustment = async (req, res) => {
  try {
    const normalizedApproved = normalizeApprovedInput(req.body.approved);
    const { item_dcode: bodyItemDcode, qty: bodyQty, unit, remarks, entry_type, packing_number: rawPacking, financial_year,
      per_box_qty, box_count_impact, no_of_boxes, removed_box_uids } = req.body;

    let item_dcode = bodyItemDcode;
    let qty = bodyQty;
    let packing_number = rawPacking != null ? String(rawPacking).trim() : "";
    let per_box_qty_v = per_box_qty !== undefined && per_box_qty !== null && per_box_qty !== "" ? parseInt(per_box_qty, 10) : null;
    let box_count_impact_v = box_count_impact !== undefined && box_count_impact !== null && box_count_impact !== "" ? parseInt(box_count_impact, 10) : null;
    if (no_of_boxes !== undefined && no_of_boxes !== null && no_of_boxes !== "" && box_count_impact_v == null) {
      box_count_impact_v = parseInt(no_of_boxes, 10);
    }

    let removed_box_ids_json = null;
    /** Set only for `entry_type === "minus"` — used when persisting adjustment + linking boxes. */
    let liveMinusRows = null;
    const fyTrim = financial_year != null ? String(financial_year).trim() : "";

    if (entry_type === "add") {
      if (!fyTrim) {
        return res.status(400).json({ success: false, message: "Financial year required" });
      }
    
      if (!packing_number) {
        return res.status(400).json({ success: false, message: "Packing number required" });
      }
    
      const dp = await findDailyProdByDocNo(packing_number);
      if (dp?.itemdcode) {
        item_dcode = parseInt(dp.item_dcode ?? dp.itemdcode, 10);
      } else {
        const ims = await fetchPackRowsForFinancialYearDoc(fyTrim, packing_number);
        const first = (ims.records || []).find((r) => rowInIndianFinancialYear(r, fyTrim)) ?? ims.records?.[0];
        if (!ims.success || !first?.itemdcode) {
          return res.status(400).json({
            success: false,
            message: ims.message || "No IMS pack entry was found for this packing in the selected financial year. Check the financial year and packing number."
          });
        }
        item_dcode = parseInt(first.itemdcode, 10);
      }
      if (!box_count_impact_v || box_count_impact_v < 1 || !per_box_qty_v || per_box_qty_v < 1) {
        return res.status(400).json({
          success: false,
          message: "Number of boxes and per-box quantity must both be positive integers."
        });
      }
      qty = box_count_impact_v * per_box_qty_v;
    } else if (entry_type === "minus") {
      if (!canUserRemoveInventoryBoxes(req)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to remove boxes from inventory.",
        });
      }
      if (!packing_number) {
        return res.status(400).json({ success: false, message: "Packing number required" });
      }
      const uidsRaw = Array.isArray(removed_box_uids) ? removed_box_uids : [];
      const uids = [...new Set(uidsRaw.map((u) => String(u).trim()).filter(Boolean))];
      if (!uids.length) {
        return res.status(400).json({ success: false, message: "Select at least one box." });
      }
      const rows = await findBoxesByUids(uids);
      const pnNorm = packing_number;
      const live = (rows || []).filter((r) => !r.is_deleted && boxBelongsToPackingNumber(r, pnNorm));
      if (live.length !== uids.length) {
        return res.status(400).json({
          success: false,
          message: "Some boxes do not match this packing number or are deleted."
        });
      }
      const notAvailable = live.find((r) => !isBoxAvailableForMinus(r));
      if (notAvailable) {
        return res.status(400).json({
          success: false,
          message:
            "Some boxes are not in hand — they may be dispatched (outward) or already removed via another stock adjustment."
        });
      }
      liveMinusRows = live;
      const sumQty = live.reduce((s, r) => s + (parseInt(r.qty, 10) || 0), 0);
      qty = -Math.abs(sumQty);
      box_count_impact_v = live.length;
      const resolvedItem = await resolveItemDcodeForMinusAdjustment({
        packing_number: pnNorm,
        boxRows: live,
      });
      if (resolvedItem == null) {
        return res.status(400).json({
          success: false,
          message: "Could not resolve item from selected boxes.",
        });
      }
      item_dcode = resolvedItem;
      removed_box_ids_json = JSON.stringify(
        live.map((r) => r.box_uid).filter((id) => id != null)
      );
    } else {
      if (item_dcode == null || item_dcode === "") {
        return res.status(400).json({ success: false, message: "item_dcode required" });
      }
      if (qty == null || qty === "") {
        return res.status(400).json({ success: false, message: "qty required" });
      }
      item_dcode = parseInt(item_dcode, 10);
      qty = parseInt(qty, 10);
    }

    const data = { item_dcode, qty, unit: unit ?? "PCS", remarks, created_by: req.user.id };

    if (entry_type === "add" || entry_type === "minus") {
      data.entry_type = entry_type;
      data.packing_number = packing_number;
      data.financial_year = entry_type === "add" ? fyTrim : null;
      data.per_box_qty = entry_type === "add" ? per_box_qty_v : null;
      data.box_count_impact = box_count_impact_v;
      if (entry_type === "minus") data.removed_box_ids = removed_box_ids_json;
    }

    let adjustment;
    if (entry_type === "add" || entry_type === "minus") {
      adjustment = await withTransaction(async (client) => {
        const adj = await insertAdjustmentTx(client, data);
        if (normalizedApproved === true) {
          const approvalFields = {};
          applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false });
          await updateAdjustmentsTx(client, approvalFields, { adjustment_id: adj.adjustment_id });
          const fresh = { ...adj, ...data, ...approvalFields, approved: true };
          await applyStockAdjustmentOnApproveTx(client, { adjustment: fresh, userId: req.user.id });
        }
        return adj;
      });
    } else {
      adjustment = await insertAdjustment(data);
      if (normalizedApproved === true) {
        const approvalFields = {};
        applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false });
        await updateAdjustments(approvalFields, { adjustment_id: adjustment.adjustment_id });
      }
    }

    await logActivity(req, { action: "create", entity: "stock_adjustment", entity_id: adjustment.adjustment_id, details: data });
    
    const saved = await findAdjustmentById(adjustment.adjustment_id);
    const [enriched] = await enrichAdjustments(saved ? [saved] : [adjustment]);
    res.status(201).json({ success: true, data: enriched || saved || adjustment, message: "Adjustment created" });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getAdjustmentById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await findAdjustmentById(id);
    if (!data) return res.status(404).json({ success: false, message: "Adjustment not found" });

    const [enriched] = await enrichAdjustments(data ? [data] : []);
    res.json({ success: true, data: enriched || data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateAdjustment = async (req, res) => {
  try {
    const { id, approved, removed_box_uids, remove_add_box_uids, add_extra_boxes, no_of_boxes, ...incoming } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findAdjustmentById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Adjustment not found" });

    // Permission-based date restriction (can_edit_days)
    if (req.user.type !== "super_admin" && req.permission && req.permission.can_edit_days > 0) {
      const createdAt = new Date(existing.created_at);
      const now = new Date();
      const diffTime = Math.abs(now - createdAt);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays > req.permission.can_edit_days) {
        return res.status(403).json({ 
          success: false, 
          message: `Edit time limit exceeded. You can only edit records from the last ${req.permission.can_edit_days} days.` 
        });
      }
    }

    const packingEntry = existing.entry_type === "add" || existing.entry_type === "minus";
    const wantsPackingBoxSync =
      packingEntry &&
      (removed_box_uids !== undefined ||
        remove_add_box_uids !== undefined ||
        add_extra_boxes !== undefined ||
        incoming.per_box_qty !== undefined ||
        incoming.box_count_impact !== undefined ||
        no_of_boxes !== undefined);

    const uidsToRemove = [
      ...(Array.isArray(removed_box_uids) ? removed_box_uids : []),
      ...(Array.isArray(remove_add_box_uids) ? remove_add_box_uids : []),
    ].filter((u) => Number.isFinite(Number(u)));
    if (uidsToRemove.length > 0 && !canUserRemoveInventoryBoxes(req)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to remove boxes from inventory.",
      });
    }

    const approvingMinus =
      normalizedApproved === true && existing.entry_type === "minus";
    let addHasPendingRemovals = false;
    if (normalizedApproved === true && existing.entry_type === "add" && existing.removed_box_ids) {
      try {
        const parsed = JSON.parse(existing.removed_box_ids);
        addHasPendingRemovals = Array.isArray(parsed) && parsed.length > 0;
      } catch {
        addHasPendingRemovals = false;
      }
    }
    if ((approvingMinus || addHasPendingRemovals) && !canUserRemoveInventoryBoxes(req)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to remove boxes from inventory.",
      });
    }

    const syncBody = {
      ...incoming,
      removed_box_uids,
      remove_add_box_uids,
      add_extra_boxes,
      no_of_boxes
    };

    const fields = { ...incoming, updated_by: req.user.id, updated_at: new Date() };
    const wasApproved = !!existing.approved;
    const hasBusinessChanges =
      Object.keys(incoming).length > 0 || wantsPackingBoxSync;

    /** Approved row + any edit → pending only; Approve must be a separate action. */
    if (wasApproved && hasBusinessChanges) {
      if (normalizedApproved === true) {
        return res.status(400).json({
          success: false,
          message:
            "Save changes first (status will become pending), then use Approve to apply box changes."
        });
      }
      fields.approved = false;
      fields.approved_by = null;
      fields.approved_at = null;
    } else {
      applyApprovalWorkflow({
        req,
        fields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges
      });
    }

    let updated;
    await withTransaction(async (client) => {
      if (wasApproved) {
        await revertStockAdjustmentOnUnapproveTx(client, { adjustment: existing, userId: req.user.id });
      }
      if (wantsPackingBoxSync) {
        await syncAdjustmentMetadataOnly(client, { existing, body: syncBody, userId: req.user.id });
      }
      [updated] = await updateAdjustmentsTx(client, fields, { adjustment_id: id });

      const { rows: freshRows } = await client.query(
        `SELECT * FROM ims_stock_adjustment WHERE adjustment_id = $1::integer AND is_deleted = false`,
        [id]
      );
      const row = freshRows[0] || updated || { ...existing, ...fields };
      if (fields.approved === true && !(wasApproved && hasBusinessChanges)) {
        await applyStockAdjustmentOnApproveTx(client, { adjustment: row, userId: req.user.id });
      }
    });

    await logActivity(req, { action: "update", entity: "stock_adjustment", entity_id: id, details: fields });

    const saved = await findAdjustmentById(id);
    const [enriched] = await enrichAdjustments(saved ? [saved] : updated ? [updated] : []);
    res.json({ success: true, data: enriched || saved || updated, message: "Adjustment updated" });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteAdjustment = async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ success: false, message: "Invalid adjustment id." });
    }

    const existing = await findAdjustmentById(id);
    if (!existing || existing.is_deleted) {
      return res.status(404).json({ success: false, message: "Adjustment not found." });
    }

    await withTransaction(async (client) => {
      // Undo inventory impact: add → hard-delete SA boxes; minus → restore boxes to in-hand.
      await revertStockAdjustmentOnUnapproveTx(client, {
        adjustment: existing,
        userId: req.user.id
      });
      await updateAdjustmentsTx(
        client,
        { is_deleted: true, deleted_by: req.user.id, deleted_at: new Date() },
        { adjustment_id: id }
      );
      await purgeStockAdjustmentTransactionLogs({ client, adjustmentId: id });
      const pn = String(existing.packing_number ?? "").trim();
      await purgeSaStickerBoxesTx(client, pn || null);
    });

    await logActivity(req, {
      action: "delete",
      entity: "stock_adjustment",
      entity_id: id,
      details: { entry_type: existing.entry_type, approved: existing.approved }
    });

    const message =
      existing.entry_type === "add"
        ? "Adjustment deleted. Added boxes were permanently removed from inventory."
        : existing.entry_type === "minus"
          ? "Adjustment deleted. Removed boxes were restored to inventory."
          : "Adjustment deleted.";

    res.json({ success: true, message });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getStockAdjustmentsViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, sortBy, order, search } = extractListParams(req.body, { sortBy: "adjustment_id", order: "DESC" });

    if (id) {
      const data = await findAdjustmentById(id);
      if (!data || data.is_deleted || !data.approved) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { adjustment_id: data.adjustment_id, item_dcode: data.item_dcode, qty: data.qty, unit: data.unit } });
    }

    const result = await findAdjustments({
      filters: { approved: true, is_deleted: false },
      search: sanitizeSearch(search),
      sort: { by: sortBy || "adjustment_id", order: order || "DESC" },
      page: page || 1,
      limit: limit || 5000,
      fields: ["adjustment_id", "item_dcode", "qty", "unit"]
    });
    const enriched = await enrichAdjustments(result.data || []);
    res.json({ success: true, data: enriched, total: result.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
