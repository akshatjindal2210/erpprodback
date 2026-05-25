import { findForwardingNotes, findForwardingNote, insertForwardingNote, updateForwardingNotes, updateForwardingNoteBillNo, deleteForwardingNotes, findAvailableBoxes, isForwardingNoteLockedForOutEntry, lockForwardingNoteForOutEntry, unlockForwardingNoteForOutEntry, findForwardingNoteTransporters } from "../models/forwardingNote.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { insertForwardingNoteItem, deleteForwardingNoteItems, findForwardingNoteItems } from "../models/forwardingNoteItem.model.js";
import { sanitizeSearch, buildForwardingNoteBillDocument } from "../utils/helper.js";
import { enrichRowsWithIMS } from "../utils/imsLookup.js";

const FORWARDING_CFG = getCrudModuleConfig("forwarding_note_master");
const FORWARDING_ITEM_CFG = getCrudModuleConfig("forwarding_note_item_wise");

async function enrichForwardingSummaryRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name"
  });
}

async function enrichForwardingItemRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    accCodeField: "acc_code",
    accNameOut: "acc_name",
    itemCodeField: "item_dcode",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc"
  });
}

async function enrichForwardingNoteDetail(data) {
  if (!data) return data;
  const [summary] = await enrichForwardingSummaryRows([data]);
  const accCode = data.acc_code;

  const enrichedGroups = [];
  for (const grp of data.items || []) {
    const rowsToEnrich = [
      { ...grp, acc_code: accCode },
      ...(grp.breakdowns || []).map((b) => ({ ...b, acc_code: accCode })),
    ];
    const enriched = await enrichForwardingItemRows(rowsToEnrich);
    const [enrichedGrp, ...enrichedBreakdowns] = enriched;

    enrichedGroups.push({
      ...enrichedGrp,
      itemdesc: enrichedGrp.itemdesc ?? enrichedGrp.item_desc ?? null,
      breakdowns: enrichedBreakdowns.map((row) => ({
        ...row,
        itemdesc: row.itemdesc ?? row.item_desc ?? null,
      })),
    });
  }

  return {
    ...(summary || data),
    items: enrichedGroups,
  };
}

/** Limits client-supplied print header overrides (size / abuse). */
const sanitizePrintCompanyInfo = (raw) => {
  if (!raw || typeof raw !== "object") return {};
  const limits = { name: 200, address: 800, gstin: 32, phone: 160 };
  const out = {};
  for (const key of Object.keys(limits)) {
    if (typeof raw[key] !== "string") continue;
    const t = raw[key].trim();
    if (t) out[key] = t.slice(0, limits[key]);
  }
  return out;
};

