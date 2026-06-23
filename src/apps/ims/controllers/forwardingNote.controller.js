import { findForwardingNotes, findForwardingNote, parseForwardingFuid, insertForwardingNote, updateForwardingNotes, updateForwardingNoteBillNo, deleteForwardingNotes, findAvailableBoxes, isForwardingNoteLockedForOutEntry, lockForwardingNoteForOutEntry, unlockForwardingNoteForOutEntry, findForwardingNoteTransporters } from "../models/forwardingNote.model.js";
import { buildForwardingAvailableBoxes } from "../utils/forwarding-note/forwardingAvailableStock.js";
import { enrichBillPackingDates, enrichForwardingItemRows, enrichForwardingNoteDetail, enrichForwardingSummaryRows, sanitizePrintCompanyInfo } from "../utils/forwarding-note/forwardingNoteList.js";
import { saveForwardingNoteItems } from "../utils/forwarding-note/forwardingNoteItemsWrite.js";
import { buildForwardingLockMessage } from "../utils/forwarding-note/forwardingNoteMessages.js";
import { logActivity } from "../../core/utils/logActivity.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../../core/utils/approval.js";
import { deleteForwardingNoteItems, findForwardingNoteItems } from "../models/forwardingNoteItem.model.js";
import { sanitizeSearch, buildForwardingNoteBillDocument } from "../../core/utils/helper.js";
import { fetchFromIMS } from "../services/ims.service.js";

const FORWARDING_CFG = getCrudModuleConfig("forwarding_note_master");
const FORWARDING_ITEM_CFG = getCrudModuleConfig("forwarding_note_item_wise");

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

    // 1. Insert Master
    const row = await insertForwardingNote({ ...rest, created_by: req.user.id });

    await saveForwardingNoteItems({
      fuid: row.fuid,
      items,
      userId: req.user.id,
    });

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

    if (items.length > 0) {
      await deleteForwardingNoteItems({ fuid }, { deleted_by: req.user.id });
      await saveForwardingNoteItems({
        fuid,
        items,
        userId: req.user.id,
        excludeFuid: fuid,
      });
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

    await deleteForwardingNotes({ fuid }, { deleted_by: req.user.id });
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

function normalizeImsBillNo(record) {
  const raw =
    record?.prnbillno ??
    record?.PrnBillNo ??
    record?.bill_no ??
    record?.billno ??
    "";
  return String(raw ?? "").trim();
}

/** Live bill numbers from IMS (`requestedData: "billno"`). */
export const getForwardingNoteBillNumbersViews = async (req, res) => {
  try {
    const search = String(req.body?.search ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(req.body?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 50));

    const records = await fetchFromIMS("billno");
    const seen = new Set();
    const rows = [];

    for (const rec of records) {
      const billNo = normalizeImsBillNo(rec);
      if (!billNo || seen.has(billNo)) continue;
      seen.add(billNo);
      if (search && !billNo.toLowerCase().includes(search)) continue;
      rows.push({ id: billNo, bill_no: billNo });
    }

    rows.sort((a, b) =>
      String(a.bill_no).localeCompare(String(b.bill_no), undefined, { sensitivity: "base" })
    );

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
    let { item_dcode, exclude_fuid } = req.body;

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
    const data = await buildForwardingAvailableBoxes(rows, clean_dcode, exclude);
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error: " + err.message });
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
    await enrichBillPackingDates(enriched);
    const html = buildForwardingNoteBillDocument(enriched, sanitizePrintCompanyInfo(company_info));
    res.json({ success: true, html });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
