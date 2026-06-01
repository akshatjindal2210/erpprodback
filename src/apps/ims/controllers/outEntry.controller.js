import {
  findOutEntries,
  findOutEntry,
  insertOutEntry,
  updateOutEntries,
  deleteOutEntries,
  findFuidDetailsForOutEntry,
  findOutEntryLinkedBoxes,
  findOutEntryDraftBoxUids,
  applyOutEntryApprovedStock,
  saveOutEntryDraftScans,
  clearOutEntryDraftScans,
  resetBoxesForOutEntry,
  findAnyOutEntryByFuid,
} from "../models/outEntry.model.js";
import { findForwardingNote, lockForwardingNoteForOutEntry, unlockForwardingNoteForOutEntry } from "../models/forwardingNote.model.js";
import { findBoxesByNoUids } from "../models/box.model.js";
import { isBoxAvailableForOutEntryScan, isBoxInHand } from "../utils/boxInventory.js";

import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { enrichRowsWithIMS } from "../utils/imsLookup.js";
import {
  assertOutEntryFulfillmentComplete,
  findScannedBoxUidsForOutEntry,
  getOutEntryScanSummary,
  resolveOutEntryBatchScan,
} from "../utils/outEntryFulfillment.js";

const OUT_CFG = getCrudModuleConfig("out_entry");

async function validateOutEntryScannedBoxes(scanned_boxes, forOutUid = null) {
  const uids = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!uids.length) return null;
  const rows = await findBoxesByNoUids(uids);
  if (rows.length !== uids.length) {
    return "Some scanned boxes were not found or are deleted.";
  }
  const draftSet = new Set(
    forOutUid != null ? await findOutEntryDraftBoxUids(forOutUid) : []
  );
  const scopedOut =
    forOutUid != null && String(forOutUid).trim() !== "" ? Number(forOutUid) : null;
  const blocked = rows.find((r) => {
    if (isBoxInHand(r)) return false;
    const uid = String(r.box_no_uid ?? "").trim();
    if (draftSet.has(uid)) return false;
    if (Number.isFinite(scopedOut) && Number(r.out_uid) === scopedOut) return false;
    return !isBoxAvailableForOutEntryScan(r, { forOutUid });
  });
  if (blocked) {
    return "Some boxes are not in stock — they may be outward or removed via stock adjustment.";
  }
  return null;
}

/** Draft = scan list only; approved = stock outward on ims_box_table. */
async function syncOutEntryBoxLinks({ out_uid, userId, scanned_boxes, approved }) {
  const list = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (approved) {
    await applyOutEntryApprovedStock({ out_uid, userId, scanned_boxes: list });
  } else {
    await saveOutEntryDraftScans({ out_uid, userId, scanned_boxes: list });
  }
  return list;
}

async function enrichOutEntryItems(rows = []) {
  const enriched = await enrichRowsWithIMS(rows, {
    itemCodeField: "item_dcode",
    itemCodeOut: "item_code",
    itemDescOut: "itemdesc"
  });
  return (enriched || []).map((row) => ({ ...row, item_desc: row.item_desc ?? row.itemdesc ?? null }));
}

async function enrichOutEntryNote(note) {
  if (!note) return note;
  const [enriched] = await enrichRowsWithIMS([note], {
    accCodeField: "acc_code",
    accNameOut: "acc_name"
  });
  return enriched || note;
}

