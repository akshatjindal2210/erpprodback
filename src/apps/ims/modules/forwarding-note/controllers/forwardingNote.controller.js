import { findForwardingNotes, findForwardingNote, parseForwardingFuid, insertForwardingNote, updateForwardingNotes, deleteForwardingNotes, findAvailableBoxes, isForwardingNoteLockedForOutEntry, lockForwardingNoteForOutEntry, unlockForwardingNoteForOutEntry, findForwardingNoteTransporters, findForwardingNoteVehicles, findLastForwardingPackingCategory } from "../models/forwardingNote.model.js";
import { buildForwardingAvailableBoxes, findItemDcodesWithForwardingAvailableStock } from "../utils/stock/forwardingAvailableStock.js";
import { buildPackingNumberSet, filterForwardingBoxesByCategoryId, filterErpStockByCategory } from "../utils/packing/forwardingPackingCategory.js";
import { enrichRowsWithIMS } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { enrichBillPackingDates, enrichForwardingItemRows, enrichForwardingNoteDetail, enrichForwardingSummaryRows, sanitizePrintCompanyInfo, buildBillDropdownMatchKey, buildInvfnoteBillOptions, invfnoteHasGreenBillForItems, resolveBillDropdownMatchForUser } from "../utils/list/forwardingNoteList.js";
import { saveForwardingNoteItems, replaceForwardingNoteItems, validateExistingForwardingNoteItems } from "../utils/items/forwardingNoteItemsWrite.js";
import { buildForwardingLockMessage } from "../utils/messages/forwardingNoteMessages.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput, auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { findForwardingNoteItems, findForwardingNoteItem, assignForwardingNoteItemBills } from "../models/forwardingNoteItem.model.js";
import { sanitizeSearch, buildForwardingNoteBillDocument } from "../../../../core/lib/utils/helper/helper.js";
import { fetchFromIMS } from "../../../lib/services/ims.service.js";
import { findCategories } from "../../category/models/category.model.js";
import { fetchErpFgStockForItem, summarizeErpFgRecords } from "../../../lib/utils/erp-api/stock/erpFgStock.js";
import { hasDirectForwardingNotePermission, hasManageForwardingBillPermission } from "../../../lib/utils/imsSpecialPermissions.js";

const FORWARDING_CFG = getCrudModuleConfig("forwarding_note_master");
const FORWARDING_ITEM_CFG = getCrudModuleConfig("forwarding_note_item_wise");

function parseForwardingPackingCategoryId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveForwardingCategoryPackings(boxes, packing_category_id) {
  const catId = parseForwardingPackingCategoryId(packing_category_id);
  if (!catId) return null;
  const filtered = filterForwardingBoxesByCategoryId(boxes, catId);
  return buildPackingNumberSet(filtered.map((b) => b.packing_number));
}