const buildLockMessage = (record) => {
  const lockBy = record?.out_entry_locked_by_name || "another user";
  const lockAt = record?.out_entry_locked_at
    ? new Date(record.out_entry_locked_at).toLocaleString("en-IN")
    : null;
  return lockAt
    ? `This forwarding note is locked for out entry by ${lockBy} since ${lockAt}.`
    : `This forwarding note is locked for out entry by ${lockBy}.`;
};

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
    const { fuid } = req.body;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

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
    console.log("createForwardingNote - ", req.body);
    const { items = [], approved, ...rest } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    // 1. Insert Master
    const row = await insertForwardingNote({ ...rest, created_by: req.user.id });
    
    console.log("row - ", row);
    console.log("items - ", items);
    
    // 2. Insert Items (Item-wise breakdown)
    for (const item of items) {
      if (item.is_pre_calculated) {
        // Direct insertion for pre-calculated items (from edit mode without changes)
        await insertForwardingNoteItem({
          fuid:           row.fuid,
          item_dcode:     item.item_dcode,
          packing_number: item.packing_number,
          box:            item.box,
          box_qty:        item.box_qty,
          loose_box:      item.loose_box,
          loose_box_qty:  item.loose_box_qty,
          total_qty:      item.total_qty,
          created_by:     req.user.id,
        });
        continue;
      }

      // Group selected boxes by packing number to insert into forwarding_note_item_wise
      const groupedBoxes = (item.selected_boxes || []).reduce((acc, box) => {
        const pNo = box.packing_number || "N/A";
        if (!acc[pNo]) acc[pNo] = { open_boxes: 0, open_qty: 0, loose_boxes: 0, loose_qty: 0 };
        
        if (box.is_loose) {
          acc[pNo].loose_boxes += 1;
          acc[pNo].loose_qty += Number(box.qty);
        } else {
          acc[pNo].open_boxes += 1;
          acc[pNo].open_qty += Number(box.qty);
        }
        return acc;
      }, {});

      for (const [packing_number, stats] of Object.entries(groupedBoxes)) {
        await insertForwardingNoteItem({
          fuid:           row.fuid,
          item_dcode:     item.item_dcode,
          packing_number: packing_number,
          box:            stats.open_boxes,
          box_qty:        stats.open_qty,
          loose_box:      stats.loose_boxes,
          loose_box_qty:  stats.loose_qty,
          total_qty:      stats.open_qty + stats.loose_qty,
          created_by:     req.user.id,
        });
      }
    }

    // 3. Apply initial approval state when requested
    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false
      });
      await updateForwardingNotes(approvalFields, { fuid: row.fuid });
    }

    // 4. Full data fetch with joins
    const data = await findForwardingNote({ fuid: row.fuid });
    const enrichedData = await enrichForwardingNoteDetail(data);

    await logActivity(req, {
      action    : "create",
      entity    : "forwarding_note_master",
      entity_id : row.fuid,
      meta      : { po_number: rest.po_number, item_count: items.length }
    });

    res.status(201).json({ success: true, data: enrichedData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Bill number only — allowed after out entry lock (bill arrives post dispatch). */
export const updateForwardingNoteBill = async (req, res) => {
  try {
    const { fuid, bill_no } = req.body;
    if (fuid === undefined || fuid === null || fuid === "") {
      return res.status(400).json({ success: false, message: "fuid required" });
    }

    const existing = await findForwardingNote({ fuid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const normalized =
      bill_no === null || bill_no === undefined ? null : String(bill_no).trim() || null;
    const previous = existing.bill_no ?? null;

    if (previous === normalized) {
      const unchanged = await enrichForwardingNoteDetail(existing);
      return res.json({ success: true, data: unchanged, message: "No change" });
    }

    const row = await updateForwardingNoteBillNo({
      fuid,
      bill_no: normalized,
      userId: req.user.id,
    });
    if (!row) return res.status(404).json({ success: false, message: "Not found" });

    await logActivity(req, {
      action: "update",
      entity: "forwarding_note_master",
      entity_id: fuid,
      meta: {
        field: "bill_no",
        previous_bill_no: previous,
        bill_no: normalized,
        out_entry_locked: Boolean(existing.out_entry_locked),
      },
    });

    const enriched = await enrichForwardingNoteDetail(
      await findForwardingNote({ fuid })
    );
    res.json({ success: true, data: enriched });
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
        message: buildLockMessage(existing)
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

    // 1. Update Master
    // Check if any business fields changed (excluding approval fields)
    const businessFields = ["acc_code", "po_number", "remarks", "transporter_name", "transporter_id", "vehicle_number", "cartage", "total_items", "bill_no"];
    let hasBusinessChanges = businessFields.some(f => updateData[f] !== undefined && updateData[f] != existing[f]);

    // Check if items changed
    if (items.length > 0) {
      // For simplicity, we assume any item update is a business change
      // In a more complex scenario, we'd compare item arrays
      hasBusinessChanges = true; 
    }

    const fields = {
      ...updateData,
      updated_by: req.user.id,
      updated_at: new Date()
    };

    if (updateData.bill_no !== undefined) {
      const normalizedBill =
        updateData.bill_no === null || updateData.bill_no === undefined
          ? null
          : String(updateData.bill_no).trim() || null;
      const previousBill =
        existing.bill_no === null || existing.bill_no === undefined
          ? null
          : String(existing.bill_no).trim() || null;
      if (normalizedBill !== previousBill) {
        fields.bill_updated_by = req.user.id;
        fields.bill_updated_at = new Date();
      }
    }
    
    applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges });
    await updateForwardingNotes(fields, { fuid });

    // 2. Update Items (Delete old and insert new)
    if (items.length > 0) {
      // Soft delete existing items
      await deleteForwardingNoteItems({ fuid }, { deleted_by: req.user.id });

      // Insert new items
      for (const item of items) {
        if (item.is_pre_calculated) {
          await insertForwardingNoteItem({
            fuid,
            item_dcode:     item.item_dcode,
            packing_number: item.packing_number,
            box:            item.box,
            box_qty:        item.box_qty,
            loose_box:      item.loose_box,
            loose_box_qty:  item.loose_box_qty,
            total_qty:      item.total_qty,
            created_by:     req.user.id,
          });
          continue;
        }

        const groupedBoxes = (item.selected_boxes || []).reduce((acc, box) => {
          const pNo = box.packing_number || "N/A";
          if (!acc[pNo]) acc[pNo] = { open_boxes: 0, open_qty: 0, loose_boxes: 0, loose_qty: 0 };
          if (box.is_loose) { acc[pNo].loose_boxes += 1; acc[pNo].loose_qty += Number(box.qty); }
          else { acc[pNo].open_boxes += 1; acc[pNo].open_qty += Number(box.qty); }
          return acc;
        }, {});

        for (const [packing_number, stats] of Object.entries(groupedBoxes)) {
          await insertForwardingNoteItem({
            fuid,
            item_dcode:     item.item_dcode,
            packing_number,
            box:            stats.open_boxes,
            box_qty:        stats.open_qty,
            loose_box:      stats.loose_boxes,
            loose_box_qty:  stats.loose_qty,
            total_qty:      stats.open_qty + stats.loose_qty,
            created_by:     req.user.id,
          });
        }
      }
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
        message: buildLockMessage(existing)
      });
    }

    await deleteForwardingNotes({ fuid }, { deleted_by: req.user.id });
    await logActivity(req, { action: "delete", entity: "forwarding_note_master", entity_id: fuid });

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

    const locked = await lockForwardingNoteForOutEntry({ fuid, userId: req.user.id });
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

// ─── HELPER: Transporter suggestions (per customer) ──────────────────────────
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

// ─── GET AVAILABLE BOXES (FIFO) ───────────
export const getAvailableBoxesByItem = async (req, res) => {
  try {
    let { item_dcode } = req.body;

    if (!item_dcode) {
      return res.status(400).json({ success: false, message: "item_dcode is required" });
    }

    // Convert to number explicitly here too
    const clean_dcode = Number(item_dcode);
    
    if (isNaN(clean_dcode)) {
       return res.status(400).json({ success: false, message: "item_dcode must be a valid number" });
    }

    const rows = await findAvailableBoxes(clean_dcode);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error: " + err.message });
  }
};

// ─── GET Views (Helper API for other modules) ──────────────────
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

export const getForwardingNoteViewById = async (req, res) => {
  try {
    const { fuid } = req.body || {};
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });
    const data = await findForwardingNote({ fuid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    const [enriched] = await enrichForwardingSummaryRows([data]);
    res.json({
      success: true,
      data: {
        fuid: enriched?.fuid ?? data.fuid,
        acc_code: enriched?.acc_code ?? data.acc_code,
        acc_name: enriched?.acc_name ?? data.acc_name,
        po_number: enriched?.po_number ?? data.po_number
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST body: { fuid, company_info?: { name, address } } — returns HTML for browser print / Save as PDF */
export const printForwardingNoteBill = async (req, res) => {
  try {
    const { fuid: fuidRaw, company_info } = req.body || {};
    const fuid = parseInt(fuidRaw, 10);
    if (!Number.isInteger(fuid) || fuid < 1) {
      return res.status(400).json({ success: false, message: "Valid fuid required" });
    }

    const data = await findForwardingNote({ fuid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    const enriched = await enrichForwardingNoteDetail(data);
    const html = buildForwardingNoteBillDocument(enriched, sanitizePrintCompanyInfo(company_info));
    res.json({ success: true, html });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};