async function scannedListForOut({ out_uid, scanned_boxes }) {
  if (scanned_boxes !== undefined) {
    return [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  }
  if (out_uid) return findScannedBoxUidsForOutEntry(out_uid);
  return [];
}

export const getOutEntries = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at", order: "DESC"
    });

    const result = await findOutEntries({
      filters: sanitizeFilters(filters, OUT_CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page, limit,
      fields: OUT_CFG.listFields,
      permission: req.permission
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntryById = async (req, res) => {
  try {
    const { out_uid } = req.body;
    if (!out_uid) return res.status(400).json({ success: false, message: "out_uid required" });

    const data = await findOutEntry({ out_uid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createOutEntry = async (req, res) => {
  try {
    const { fuid, remarks, scanned_boxes, approved } = req.body;
    const userId = req.user.id;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });
    const note = await findForwardingNote({ fuid });
    if (!note) return res.status(404).json({ success: false, message: "Forwarding Note not found" });
    if (!note.approved) {
      return res.status(409).json({ success: false, message: "Only approved forwarding notes can be used in out entry." });
    }
    const alreadyLinked = await findAnyOutEntryByFuid({ fuid });
    if (alreadyLinked) {
      return res.status(409).json({ success: false, message: "One FUID can be used for only one Out Entry." });
    }

    const scannedList = await scannedListForOut({ scanned_boxes });

    if (scannedList.length > 0) {
      const scanErr = await validateOutEntryScannedBoxes(scannedList);
      if (scanErr) return res.status(400).json({ success: false, message: scanErr });
    }

    const summary = await getOutEntryScanSummary({ fuid, scanned_boxes: scannedList });

    if (normalizedApproved === true && !summary.scan_complete) {
      return res.status(400).json({ success: false, message: summary.fulfillment?.message || "Scan all required boxes before approving." });
    }

    const row = await insertOutEntry({
      fuid,
      remarks,
      created_by: userId,
      scan_complete: summary.scan_complete,
      boxes_required: summary.boxes_required,
      boxes_scanned: summary.boxes_scanned,
    });
    const outUid = row.out_uid;

    const willApprove = normalizedApproved === true && summary.scan_complete;
    await syncOutEntryBoxLinks({
      out_uid: outUid,
      userId,
      scanned_boxes: scannedList,
      approved: willApprove,
    });

    const patchFields = {
      updated_by: userId,
      updated_at: new Date(),
      scan_complete: summary.scan_complete,
      boxes_required: summary.boxes_required,
      boxes_scanned: summary.boxes_scanned,
      approved: false,
    };

    if (willApprove) {
      patchFields.approved = true;
      applyApprovalWorkflow({ req, fields: patchFields, incomingApproved: true, hasBusinessChanges: false });
    }

    await updateOutEntries(patchFields, { out_uid: outUid });

    const data = await findOutEntry({ out_uid: outUid });
    if (data?.approved) {
      await lockForwardingNoteForOutEntry({ fuid: data.fuid, userId });
    }

    await logActivity(req, { action: "create", entity: "out_entry", entity_id: outUid });
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateOutEntry = async (req, res) => {
  try {
    const { out_uid, fuid, remarks, approved, scanned_boxes } = req.body;
    const userId = req.user.id;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!out_uid) return res.status(400).json({ success: false, message: "out_uid required" });

    const existing = await findOutEntry({ out_uid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (fuid !== undefined) {
      const note = await findForwardingNote({ fuid });
      if (!note) return res.status(404).json({ success: false, message: "Forwarding Note not found" });
      if (!note.approved) {
        return res.status(409).json({ success: false, message: "Only approved forwarding notes can be used in out entry." });
      }
      const alreadyLinked = await findAnyOutEntryByFuid({ fuid, excludeOutUid: out_uid });
      if (alreadyLinked) {
        return res.status(409).json({ success: false, message: "One FUID can be used for only one Out Entry." });
      }
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

    const hasBusinessChanges = fuid !== undefined || remarks !== undefined || scanned_boxes !== undefined;
    const effectiveFuid = fuid !== undefined ? fuid : existing.fuid;

    let finalScanned = await scannedListForOut({
      out_uid,
      scanned_boxes: scanned_boxes !== undefined ? scanned_boxes : undefined,
    });

    if (scanned_boxes !== undefined) {
      if (finalScanned.length > 0) {
        const scanErr = await validateOutEntryScannedBoxes(finalScanned, out_uid);
        if (scanErr) return res.status(400).json({ success: false, message: scanErr });
      }
    } else {
      finalScanned = await findScannedBoxUidsForOutEntry(out_uid);
    }

    const summary = await getOutEntryScanSummary({ fuid: effectiveFuid, scanned_boxes: finalScanned });

    if (normalizedApproved === true && !summary.scan_complete) {
      return res.status(400).json({
        success: false,
        message: summary.fulfillment?.message || "Scan all required boxes before approving.",
      });
    }

    const willApprove = summary.scan_complete && normalizedApproved === true;
    const wasApproved = Boolean(existing.approved);
    const scansChanged = scanned_boxes !== undefined;
    const approvalChanged = willApprove !== wasApproved;

    if (scansChanged || approvalChanged) {
      await syncOutEntryBoxLinks({
        out_uid,
        userId,
        scanned_boxes: finalScanned,
        approved: willApprove,
      });
    }

    const fields = {
      ...(fuid !== undefined && { fuid }),
      ...(remarks !== undefined && { remarks }),
      updated_by: userId,
      updated_at: new Date(),
      scan_complete: summary.scan_complete,
      boxes_required: summary.boxes_required,
      boxes_scanned: summary.boxes_scanned,
    };

    if (!summary.scan_complete) {
      fields.approved = false;
      fields.approved_by = null;
      fields.approved_at = null;
    }

    applyApprovalWorkflow({
      req,
      fields,
      incomingApproved: summary.scan_complete ? normalizedApproved : false,
      hasBusinessChanges,
    });

    await updateOutEntries(fields, { out_uid });

    const data = await findOutEntry({ out_uid });
    if (data?.approved) {
      await lockForwardingNoteForOutEntry({ fuid: data.fuid, userId });
    }
    await logActivity(req, { action: "update", entity: "out_entry", entity_id: out_uid });

    res.json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const lockFuidForOutEntry = async (req, res) => {
  try {
    const { fuid } = req.body;
    const userId = req.user.id;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

    const note = await findForwardingNote({ fuid });
    if (!note) return res.status(404).json({ success: false, message: "Forwarding Note not found" });
    if (!note.approved) {
      return res.status(409).json({ success: false, message: "Only approved forwarding notes can be used in out entry." });
    }
    const alreadyLinked = await findAnyOutEntryByFuid({ fuid });
    if (alreadyLinked) {
      return res.status(409).json({ success: false, message: "One FUID can be used for only one Out Entry." });
    }

    const lockResult = await lockForwardingNoteForOutEntry({ fuid, userId });
    if (!lockResult) return res.status(404).json({ success: false, message: "Forwarding Note not found" });

    return res.json({
      success: true,
      message: "Forwarding note locked for out entry.",
      data: lockResult
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteOutEntry = async (req, res) => {
  try {
    const { out_uid } = req.body;
    if (!out_uid) return res.status(400).json({ success: false, message: "out_uid required" });

    const existing = await findOutEntry({ out_uid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    // Release linked boxes first so they don't remain stuck as out.
    await resetBoxesForOutEntry(out_uid, req.user.id);
    await clearOutEntryDraftScans(out_uid);
    await deleteOutEntries({ out_uid }, { deleted_by: req.user.id });
    if (existing.fuid) {
      await unlockForwardingNoteForOutEntry({ fuid: existing.fuid });
    }

    await logActivity(req, { action: "delete", entity: "out_entry", entity_id: out_uid });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntriesViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, sortBy, order, search } = extractListParams(req.body, { sortBy: "out_uid", order: "DESC" });

    if (id) {
      const data = await findOutEntry({ out_uid: id });
      if (!data || data.is_deleted || !data.approved) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { out_uid: data.out_uid, fuid: data.fuid, remarks: data.remarks } });
    }

    const result = await findOutEntries({
      filters: { approved: true },
      search: sanitizeSearch(search),
      sort: { by: sortBy || "out_uid", order: order || "DESC" },
      page: page || 1,
      limit: limit || 5000,
      fields: ["out_uid", "fuid", "remarks"]
    });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const verifyBoxSticker = async (req, res) => {
  try {
    // ONLY log the body, not the whole request object
    console.log("Request Body Received:", req.body);

    return res.status(200).json({ 
      success: true, 
      message: "Server reached successfully",
      received: req.body // Good for debugging
    });

  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const batchScanOutEntryBoxes = async (req, res) => {
  try {
    const { fuid, for_out_uid, items, session_scanned } = req.body;
    const fuidNum = Number(fuid);
    if (!Number.isFinite(fuidNum) || fuidNum <= 0) {
      return res.status(400).json({ success: false, message: "fuid is required" });
    }

    const scanItems = Array.isArray(items) ? items : [];
    if (!scanItems.length) {
      return res.status(400).json({ success: false, message: "items array is required" });
    }
    if (scanItems.length > 50) {
      return res.status(400).json({ success: false, message: "Maximum 50 scans per request" });
    }

    const forOutUidParsed =
      for_out_uid !== undefined && for_out_uid !== null && String(for_out_uid).trim() !== ""
        ? Number(for_out_uid)
        : null;
    const forOutUid = Number.isFinite(forOutUidParsed) ? forOutUidParsed : null;

    const { results } = await resolveOutEntryBatchScan({
      fuid: fuidNum,
      forOutUid,
      items: scanItems,
      session_scanned: Array.isArray(session_scanned) ? session_scanned : [],
    });

    return res.json({ success: true, results });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getFuidDetailsForOutEntry = async (req, res) => {
  console.time("API_Execution");
  try {
    const { fuid, for_out_uid } = req.body;
    if (!fuid) return res.status(400).json({ success: false, message: "fuid required" });

    const forOutUidParsed = for_out_uid !== undefined && for_out_uid !== null && String(for_out_uid).trim() !== "" ? Number(for_out_uid) : null;
    const forOutUid = Number.isFinite(forOutUidParsed) ? forOutUidParsed : null;

    const [note, items, linkedBoxes] = await Promise.all([
      findForwardingNote({ fuid }),
      findFuidDetailsForOutEntry(fuid, forOutUid),
      forOutUid ? findOutEntryLinkedBoxes(forOutUid) : Promise.resolve([]),
    ]);
    if (!note) return res.status(404).json({ success: false, message: "Forwarding Note not found" });

    if (!note.approved) {
      if (forOutUid) {
        const existing = await findOutEntry({ out_uid: forOutUid });
        if (!existing || Number(existing.fuid) !== Number(fuid)) {
          return res.status(409).json({
            success: false,
            message: "Only approved forwarding notes can be used in out entry.",
          });
        }
      } else {
        return res.status(409).json({
          success: false,
          message: "Only approved forwarding notes can be used in out entry.",
        });
      }
    }

    const [enrichedNote, enrichedItems] = await Promise.all([
      enrichOutEntryNote(note),
      enrichOutEntryItems(items || []),
    ]);
    res.json({
      success: true,
      data: {
        ...enrichedNote,
        items: enrichedItems,
        linked_boxes: linkedBoxes || [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    console.timeEnd("API_Execution");
  }
};
