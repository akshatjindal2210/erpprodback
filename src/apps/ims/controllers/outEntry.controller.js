import { findOutEntries, findOutEntry, insertOutEntry, updateOutEntries, deleteOutEntries, findFuidDetailsForOutEntry, findOutEntryLinkedBoxes, findQcHoldDetailsForOutEntry, clearOutEntryDraftScans, resetBoxesForOutEntry, findAnyOutEntryByFuid, findDistinctOutEntryReasons } from "../models/outEntry.model.js";
import { findUser } from "../../core/models/user.model.js";
import { findForwardingNote, lockForwardingNoteForOutEntry, unlockForwardingNoteForOutEntry } from "../models/forwardingNote.model.js";
import { logActivity } from "../../core/utils/logActivity.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../../core/utils/approval.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { findScannedBoxUidsForOutEntry, getOutEntryScanSummary, getOutEntryOtherScanSummary, getOutEntryQcAreaScanSummary, resolveOutEntryBatchScan, resolveOutEntryOtherBatchScan, resolveOutEntryInventoryOutBatchScan, resolveOutEntryQcAreaBatchScan } from "../utils/out-entry/outEntryFulfillment.js";
import { enrichOutEntryItems, enrichOutEntryListRows, enrichOutEntryNote, isOutEntryAutoAuthorized, isOutEntryInventoryOut, isOutEntryPackingArea, isOutEntryQcArea, normalizeOutEntryReasonInput, normalizeOutEntryType, OUT_ENTRY_TYPE, scannedListForOut, syncOutEntryBoxLinks, validateOutEntryInventoryOutScannedBoxes, validateOutEntryOtherScannedBoxes, validateOutEntryQcAreaScannedBoxes, validateOutEntryScannedBoxes } from "../utils/out-entry/index.js";
import { withTransaction } from "../../../config/db.js";
import { enrichQcHoldListRows } from "../utils/qc-hold-material/qcHoldList.js";
import { snapshotMetadataFromBoxUids, snapshotOutEntryMetadata } from "../utils/erp-api/entryListMetadata.js";
import { parsePositiveIntId } from "../../core/utils/parseId.js";

const OUT_CFG = getCrudModuleConfig("out_entry");