export const getForwardingNotes = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at", order: "DESC"
    });

    const result = await findForwardingNotes({
      filters: sanitizeFilters(filters, FORWARDING_CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page, limit,
      fields: FORWARDING_CFG.listFields,
      permission: req.permission // Pass permission to model
    });

    const enrichedRows = await enrichForwardingSummaryRows(result.data || []);
    res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getForwardingNoteItems = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at", order: "DESC"
    });

    const result = await findForwardingNoteItems({
      filters: sanitizeFilters(filters, FORWARDING_ITEM_CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page, limit,
      fields: FORWARDING_ITEM_CFG.listFields,
      permission: req.permission
    });

    const enrichedRows = await enrichForwardingItemRows(result.data || []);
    res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getForwardingNoteById = async (req, res) => {
  try {
    const fuid = parseForwardingFuid(req.body?.fuid ?? req.body?.id);
    if (!fuid) {
      return res.status(400).json({ success: false, message: "Valid fuid required" });
    }

    const data = await findForwardingNote({ fuid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    const enrichedData = await enrichForwardingNoteDetail(data);
    res.json({ success: true, data: enrichedData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createForwardingNote = async (req, res) => {
  try {
    const { items = [], approved, ...rest } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    let schno = rest.schno != null && String(rest.schno).trim() !== "" ? String(rest.schno).trim() : null;

    // Multi-schedule FN: derive header schno from item-wise schedules when header empty.
    if (!schno) {
      const fromItems = [
        ...new Set(
          (items || [])
            .map((i) => (i?.schno != null ? String(i.schno).trim() : ""))
            .filter(Boolean)
        ),
      ];
      if (fromItems.length) schno = fromItems[0];
    }

    const itemHasSchno = (items || []).some(
      (i) => i?.schno != null && String(i.schno).trim() !== ""
    );

    // Direct create (no schedule) requires special permission; schedule-based create needs module add only.
    if (!schno && !itemHasSchno && !hasDirectForwardingNotePermission(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Direct Forwarding Note permission required to create without a schedule. Create from Today's Dispatch Plan instead.",
      });
    }

    const approvalFields = {};
    if (normalizedApproved === true) {
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false,
        auditAsName: true,
      });
    }

    const row = await withTransaction(async (client) => {
      const inserted = await insertForwardingNote(
        { ...rest, schno, created_by: auditUserName(req) },
        { client }
      );
      await saveForwardingNoteItems({
        fuid: inserted.fuid,
        items,
        userName: auditUserName(req),
        client,
      });
      if (normalizedApproved === true && Object.keys(approvalFields).length) {
        await updateForwardingNotes(approvalFields, { fuid: inserted.fuid }, { client });
      }
      return inserted;
    });

    // Full data fetch with joins
    const data = await findForwardingNote({ fuid: row.fuid });
    const enrichedData = await enrichForwardingNoteDetail(data);

    await logActivity(req, {
      action: "create",
      entity: "forwarding_note_master",
      entity_id: row.fuid,
      record: enrichedData,
      meta: { po_number: rest.po_number, item_count: items.length },
    });

    res.status(201).json({ success: true, data: enrichedData });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/**
 * Assign bill onto item-wise line(s).
 * Requires special permission manage_forwarding_bill (or super_admin).
 * Body: { item_ids: number[], billno, billdt? }
 */
export const assignForwardingNoteItemBill = async (req, res) => {
  try {
    const body = req.body || {};
    const itemIds = Array.isArray(body.item_ids) ? body.item_ids : body.item_id != null ? [body.item_id] : [];
    const billno = String(body.billno ?? body.bill_no ?? "").trim();
    if (!itemIds.length) {
      return res.status(400).json({ success: false, message: "At least one item line is required." });
    }
    if (!billno) {
      return res.status(400).json({ success: false, message: "Bill number is required." });
    }

    if (!hasManageForwardingBillPermission(req.user)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to assign or change forwarding note bills.",
      });
    }

    const ids = itemIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    const lineRows = await dbQuery(
      `SELECT fi.id, fi.bill_no, fnm.acc_code, fi.item_dcode, fi.packing_number, fi.total_qty, (oe.out_uid IS NOT NULL AND COALESCE(oe.scan_complete, false) = true) AS out_entry_complete
       FROM ims_forwarding_note_item_wise fi
       INNER JOIN ims_forwarding_note_master fnm ON fnm.fuid = fi.fuid AND fnm.is_deleted = false
       LEFT JOIN LATERAL (
         SELECT oe.out_uid, oe.scan_complete
         FROM ims_out_entry oe
         WHERE oe.fuid = fnm.fuid AND oe.is_deleted = false
         ORDER BY oe.out_uid DESC
         LIMIT 1
       ) oe ON true
       WHERE fi.is_deleted = false AND fi.id = ANY($1::int[])`,
      [ids]
    );

    if (!lineRows?.length) {
      return res.status(404).json({ success: false, message: "No item lines were found." });
    }

    // Future: require store-out complete before bill assign
    // for (const row of lineRows) {
    //   if (!row.out_entry_complete) {
    //     return res.status(409).json({
    //       success: false,
    //       message: "A bill can only be assigned after store-out is complete for this line.",
    //     });
    //   }
    // }

    const matchMode = resolveBillDropdownMatchForUser(req.user);
    const invfnoteRecords = await fetchFromIMS("invfnote");
    if (
      !invfnoteHasGreenBillForItems(
        invfnoteRecords,
        billno,
        lineRows.map((row) => ({
          acc_code: row.acc_code,
          item_dcode: row.item_dcode,
          packing_number: row.packing_number,
          total_qty: row.total_qty,
        })),
        matchMode
      )
    ) {
      return res.status(400).json({
        success: false,
        message: `Bill "${billno}" cannot be assigned on this item line.`,
      });
    }

    const updated = await assignForwardingNoteItemBills({
      itemIds: ids,
      bill_no: billno,
      bill_dt: body.billdt ?? body.bill_dt ?? null,
      userName: auditUserName(req),
    });

    if (!updated?.length) {
      return res.status(404).json({ success: false, message: "No item lines were updated." });
    }

    await logActivity(req, {
      action: "update",
      entity: "forwarding_note_item_wise",
      entity_id: updated.map((r) => r.id).join(","),
      meta: {
        field: "bill_no",
        billno,
        billdt: body.billdt ?? body.bill_dt ?? null,
        item_ids: updated.map((r) => r.id),
        fuids: [...new Set(updated.map((r) => r.fuid))],
      },
    });

    const refreshed = [];
    for (const u of updated) {
      const row = await findForwardingNoteItem({ id: u.id });
      if (row) refreshed.push(row);
    }
    const enriched = await enrichForwardingItemRows(refreshed);

    res.json({ success: true, message: "Bill saved successfully.", data: enriched });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateForwardingNote = async (req, res) => {
  try {
    const { fuid, approved, items = [], ...updateData } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

    const existing = await findForwardingNote({ fuid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (await isForwardingNoteLockedForOutEntry(fuid)) {
      return res.status(409).json({
        success: false,
        message: buildForwardingLockMessage(existing)
      });
    }

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

    // Check if any business fields changed (excluding approval fields)
    const businessFields = ["acc_code", "po_number", "remarks", "transporter_name", "transporter_id", "vehicle_number", "cartage", "total_items"];
    let hasBusinessChanges = businessFields.some(f => updateData[f] !== undefined && updateData[f] != existing[f]);

    // Check if items changed
    if (items.length > 0) {
      // For simplicity, we assume any item update is a business change
      // In a more complex scenario, we'd compare item arrays
      hasBusinessChanges = true; 
    }

    const fields = {
      ...updateData,
      updated_by: auditUserName(req),
      updated_at: new Date()
    };

    // Strip legacy master bill fields if client still sends them
    delete fields.bill_no;
    delete fields.bill_updated_by;
    delete fields.bill_updated_at;
    
    applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges, auditAsName: true });

    const isNewApproval =
      normalizedApproved === true &&
      !(existing.approved === true || existing.approved === "true" || existing.approved === 1);

    if (items.length > 0) {
      await withTransaction(async (client) => {
        await replaceForwardingNoteItems({
          fuid,
          items,
          userName: auditUserName(req),
          excludeFuid: fuid,
          client,
        });
        await updateForwardingNotes(fields, { fuid }, { client });
      });
    } else if (isNewApproval) {
      await validateExistingForwardingNoteItems({ fuid, excludeFuid: fuid });
      await updateForwardingNotes(fields, { fuid });
    } else {
      await updateForwardingNotes(fields, { fuid });
    }

    const data = await findForwardingNote({ fuid });
    const enrichedData = await enrichForwardingNoteDetail(data);
    await logActivity(req, { action: "update", entity: "forwarding_note_master", entity_id: fuid });

    res.json({ success: true, data: enrichedData });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteForwardingNote = async (req, res) => {
  try {
    const { fuid } = req.body;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });
    const existing = await findForwardingNote({ fuid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (await isForwardingNoteLockedForOutEntry(fuid)) {
      return res.status(409).json({
        success: false,
        message: buildForwardingLockMessage(existing)
      });
    }

    await deleteForwardingNotes({ fuid }, { deleted_by: auditUserName(req) });
    await logActivity(req, { action: "delete", entity: "forwarding_note_master", entity_id: fuid, record: existing });

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const lockForwardingNoteLock = async (req, res) => {
  try {
    const { fuid } = req.body;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

    const existing = await findForwardingNote({ fuid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (existing.out_entry_locked) {
      return res.status(409).json({ success: false, message: "This forwarding note is already locked." });
    }

    const locked = await lockForwardingNoteForOutEntry({ fuid, userName: auditUserName(req) });
    if (!locked) return res.status(404).json({ success: false, message: "Not found" });

    await logActivity(req, {
      action: "lock",
      entity: "forwarding_note_master",
      entity_id: fuid,
      meta: { reason: "manual_super_admin_lock_out_entry_lock" }
    });

    return res.json({
      success: true,
      message: "Forwarding note locked successfully.",
      data: locked
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const unlockForwardingNoteLock = async (req, res) => {
  try {
    const { fuid } = req.body;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

    const existing = await findForwardingNote({ fuid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const unlocked = await unlockForwardingNoteForOutEntry({ fuid });
    if (!unlocked) return res.status(404).json({ success: false, message: "Not found" });

    await logActivity(req, {
      action: "unlock",
      entity: "forwarding_note_master",
      entity_id: fuid,
      meta: { reason: "manual_super_admin_unlock_out_entry_lock" }
    });

    return res.json({
      success: true,
      message: "Forwarding note unlocked successfully.",
      data: unlocked
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getForwardingNoteTransportersViews = async (req, res) => {
  try {
    const { acc_code, search, limit } = req.body || {};
    const rows = await findForwardingNoteTransporters({ acc_code, search, limit });
    res.json({
      success: true,
      data: (rows || []).map((r) => ({
        id: `${String(r.transporter_name || "").trim()}__${String(r.transporter_id || "").trim()}`,
        transporter_name: r.transporter_name,
        transporter_id: r.transporter_id,
        last_used_at: r.last_used_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getForwardingNoteVehiclesViews = async (req, res) => {
  try {
    const { acc_code, search, limit } = req.body || {};
    const rows = await findForwardingNoteVehicles({ acc_code, search, limit });
    res.json({
      success: true,
      data: (rows || []).map((r) => {
        const vehicle_number = String(r.vehicle_number || "").trim();
        return {
          id: vehicle_number,
          vehicle_number,
          last_used_at: r.last_used_at,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Live invfnote bills for item-wise assign dropdown.
 * Match mode: super_admin → acc_item · others → acc_item_packing.
 * Only green-status bills can be saved; all matching bills are listed with status.
 * Request body: `items: [{ acc_code, item_dcode, packing_number, total_qty? }]`.
 */
export const getForwardingNoteBillNumbersViews = async (req, res) => {
  try {
    const search = String(req.body?.search ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(req.body?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 50));
    const matchMode = resolveBillDropdownMatchForUser(req.user);

    const keySet = new Set();
    if (Array.isArray(req.body?.items)) {
      for (const item of req.body.items) {
        const key = buildBillDropdownMatchKey(item, matchMode);
        if (key) keySet.add(key);
      }
    }

    if (!keySet.size) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const records = await fetchFromIMS("invfnote");
    const rows = buildInvfnoteBillOptions(records, { keySet, matchMode, search });

    const total = rows.length;
    const start = (page - 1) * limit;
    const data = rows.slice(start, start + limit);

    res.json({ success: true, data, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getAvailableBoxesByItem = async (req, res) => {
  try {
    let { item_dcode, exclude_fuid, packing_category_id } = req.body;

    if (!item_dcode) {
      return res.status(400).json({ success: false, message: "item_dcode is required" });
    }

    // Convert to number explicitly here too
    const clean_dcode = Number(item_dcode);
    
    if (isNaN(clean_dcode)) {
      return res.status(400).json({ success: false, message: "item_dcode must be a valid number" });
    }

    const exclude = exclude_fuid != null && exclude_fuid !== "" && Number.isFinite(Number(exclude_fuid)) ? Number(exclude_fuid) : null;

    const rows = await findAvailableBoxes(clean_dcode);
    let data = await buildForwardingAvailableBoxes(rows, clean_dcode, exclude);

    const catId = parseForwardingPackingCategoryId(packing_category_id);
    if (catId) {
      data = filterForwardingBoxesByCategoryId(data, catId);
    }

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error: " + err.message });
  }
};

/** Items with FG stock available for forwarding (dropdown — excludes fully reserved / empty). */
export const getAvailableItemsForForwarding = async (req, res) => {
  try {
    const exclude_fuid =
      req.body?.exclude_fuid != null &&
      req.body.exclude_fuid !== "" &&
      Number.isFinite(Number(req.body.exclude_fuid))
        ? Number(req.body.exclude_fuid)
        : null;

    const ids = await findItemDcodesWithForwardingAvailableStock(exclude_fuid);
    if (!ids.length) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const stubs = ids.map((id) => ({
      itemdcode: id,
      item_code: String(id),
      itemdesc: "",
    }));
    const enriched = await enrichRowsWithIMS(stubs, {
      itemCodeField: "itemdcode",
      itemCodeOut: "item_code",
      itemDescOut: "itemdesc",
    });

    const data = enriched.map((item) => ({
      id: item.itemdcode,
      itemdcode: item.itemdcode,
      item_code: item.item_code || String(item.itemdcode ?? ""),
      itemdesc: item.itemdesc,
    }));

    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [], total: 0 });
  }
};

/** ERP FG stock for forwarding note item row (`requestedData: erpfg`). */
export const getErpFgStockByItem = async (req, res) => {
  try {
    const item_dcode = Number(req.body?.item_dcode);
    if (!Number.isFinite(item_dcode) || item_dcode <= 0) {
      return res.status(400).json({ success: false, message: "Valid item_dcode is required" });
    }

    const ims = await fetchErpFgStockForItem(item_dcode);
    const summary = summarizeErpFgRecords(ims?.records);

    const exclude =
      req.body?.exclude_fuid != null &&
      req.body.exclude_fuid !== "" &&
      Number.isFinite(Number(req.body.exclude_fuid))
        ? Number(req.body.exclude_fuid)
        : null;
    const boxRows = await findAvailableBoxes(item_dcode);
    const builtBoxes = await buildForwardingAvailableBoxes(boxRows, item_dcode, exclude);
    const allowedPackings = resolveForwardingCategoryPackings(
      builtBoxes,
      req.body?.packing_category_id
    );
    const filtered = allowedPackings
      ? filterErpStockByCategory(summary, allowedPackings)
      : {
          total: summary.total,
          byPacking: summary.byPacking,
          records: summary.records,
        };

    res.json({
      success: ims?.success !== false,
      total: filtered.total,
      by_packing: filtered.byPacking,
      records: filtered.records,
      message: ims?.message,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** All categories + customer's last used category on forwarding notes (default OEM if none). */
export const getForwardingNoteCustomerCategory = async (req, res) => {
  try {
    const acc_code = Number(req.body?.acc_code);
    if (!Number.isFinite(acc_code)) {
      return res.status(400).json({ success: false, message: "Valid acc_code is required" });
    }

    const [categoriesResult, lastId] = await Promise.all([
      findCategories({
        sort: { by: "name", order: "ASC" },
        page: 1,
        limit: 1000,
        fields: ["id", "name"],
      }),
      findLastForwardingPackingCategory(acc_code),
    ]);

    const options = (categoriesResult?.data || []).map((c) => ({
      id: c.id,
      name: c.name,
    }));

    let packing_category_id = lastId;
    if (
      packing_category_id != null &&
      !options.some((o) => Number(o.id) === Number(packing_category_id))
    ) {
      packing_category_id = null;
    }
    if (packing_category_id == null) {
      const oem = options.find((o) => String(o.name || "").trim().toLowerCase() === "oem");
      packing_category_id = oem?.id ?? options[0]?.id ?? null;
    }

    res.json({
      success: true,
      data: {
        packing_category_id,
        options,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getForwardingNotesViews = async (req, res) => {
  try {
    const { id, search, filters } = req.body || {};

    if (id) {
      const data = await findForwardingNote({ fuid: id });
      if (!data || data.is_deleted || !data.approved) return res.json({ success: true, data: null });
      const [enriched] = await enrichForwardingSummaryRows([data]);
      return res.json({
        success: true,
        data: {
          fuid: enriched?.fuid ?? data.fuid,
          acc_code: enriched?.acc_code ?? data.acc_code,
          acc_name: enriched?.acc_name ?? data.acc_name,
          po_number: enriched?.po_number ?? data.po_number
        }
      });
    }

    const searchTerm = typeof search === "object" ? search?.search : search;
    const helperFilters = typeof search === "object" ? (search?.filters || {}) : (filters || {});
    const result = await findForwardingNotes({
      search: sanitizeSearch(searchTerm),
      filters: {
        ...(helperFilters?.approved !== undefined ? { approved: helperFilters.approved } : { approved: true }),
        ...(helperFilters?.out_entry_available !== undefined ? { out_entry_available: helperFilters.out_entry_available } : {})
      },
      sort: { by: "fuid", order: "DESC" },
      page: 1,
      limit: 5000,
      fields: ["f.fuid", "f.acc_code", "f.po_number", "f.acc_code::text AS acc_name"]
    });
    const enrichedRows = await enrichForwardingSummaryRows(result.data || []);
    res.json({ success: true, data: enrichedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST body: { fuid, company_info?: { name, address } } — returns HTML for browser print / Save as PDF */
export const printForwardingNoteBill = async (req, res) => {
  try {
    const { fuid: fuidRaw, company_info } = req.body || {};
    // Use master fuid only — never treat item-wise `id` as fuid
    const fuid = parseForwardingFuid(fuidRaw);
    if (!fuid) {
      return res.status(400).json({ success: false, message: "Valid fuid required" });
    }

    const data = await findForwardingNote({ fuid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    const enriched = await enrichForwardingNoteDetail(data);
    await enrichBillPackingDates(enriched);
    const html = buildForwardingNoteBillDocument(enriched, sanitizePrintCompanyInfo(company_info));
    res.json({ success: true, html });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