function requireOutUid(res, raw) {
  const out_uid = parsePositiveIntId(raw);
  if (!out_uid) {
    res.status(400).json({ success: false, message: "Valid out_uid required" });
    return null;
  }
  return out_uid;
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

    const enrichedData = await enrichOutEntryListRows(result.data || []);
    res.json({ success: true, ...result, data: enrichedData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntryById = async (req, res) => {
  try {
    const out_uid = requireOutUid(res, req.body?.out_uid);
    if (!out_uid) return;

    const data = await findOutEntry({ out_uid });
    if (!data) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createOutEntry = async (req, res) => {
  try {
    const { fuid, entry_type: rawEntryType, remarks, scanned_boxes, approved, reason, reason_text } = req.body;
    const userId = req.user.id;
    const entry_type = normalizeOutEntryType(rawEntryType);
    const normalizedApproved = normalizeApprovedInput(approved);

    // Backend Permission Check for Inventory Out
    if (isOutEntryInventoryOut(entry_type)) {
      const user = await findUser({ id: userId });
      const isSuperAdmin = user?.type === "super_admin";
      if (!isSuperAdmin && !user?.special_permissions?.ims?.inventory_out) {
        return res.status(403).json({ 
          success: false, 
          message: "You do not have permission to perform Inventory Out." 
        });
      }
    }

    if (isOutEntryInventoryOut(entry_type) || isOutEntryPackingArea(entry_type) || isOutEntryQcArea(entry_type)) {
      const normalizedReason = normalizeOutEntryReasonInput(reason, reason_text);
      if (!normalizedReason) {
        return res.status(400).json({ success: false, message: "Reason is required." });
      }

      const scannedList = await scannedListForOut({ scanned_boxes });
      if (!scannedList.length) {
        return res.status(400).json({ success: false, message: "Scan at least one box." });
      }

      if (isOutEntryQcArea(entry_type)) {
        const qc_hold_id = Number(req.body.qc_hold_id);
        if (!Number.isFinite(qc_hold_id) || qc_hold_id <= 0) {
          return res.status(400).json({ success: false, message: "QC hold is required." });
        }
        const scanErr = await validateOutEntryQcAreaScannedBoxes(scannedList, qc_hold_id);
        if (scanErr) return res.status(400).json({ success: false, message: scanErr });

        const summary = await getOutEntryQcAreaScanSummary({ scanned_boxes: scannedList, hold_id: qc_hold_id });

        const result = await withTransaction(async (client) => {
          const row = await insertOutEntry({
            entry_type: OUT_ENTRY_TYPE.QC_AREA,
            qc_hold_id,
            reason: normalizedReason,
            remarks,
            created_by: userId,
            scan_complete: summary.scan_complete,
            boxes_required: summary.boxes_required,
            boxes_scanned: summary.boxes_scanned,
          }, { client });
          const outUid = row.out_uid;

          await syncOutEntryBoxLinks({
            out_uid: outUid,
            userId,
            scanned_boxes: scannedList,
            approved: true,
            entry_type: OUT_ENTRY_TYPE.QC_AREA,
            qc_hold_id,
          }, { client });

          const listMeta = await snapshotMetadataFromBoxUids(scannedList, { includePackingNumbers: true });
          const patchFields = {
            packing_numbers: listMeta.packing_numbers,
            item_codes: listMeta.item_codes,
            qtys: listMeta.qtys,
            total_qty: listMeta.total_qty,
            updated_by: userId,
            updated_at: new Date(),
            scan_complete: summary.scan_complete,
            boxes_required: summary.boxes_required,
            boxes_scanned: summary.boxes_scanned,
            approved: true,
            approved_by: userId,
            approved_at: new Date(),
          };
          await updateOutEntries(patchFields, { out_uid: outUid }, { client });
          return { outUid };
        });

        const data = await findOutEntry({ out_uid: result.outUid });
        await logActivity(req, { action: "create", entity: "out_entry", entity_id: result.outUid });
        return res.status(201).json({
          success: true,
          message: "QC area out completed.",
          data,
        });
      }

      const scanErr = isOutEntryInventoryOut(entry_type)
        ? await validateOutEntryInventoryOutScannedBoxes(scannedList)
        : await validateOutEntryOtherScannedBoxes(scannedList);
      if (scanErr) return res.status(400).json({ success: false, message: scanErr });

      const summary = await getOutEntryOtherScanSummary({ scanned_boxes: scannedList });
      const storedEntryType = isOutEntryInventoryOut(entry_type)
        ? OUT_ENTRY_TYPE.INVENTORY_OUT
        : OUT_ENTRY_TYPE.PACKING_AREA;

      const result = await withTransaction(async (client) => {
        const row = await insertOutEntry({
          entry_type: storedEntryType,
          reason: normalizedReason,
          remarks,
          created_by: userId,
          scan_complete: summary.scan_complete,
          boxes_required: summary.boxes_required,
          boxes_scanned: summary.boxes_scanned,
        }, { client });
        const outUid = row.out_uid;

        await syncOutEntryBoxLinks({
          out_uid: outUid,
          userId,
          scanned_boxes: scannedList,
          approved: true,
          entry_type: storedEntryType,
        }, { client });

        const listMeta = await snapshotMetadataFromBoxUids(scannedList, { includePackingNumbers: true });
        const patchFields = {
          packing_numbers: listMeta.packing_numbers,
          item_codes: listMeta.item_codes,
          qtys: listMeta.qtys,
          total_qty: listMeta.total_qty,
          updated_by: userId,
          updated_at: new Date(),
          scan_complete: summary.scan_complete,
          boxes_required: summary.boxes_required,
          boxes_scanned: summary.boxes_scanned,
          approved: true,
          approved_by: userId,
          approved_at: new Date(),
        };
        await updateOutEntries(patchFields, { out_uid: outUid }, { client });
        return { outUid };
      });

      const data = await findOutEntry({ out_uid: result.outUid });
      await logActivity(req, { action: "create", entity: "out_entry", entity_id: result.outUid });
      return res.status(201).json({
        success: true,
        message: isOutEntryInventoryOut(entry_type)
          ? "Inventory out completed."
          : "Boxes moved to packing area.",
        data,
      });
    }

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

    const result = await withTransaction(async (client) => {
      const row = await insertOutEntry({
        fuid,
        entry_type: "forwarding_note",
        remarks,
        created_by: userId,
        scan_complete: summary.scan_complete,
        boxes_required: summary.boxes_required,
        boxes_scanned: summary.boxes_scanned,
      }, { client });
      const outUid = row.out_uid;

      const willApprove = normalizedApproved === true && summary.scan_complete;
      await syncOutEntryBoxLinks({
        out_uid: outUid,
        userId,
        scanned_boxes: scannedList,
        approved: willApprove,
      }, { client });

      const listMeta = await snapshotMetadataFromBoxUids(scannedList, { includePackingNumbers: true });
      const patchFields = {
        packing_numbers: listMeta.packing_numbers,
        item_codes: listMeta.item_codes,
        qtys: listMeta.qtys,
        total_qty: listMeta.total_qty,
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

      await updateOutEntries(patchFields, { out_uid: outUid }, { client });
      return { outUid };
    });

    const data = await findOutEntry({ out_uid: result.outUid });
    if (data?.fuid) {
      await lockForwardingNoteForOutEntry({ fuid: data.fuid, userId });
    }

    await logActivity(req, { action: "create", entity: "out_entry", entity_id: result.outUid });
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateOutEntry = async (req, res) => {
  try {
    const { out_uid: rawOutUid, fuid, remarks, approved, scanned_boxes, reason, reason_text } = req.body;
    const userId = req.user.id;
    const normalizedApproved = normalizeApprovedInput(approved);

    const out_uid = requireOutUid(res, rawOutUid);
    if (!out_uid) return;

    const existing = await findOutEntry({ out_uid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    if (isOutEntryAutoAuthorized(existing.entry_type)) {
      let nextReason = existing.reason;
      if (reason !== undefined || reason_text !== undefined) {
        const normalizedReason = normalizeOutEntryReasonInput(reason, reason_text);
        if (!normalizedReason) {
          return res.status(400).json({ success: false, message: "Reason is required." });
        }
        nextReason = normalizedReason;
      }

      const fields = {
        remarks: remarks !== undefined ? remarks : existing.remarks,
        reason: nextReason,
        updated_by: userId,
        updated_at: new Date(),
      };
      await updateOutEntries(fields, { out_uid }, { client: null });
      await logActivity(req, { action: "update", entity: "out_entry", entity_id: out_uid });
      return res.json({ success: true, message: "Entry updated." });
    }

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

    const result = await withTransaction(async (client) => {
      if (scansChanged || approvalChanged) {
        await syncOutEntryBoxLinks({
          out_uid,
          userId,
          scanned_boxes: finalScanned,
          approved: willApprove,
        }, { client });
      }

      const listMeta = scansChanged || approvalChanged
        ? await snapshotOutEntryMetadata(out_uid)
        : null;

      const fields = {
        ...(fuid !== undefined && { fuid }),
        ...(remarks !== undefined && { remarks }),
        ...(listMeta && {
          packing_numbers: listMeta.packing_numbers,
          item_codes: listMeta.item_codes,
          qtys: listMeta.qtys,
          total_qty: listMeta.total_qty,
        }),
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

      await updateOutEntries(fields, { out_uid }, { client });
      return { out_uid };
    });

    const data = await findOutEntry({ out_uid: result.out_uid });
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
    const isLocked = Boolean(note.out_entry_locked);

    if (alreadyLinked && isLocked) {
      return res.json({
        success: true,
        message: "Forwarding note already locked for out entry.",
        data: note,
      });
    }

    if (alreadyLinked && !isLocked) {
      const lockResult = await lockForwardingNoteForOutEntry({ fuid, userId });
      if (!lockResult) return res.status(404).json({ success: false, message: "Forwarding Note not found" });
      return res.json({
        success: true,
        message: "Forwarding note locked for out entry.",
        data: lockResult,
      });
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
    const out_uid = requireOutUid(res, req.body?.out_uid);
    if (!out_uid) return;

    const existing = await findOutEntry({ out_uid });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    await withTransaction(async (client) => {
      // Release linked boxes first so they don't remain stuck as out.
      await resetBoxesForOutEntry(out_uid, req.user.id, { client });
      await clearOutEntryDraftScans(out_uid, { client });
      await deleteOutEntries({ out_uid }, { client, deleted_by: req.user.id });
      if (existing.fuid) {
        await unlockForwardingNoteForOutEntry({ fuid: existing.fuid }, { client });
      }
    });

    await logActivity(req, { action: "delete", entity: "out_entry", entity_id: out_uid, record: existing });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntryReasonsViews = async (req, res) => {
  try {
    const { search, limit } = req.body || {};
    const rows = await findDistinctOutEntryReasons({ search, limit });
    res.json({
      success: true,
      data: (rows || []).map((r) => ({
        id: r.reason,
        reason: r.reason,
        last_used_at: r.last_used_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntriesViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, sortBy, order, search } = extractListParams(req.body, { sortBy: "out_uid", order: "DESC" });

    if (id) {
      const parsedId = parsePositiveIntId(id);
      if (!parsedId) return res.status(400).json({ success: false, message: "Valid out_uid required" });
      const data = await findOutEntry({ out_uid: parsedId });
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
    return res.status(200).json({
      success: true,
      message: "Server reached successfully",
      received: req.body,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

export const batchScanOutEntryBoxes = async (req, res) => {
  try {
    const { fuid, entry_type: rawEntryType, for_out_uid, items, session_scanned } = req.body;
    const entry_type = normalizeOutEntryType(rawEntryType);

    if (isOutEntryInventoryOut(entry_type) || isOutEntryPackingArea(entry_type) || isOutEntryQcArea(entry_type)) {
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

      if (isOutEntryQcArea(entry_type)) {
        const holdId = Number(req.body.qc_hold_id);
        if (!Number.isFinite(holdId) || holdId <= 0) {
          return res.status(400).json({ success: false, message: "qc_hold_id is required" });
        }
        const { results } = await resolveOutEntryQcAreaBatchScan({
          holdId,
          items: scanItems,
          session_scanned: Array.isArray(session_scanned) ? session_scanned : [],
        });
        return res.json({ success: true, results });
      }

      const { results } = isOutEntryInventoryOut(entry_type)
        ? await resolveOutEntryInventoryOutBatchScan({
            forOutUid,
            items: scanItems,
            session_scanned: Array.isArray(session_scanned) ? session_scanned : [],
          })
        : await resolveOutEntryOtherBatchScan({
            forOutUid,
            items: scanItems,
            session_scanned: Array.isArray(session_scanned) ? session_scanned : [],
          });
      return res.json({ success: true, results });
    }

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
  }
};

export const getQcHoldDetailsForOutEntry = async (req, res) => {
  try {
    const { qc_hold_id, for_out_uid } = req.body;
    const holdId = Number(qc_hold_id);
    if (!Number.isFinite(holdId) || holdId <= 0) {
      return res.status(400).json({ success: false, message: "qc_hold_id required" });
    }

    const forOutUidParsed =
      for_out_uid !== undefined && for_out_uid !== null && String(for_out_uid).trim() !== ""
        ? Number(for_out_uid)
        : null;
    const forOutUid = Number.isFinite(forOutUidParsed) ? forOutUidParsed : null;

    const data = await findQcHoldDetailsForOutEntry(holdId, forOutUid);
    if (!data) return res.status(404).json({ success: false, message: "QC hold not found" });

    const [holdMeta] = await enrichQcHoldListRows([
      {
        hold_id: data.hold_id,
        packing_number: data.packing_number,
        item_dcode: data.item_dcode,
        hold_data: { balance_qty: data.hold_balance_qty, qty: data.hold_balance_qty },
      },
    ]);

    res.json({
      success: true,
      data: {
        ...data,
        item_code: holdMeta?.item_code ?? null,
        item_desc: holdMeta?.item_desc ?? null,
        balance_qty: holdMeta?.balance_qty ?? data.hold_balance_qty,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutEntryLinkedBoxesController = async (req, res) => {
  try {
    const out_uid = requireOutUid(res, req.body?.out_uid);
    if (!out_uid) return;
    const boxes = await findOutEntryLinkedBoxes(out_uid);
    res.json({ success: true, data: boxes || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
