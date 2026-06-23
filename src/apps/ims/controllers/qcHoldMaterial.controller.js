import { findQcHoldMaterials, findQcHoldMaterialById, findActiveQcHoldParents, insertQcHoldMaterial, updateQcHoldMaterial, softDeleteQcHoldMaterial, findDistinctQcHoldReasons } from "../models/qcHoldMaterial.model.js";
import { withTransaction } from "../../../config/db.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../../core/utils/approval.js";
import { logActivity } from "../../core/utils/logActivity.js";
import { resolveQcHoldPackingMeta } from "../utils/qc-hold-material/qcHoldPackingMeta.js";
import { enrichHoldScannedBoxes, enrichQcHoldListRows } from "../utils/qc-hold-material/qcHoldList.js";
import { VALID_SUBMISSION_TYPES, normalizeSubmissionType, normalizeQcHoldStatus, validateSubmissionQuantities } from "../utils/qc-hold-material/qcHoldSubmission.js";
import { findBoxByUidOrNoUid } from "../models/box.model.js";
import { isBoxSellable, isBoxOnQcHold } from "../utils/box/boxInventory.js";
import { applyQcHoldToBoxes, countRevertableBoxesForHold, expandFullHoldBoxesForPacking, normalizeHoldScanMode, QC_HOLD_SCAN_FULL, QC_HOLD_SCAN_PARTIAL, releaseQcHoldFromBoxes, releaseQcHoldRevertTx, resolveHoldBoxUids, syncQcHoldBoxStock, validateBoxesForHold } from "../utils/qc-hold-material/qcHoldBoxStock.js";
import { createQcHoldCompletionBoxesTx, consumeQcHoldSourceBoxesTx, consumeQcHoldSourceQtyTx, listQcHoldCompletionBoxes, listQcHoldPrintStickers, activateQcHoldCompletionBoxesTx, softDeletePendingQcHoldCompletionBoxesTx, softDeleteQcHoldCompletionBoxesByHoldTx, ensureQcHoldSubmissionCompletionBoxesTx } from "../utils/qc-hold-material/qcHoldCompletionPacking.js";
import { parseBoxUidList } from "../utils/qc-hold-material/qcHoldBalances.js";
import { appendSubmission, approveSubmissionInData, buildHoldDataPatch, buildPendingHoldData, clearHoldBoxesFromHoldData, deriveStatusFromHoldData, findSubmissionById, hasPendingSubmission, listSubmissions, parseHoldData, patchSubmissionCompletedBoxes, removeBoxesFromHoldData, rollupHoldDataAfterApproval, submissionToApi } from "../utils/qc-hold-material/qcHoldData.js";
import { QC_HOLD_MSG, qcHoldBoxBelongsToPacking } from "../constants/qcHoldMaterial.messages.js";
import { parsePositiveIntId } from "../../core/utils/parseId.js";

const CFG = getCrudModuleConfig("qc_hold_material");

function mapCompletionStickers(completionBoxes = []) {
  return (completionBoxes || []).map((row, idx) => ({
    box_uid: row.box_uid,
    box_no_uid: row.box_no_uid,
    packing_number: row.packing_number,
    qty: Number(row.qty) || 0,
    is_loose: !!row.is_loose,
    box_no: idx + 1,
    total_boxes: completionBoxes.length,
    unit: "PCS",
  }));
}

export const getQcHoldPackingMeta = async (req, res) => {
  try {
    const { packing_number } = req.body || {};
    const meta = await resolveQcHoldPackingMeta(packing_number);
    if (!meta) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.PACKING_NUMBER_REQUIRED });
    }
    res.json({ success: true, data: meta });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const verifyQcHoldBox = async (req, res) => {
  try {
    const { box_no_uid, packing_number, hold_id, full_hold_resolve } = req.body || {};
    const code = String(box_no_uid ?? "").trim();
    if (!code) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.BOX_NO_UID_REQUIRED });
    }
    const box = await findBoxByUidOrNoUid(code);
    if (!box || box.is_deleted) {
      return res.status(404).json({ success: false, message: QC_HOLD_MSG.BOX_NOT_FOUND });
    }
    const resolvePackingOnly =
      full_hold_resolve === true || String(full_hold_resolve).toLowerCase() === "true";
    const editHoldId = hold_id != null ? parseInt(hold_id, 10) : null;
    if (!resolvePackingOnly && !isBoxSellable(box)) {
      if (isBoxOnQcHold(box) && editHoldId && Number(box.qc_hold_id) === editHoldId) {
        // allow re-scan while editing same hold
      } else if (isBoxOnQcHold(box)) {
        return res.status(400).json({ success: false, message: QC_HOLD_MSG.BOX_ALREADY_ON_QC_HOLD });
      } else {
        return res.status(400).json({ success: false, message: QC_HOLD_MSG.BOX_NOT_IN_STORE_INVENTORY });
      }
    }
    const pn = String(packing_number ?? "").trim();
    const boxPn = String(box.packing_number ?? "").trim();
    if (pn && boxPn && pn !== boxPn) {
      return res.status(400).json({
        success: false,
        message: qcHoldBoxBelongsToPacking(boxPn, pn),
      });
    }
    const meta = boxPn ? await resolveQcHoldPackingMeta(boxPn) : null;
    res.json({
      success: true,
      data: {
        box_no_uid: box.box_no_uid,
        box_uid: box.box_uid,
        packing_number: boxPn,
        qty: Number(box.qty) || 0,
        itemdcode: box.itemdcode ?? meta?.itemdcode ?? null,
        location_no: box.location_no ?? meta?.store_in_location ?? null,
        packing_meta: meta,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcHoldMaterials = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "hold_id",
      order: "DESC",
    });
    const result = await findQcHoldMaterials({
      page,
      limit,
      filters: sanitizeFilters(filters, CFG.filterFields),
      sort: { by: sortBy, order },
      search: sanitizeSearch(search),
      permission: req.permission,
    });
    const enriched = await enrichQcHoldListRows(result.data || []);
    res.json({ success: true, ...result, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getActiveQcHoldParents = async (req, res) => {
  try {
    const search = sanitizeSearch(req.body?.search);
    const requireInStoreBoxes = req.body?.require_in_store_boxes === true;
    const rows = await findActiveQcHoldParents(search, { requireInStoreBoxes });
    const enriched = await enrichQcHoldListRows(rows);
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcHoldMaterialById = async (req, res) => {
  try {
    const pk = parsePositiveIntId(req.body?.hold_id ?? req.body?.id);
    if (!pk) return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_REQUIRED });
    const row = await findQcHoldMaterialById(pk);
    if (!row) return res.status(404).json({ success: false, message: QC_HOLD_MSG.NOT_FOUND });
    const [enriched] = await enrichQcHoldListRows([row]);
    const submissions = listSubmissions(row.hold_data).map((s) => submissionToApi(s, pk));
    const scanned_boxes = await enrichHoldScannedBoxes(enriched);
    res.json({ success: true, data: { ...enriched, submissions, scanned_boxes } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const expandQcHoldFullBoxes = async (req, res) => {
  try {
    const { packing_number } = req.body || {};
    const pn = String(packing_number ?? "").trim();
    if (!pn) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.PACKING_NUMBER_REQUIRED });
    }
    const boxes = await expandFullHoldBoxesForPacking(pn);
    if (!boxes.length) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.NO_SELLABLE_BOXES_FOR_PACKING });
    }
    const meta = await resolveQcHoldPackingMeta(pn);
    res.json({
      success: true,
      data: {
        packing_number: pn,
        boxes,
        packing_meta: meta,
        total_boxes: boxes.length,
        total_qty: boxes.reduce((s, b) => s + (Number(b.qty) || 0), 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createQcHoldMaterial = async (req, res) => {
  try {
    const { packing_number, item_dcode, qty, remarks, reason, scanned_box_uids, hold_scan_mode } = req.body;

    const rawScanMode = String(hold_scan_mode ?? "").trim().toLowerCase();
    const scanMode = normalizeHoldScanMode(hold_scan_mode);
    if (rawScanMode === QC_HOLD_SCAN_PARTIAL && scanMode !== QC_HOLD_SCAN_PARTIAL) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.PARTIAL_HOLD_DISABLED });
    }
    let boxUids = parseBoxUidList(scanned_box_uids);
    const resolvedPacking = packing_number != null ? String(packing_number).trim() : "";
    const resolvedItem = item_dcode != null ? parseInt(item_dcode, 10) : null;
    let qtyNum = qty != null ? parseInt(qty, 10) : 0;

    if (!resolvedPacking && boxUids.length === 0) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.SCAN_BOX_OR_PACKING });
    }
    if (!resolvedItem && boxUids.length === 0) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.ITEM_REQUIRED });
    }
    if (!qtyNum || qtyNum < 1) {
      if (boxUids.length > 0) {
        let sum = 0;
        for (const uid of boxUids) {
          const box = await findBoxByUidOrNoUid(uid);
          if (box?.qty) sum += Number(box.qty) || 0;
        }
        qtyNum = sum;
      }
    }
    if (!qtyNum || qtyNum < 1) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.VALID_QTY_REQUIRED });
    }
    if (!String(reason ?? "").trim()) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.REASON_REQUIRED });
    }

    const resolvedPackingForExpand =
      resolvedPacking || (boxUids.length ? String((await findBoxByUidOrNoUid(boxUids[0]))?.packing_number ?? "").trim() : "");
    boxUids = await resolveHoldBoxUids({
      holdScanMode: scanMode,
      scannedUids: boxUids,
      packingNumber: resolvedPackingForExpand,
    });
    if (!boxUids.length) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.NO_BOXES_TO_HOLD });
    }

    const validationError = await validateBoxesForHold(boxUids, { packingNumber: resolvedPackingForExpand });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (scanMode === QC_HOLD_SCAN_FULL || boxUids.length > 0) {
      let sum = 0;
      for (const uid of boxUids) {
        const box = await findBoxByUidOrNoUid(uid);
        if (box?.qty) sum += Number(box.qty) || 0;
      }
      if (sum > 0) qtyNum = sum;
    }

    const userId = req.user?.id ?? null;
    const payload = {
      packing_number: resolvedPacking || resolvedPackingForExpand || null,
      item_dcode: resolvedItem,
      remarks: remarks != null ? String(remarks).trim() : null,
      reason: String(reason).trim(),
      status: "pending",
      hold_data: buildPendingHoldData({ boxes: boxUids, qty: qtyNum, hold_scan_mode: scanMode }),
      approved: true,
      approved_by: userId,
      approved_at: new Date(),
      created_by: userId,
    };

    const created = await insertQcHoldMaterial(payload);
    await applyQcHoldToBoxes(created.hold_id, boxUids, { userId });

    await logActivity(req, {
      action: "create",
      entity: "qc_hold_material",
      entity_id: created.hold_id,
      record: created,
    });
    
    const [enriched] = await enrichQcHoldListRows([created]);
    res.json({ success: true, data: enriched, message: QC_HOLD_MSG.PENDING_HOLD_SAVED });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const submitQcHoldMaterial = async (req, res) => {
  try {
    const { hold_id, submission_type, completed_qty, rejected_qty, remarks, reason } = req.body;

    const pk = hold_id != null ? parseInt(hold_id, 10) : null;
    if (!pk) return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_REQUIRED });

    const rawType = String(submission_type ?? "").trim().toLowerCase();
    if (!VALID_SUBMISSION_TYPES.has(rawType)) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.SUBMISSION_TYPE_INVALID });
    }
    const type = normalizeSubmissionType(rawType);
    if (rawType === "partial" && type !== "partial") {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.PARTIAL_SUBMIT_DISABLED });
    }
    if (!String(reason ?? "").trim()) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.REASON_REQUIRED });
    }

    const hold = await findQcHoldMaterialById(pk);
    if (!hold) return res.status(404).json({ success: false, message: QC_HOLD_MSG.HOLD_NOT_FOUND });

    const holdData = parseHoldData(hold.hold_data);
    if (holdData.hold_type !== "pending_hold") {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.ONLY_PENDING_CAN_SUBMIT });
    }

    const [enrichedHold] = await enrichQcHoldListRows([hold]);
    const balanceQty = Number(enrichedHold.balance_qty) || 0;
    if (balanceQty <= 0) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.NO_BALANCE_LEFT });
    }
    if (hasPendingSubmission(hold.hold_data)) {
      return res.status(400).json({
        success: false,
        message: QC_HOLD_MSG.SUBMISSION_ALREADY_AWAITING,
      });
    }

    let finalCompletedQty = Math.max(0, parseInt(completed_qty, 10) || 0);
    let rejectedQtyNum = Math.max(0, parseInt(rejected_qty, 10) || 0);

    if (type === "revert") {
      finalCompletedQty = balanceQty;
      rejectedQtyNum = 0;
      const revertableBoxes = await countRevertableBoxesForHold(pk, holdData.boxes);
      if (revertableBoxes <= 0) {
        return res.status(400).json({ success: false, message: QC_HOLD_MSG.REVERT_NO_BOXES_ON_HOLD });
      }
    } else if (type === "full") {
      rejectedQtyNum = Math.max(0, balanceQty - finalCompletedQty);
    } else {
      rejectedQtyNum = 0;
    }

    const qtyError = validateSubmissionQuantities({
      type,
      balanceQty,
      completedQty: finalCompletedQty,
      rejectedQty: rejectedQtyNum,
    });
    if (qtyError) {
      return res.status(400).json({ success: false, message: qtyError });
    }

    const { holdData: nextHoldData, submission } = appendSubmission(
      hold.hold_data,
      {
        submission_type: type,
        completed_box_uids: [],
        completed_qty: finalCompletedQty,
        completed_boxes: 0,
        rejected_qty: rejectedQtyNum,
        rejected_boxes: 0,
        remarks: remarks != null ? String(remarks).trim() : null,
        reason: String(reason).trim(),
      },
      req.user?.id ?? null
    );

    await updateQcHoldMaterial(pk, {
      hold_data: nextHoldData,
      updated_by: req.user?.id ?? null,
      updated_at: new Date(),
    });

    const apiSubmission = submissionToApi(submission, pk);
    await logActivity(req, {
      action: "submit",
      entity: "qc_hold_material",
      entity_id: pk,
      record: apiSubmission,
    });

    res.json({
      success: true,
      data: apiSubmission,
      message: QC_HOLD_MSG.SUBMITTED_AWAITING_APPROVAL,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const approveQcHoldSubmissionController = async (req, res) => {
  try {
    const { submission_id, hold_id, completed_qty, rejected_qty, reason, remarks } = req.body;
    let hold = null;
    let submission = null;

    if (hold_id) {
      hold = await findQcHoldMaterialById(hold_id);
      if (hold) {
        const pending = listSubmissions(hold.hold_data, { pendingOnly: true });
        submission = submission_id
          ? pending.find((s) => Number(s.submission_id) === Number(submission_id))
            || findSubmissionById(hold.hold_data, submission_id)
          : pending[0] || null;
      }
    } else if (submission_id) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_WITH_SUBMISSION_REQUIRED });
    }

    if (!hold || !submission) {
      return res.status(404).json({ success: false, message: QC_HOLD_MSG.NO_PENDING_SUBMISSION });
    }
    if (submission.approved) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.SUBMISSION_ALREADY_APPROVED });
    }

    const type = String(submission.submission_type ?? "").trim().toLowerCase();
    if (!VALID_SUBMISSION_TYPES.has(type)) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.INVALID_SUBMISSION_TYPE });
    }

    const finalReason =
      reason !== undefined ? String(reason ?? "").trim() : String(submission.reason ?? "").trim();
    if (!finalReason) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.REASON_REQUIRED });
    }

    const finalRemarks =
      remarks !== undefined
        ? remarks != null
          ? String(remarks).trim()
          : null
        : submission.remarks != null
          ? String(submission.remarks).trim()
          : null;

    const [enrichedHold] = await enrichQcHoldListRows([hold]);
    const balanceQty = Number(enrichedHold.balance_qty) || 0;

    let finalCompletedQty =
      completed_qty !== undefined
        ? Math.max(0, parseInt(completed_qty, 10) || 0)
        : Number(submission.completed_qty) || 0;
    let finalRejectedQty =
      rejected_qty !== undefined
        ? Math.max(0, parseInt(rejected_qty, 10) || 0)
        : Number(submission.rejected_qty) || 0;

    if (type === "revert") {
      finalCompletedQty = balanceQty;
      finalRejectedQty = 0;
    } else if (type === "full") {
      finalRejectedQty = Math.max(0, balanceQty - finalCompletedQty);
    } else {
      finalRejectedQty = 0;
    }

    const qtyError = validateSubmissionQuantities({
      type,
      balanceQty,
      completedQty: finalCompletedQty,
      rejectedQty: finalRejectedQty,
    });
    if (qtyError) {
      return res.status(400).json({ success: false, message: qtyError });
    }

    const patch = {
      completed_qty: finalCompletedQty,
      completed_boxes: 0,
      rejected_qty: finalRejectedQty,
      rejected_boxes: 0,
      reason: finalReason,
      remarks: finalRemarks,
    };

    const approvedResult = approveSubmissionInData(
      hold.hold_data,
      submission.submission_id,
      req.user?.id ?? null,
      patch
    );
    if (!approvedResult) {
      return res.status(404).json({ success: false, message: QC_HOLD_MSG.COULD_NOT_APPROVE_SUBMISSION });
    }

    const userId = req.user?.id ?? null;
    const sourceBoxUids = parseHoldData(hold.hold_data).boxes;

    let updatedHold;
    let completionBoxes = [];
    let packingConfig = null;
    let approvedSubmission = approvedResult.submission;

    try {
      ({ updatedHold, completionBoxes, packingConfig, approvedSubmission } = await withTransaction(async (client) => {
        if (type === "revert") {
          await softDeleteQcHoldCompletionBoxesByHoldTx(client, {
            holdId: hold.hold_id,
            userId,
          });

          const released = await releaseQcHoldRevertTx(client, {
            holdId: hold.hold_id,
            userId,
            sourceBoxUids,
          });
          if (!released.released) {
            const err = new Error(QC_HOLD_MSG.REVERT_NO_BOXES_ON_HOLD);
            err.statusCode = 400;
            throw err;
          }

          const revertedBoxUids = (released.boxes || [])
            .map((b) => String(b.box_no_uid ?? b.box_uid ?? "").trim())
            .filter(Boolean);

          const submissionWithBoxes = {
            ...approvedResult.submission,
            completed_qty: finalCompletedQty,
            completed_boxes: revertedBoxUids.length,
            completed_box_uids: revertedBoxUids,
            rejected_qty: 0,
            rejected_boxes: 0,
          };

          let nextHoldData = patchSubmissionCompletedBoxes(
            approvedResult.holdData,
            submission.submission_id,
            {
              boxUids: revertedBoxUids,
              completedBoxes: revertedBoxUids.length,
            }
          );
          nextHoldData = rollupHoldDataAfterApproval(nextHoldData, submissionWithBoxes);
          nextHoldData = clearHoldBoxesFromHoldData(nextHoldData);

          const row = await updateQcHoldMaterial(hold.hold_id, {
            hold_data: nextHoldData,
            status: "complete",
            updated_by: userId,
            updated_at: new Date(),
          });

          return {
            updatedHold: row,
            completionBoxes: released.boxes || [],
            packingConfig: null,
            approvedSubmission: submissionWithBoxes,
          };
        }

        let completionResult = {
          boxes: [],
          boxUids: [],
          completed_boxes: 0,
          packing_config: null,
        };

        if (finalCompletedQty > 0) {
          const pendingSubmission = findSubmissionById(approvedResult.holdData, submission.submission_id);
          const pendingUids = Array.isArray(pendingSubmission?.completed_box_uids)
            ? pendingSubmission.completed_box_uids.map((v) => String(v).trim()).filter(Boolean)
            : [];

          if (pendingUids.length > 0) {
            completionResult = await activateQcHoldCompletionBoxesTx(client, {
              holdId: hold.hold_id,
              boxUids: pendingUids,
              userId,
            });
            if (!completionResult.boxes?.length) {
              const err = new Error("Could not activate completion stickers for this submission.");
              err.statusCode = 400;
              throw err;
            }
          } else {
            completionResult = await createQcHoldCompletionBoxesTx(client, {
              hold,
              completedQty: finalCompletedQty,
              userId,
              pendingUntilApproval: false,
            });
          }
        }

        const submissionWithBoxes = {
          ...approvedResult.submission,
          completed_boxes: completionResult.completed_boxes,
          completed_box_uids: completionResult.boxUids,
        };

        let nextHoldData = patchSubmissionCompletedBoxes(
          approvedResult.holdData,
          submission.submission_id,
          {
            boxUids: completionResult.boxUids,
            completedBoxes: completionResult.completed_boxes,
          }
        );
        nextHoldData = rollupHoldDataAfterApproval(nextHoldData, submissionWithBoxes);
        const status = deriveStatusFromHoldData(nextHoldData);

        if (finalCompletedQty > 0) {
          const consumeResult = await consumeQcHoldSourceQtyTx(client, {
            holdId: hold.hold_id,
            sourceBoxUids,
            completedQty: finalCompletedQty,
            userId,
          });
          if (!consumeResult.consumedUids?.length) {
            const err = new Error(
              "Approved quantity could not be removed from QC hold source boxes. Check hold box list and try again."
            );
            err.statusCode = 400;
            throw err;
          }
          nextHoldData = removeBoxesFromHoldData(nextHoldData, consumeResult.consumedUids);
        }

        if (status === "complete") {
          const remainingUids = parseHoldData(nextHoldData).boxes;
          if (remainingUids.length) {
            await consumeQcHoldSourceBoxesTx(client, {
              holdId: hold.hold_id,
              sourceBoxUids: remainingUids,
              userId,
            });
            nextHoldData = removeBoxesFromHoldData(nextHoldData, remainingUids);
          }
        }

        const row = await updateQcHoldMaterial(hold.hold_id, {
          hold_data: nextHoldData,
          status,
          updated_by: userId,
          updated_at: new Date(),
        });

        return {
          updatedHold: row,
          completionBoxes: completionResult.boxes,
          packingConfig: completionResult.packing_config,
          approvedSubmission: submissionWithBoxes,
        };
      }));
    } catch (err) {
      const code = err?.statusCode === 400 ? 400 : 500;
      return res.status(code).json({ success: false, message: err.message });
    }

    const apiSubmission = submissionToApi(approvedSubmission, hold.hold_id);
    await logActivity(req, {
      action: "approve",
      entity: "qc_hold_material",
      entity_id: hold.hold_id,
      record: { submission: apiSubmission, hold: updatedHold },
    });

    const [enriched] = await enrichQcHoldListRows([updatedHold]);
    const completion_stickers = mapCompletionStickers(completionBoxes);

    res.json({
      success: true,
      data: {
        hold: enriched,
        submission: apiSubmission,
        completion_stickers,
        packing_config: packingConfig,
      },
      message: type === "revert" ? QC_HOLD_MSG.REVERT_APPROVED : QC_HOLD_MSG.SUBMISSION_APPROVED,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcHoldCompletionBoxes = async (req, res) => {
  try {
    const { hold_id, submission_id } = req.body || {};
    const pk = hold_id != null ? parseInt(hold_id, 10) : null;
    if (!pk) {
      return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_REQUIRED });
    }

    let hold = await findQcHoldMaterialById(pk);
    if (!hold) {
      return res.status(404).json({ success: false, message: QC_HOLD_MSG.NOT_FOUND });
    }

    let submission = submission_id
      ? findSubmissionById(hold.hold_data, submission_id)
      : null;
    if (!submission) {
      const pending = listSubmissions(hold.hold_data, { pendingOnly: true });
      submission = pending[0] || null;
    }
    if (!submission) {
      const approved = listSubmissions(hold.hold_data, { approvedOnly: true });
      submission = approved.length ? approved[approved.length - 1] : null;
    }

    const userId = req.user?.id ?? null;
    let packingConfig = null;

    if (submission && (Number(submission.completed_qty) || 0) > 0) {
      const submissionType = String(submission.submission_type ?? "").trim().toLowerCase();
      if (submissionType !== "revert") {
        try {
          const ensured = await withTransaction(async (client) =>
            ensureQcHoldSubmissionCompletionBoxesTx(client, { hold, submission, userId })
          );
          packingConfig = ensured.packing_config;
          if (ensured.holdData) {
            hold = await updateQcHoldMaterial(pk, {
              hold_data: ensured.holdData,
              updated_by: userId,
              updated_at: new Date(),
            });
            submission = findSubmissionById(hold.hold_data, submission.submission_id);
          }
        } catch (err) {
          const code = err?.statusCode === 400 ? 400 : 500;
          return res.status(code).json({ success: false, message: err.message });
        }
      }
    }

    const [enriched] = await enrichQcHoldListRows([hold]);
    const boxes = await listQcHoldPrintStickers({ hold, submission });
    const packingMeta = hold.packing_number
      ? await resolveQcHoldPackingMeta(hold.packing_number)
      : null;

    res.json({
      success: true,
      data: {
        hold: enriched,
        submission: submission ? submissionToApi(submission, pk) : null,
        boxes,
        packing_meta: packingMeta,
        packing_config: packingConfig,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateQcHoldMaterialController = async (req, res) => {
  try {
    const { id, hold_id, packing_number, item_dcode, qty, remarks, reason, status, approved, scanned_box_uids, hold_scan_mode } = req.body;
    const pk = hold_id ?? id;
    if (!pk) return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_REQUIRED });

    const existing = await findQcHoldMaterialById(pk);
    if (!existing) return res.status(404).json({ success: false, message: QC_HOLD_MSG.NOT_FOUND });

    const payload = {
      updated_by: req.user?.id ?? null,
      updated_at: new Date(),
    };

    if (packing_number !== undefined) payload.packing_number = String(packing_number).trim();
    if (item_dcode !== undefined) payload.item_dcode = parseInt(item_dcode, 10);
    if (remarks !== undefined) payload.remarks = remarks != null ? String(remarks).trim() : null;
    if (reason !== undefined) {
      if (!String(reason).trim()) {
        return res.status(400).json({ success: false, message: QC_HOLD_MSG.REASON_REQUIRED });
      }
      payload.reason = String(reason).trim();
    }
    if (status !== undefined) payload.status = normalizeQcHoldStatus(status, existing.status);

    const holdDataPatch = {};
    const prevHoldData = parseHoldData(existing.hold_data);
    const prevBoxUids = [...(prevHoldData.boxes || [])];

    if (hold_scan_mode !== undefined) {
      holdDataPatch.hold_scan_mode = normalizeHoldScanMode(hold_scan_mode, {
        legacyMode: prevHoldData.hold_scan_mode,
      });
    }
    if (qty !== undefined) {
      const qtyNum = parseInt(qty, 10);
      if (!qtyNum || qtyNum < 1) {
        return res.status(400).json({ success: false, message: QC_HOLD_MSG.VALID_QTY_REQUIRED });
      }
      holdDataPatch.qty = qtyNum;
    }
    if (scanned_box_uids !== undefined) {
      let boxUids = parseBoxUidList(scanned_box_uids);
      const scanMode = normalizeHoldScanMode(hold_scan_mode ?? prevHoldData.hold_scan_mode, {
        legacyMode: prevHoldData.hold_scan_mode,
      });
      const pn =
        payload.packing_number ??
        existing.packing_number ??
        (boxUids.length ? String((await findBoxByUidOrNoUid(boxUids[0]))?.packing_number ?? "").trim() : "");
      boxUids = await resolveHoldBoxUids({
        holdScanMode: scanMode,
        scannedUids: boxUids,
        packingNumber: pn,
      });
      const validationError = await validateBoxesForHold(boxUids, { holdId: pk, packingNumber: pn });
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }
      holdDataPatch.boxes = boxUids;
      holdDataPatch.total_boxes = boxUids.length;
      holdDataPatch.hold_scan_mode = scanMode;
      if (qty === undefined && boxUids.length > 0) {
        let sum = 0;
        for (const uid of boxUids) {
          const box = await findBoxByUidOrNoUid(uid);
          if (box?.qty) sum += Number(box.qty) || 0;
        }
        if (sum > 0) holdDataPatch.qty = sum;
      }
    }
    if (Object.keys(holdDataPatch).length) {
      payload.hold_data = buildHoldDataPatch(existing.hold_data, holdDataPatch);
    }

    if (approved !== undefined) {
      const normalizedApproved = normalizeApprovedInput(approved);
      payload.approved = normalizedApproved;
      applyApprovalWorkflow({
        req,
        fields: payload,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: true,
      });
    }

    const updated = await updateQcHoldMaterial(pk, payload);

    if (scanned_box_uids !== undefined) {
      const nextBoxUids = holdDataPatch.boxes || prevBoxUids;
      await syncQcHoldBoxStock(pk, prevBoxUids, nextBoxUids, { userId: req.user?.id ?? null });
    }
    if (payload.status === "complete") {
      await releaseQcHoldFromBoxes(pk);
    }

    await logActivity(req, {
      action: "update",
      entity: "qc_hold_material",
      entity_id: pk,
      record: updated,
    });
    const [enriched] = await enrichQcHoldListRows([updated]);
    res.json({ success: true, data: enriched, message: QC_HOLD_MSG.QC_HOLD_UPDATED });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteQcHoldMaterialController = async (req, res) => {
  try {
    const { id, hold_id } = req.body;
    const pk = hold_id ?? id;
    if (!pk) return res.status(400).json({ success: false, message: QC_HOLD_MSG.HOLD_ID_REQUIRED });

    const deleted = await softDeleteQcHoldMaterial(pk, req.user?.id ?? null);
    if (!deleted) return res.status(404).json({ success: false, message: QC_HOLD_MSG.NOT_FOUND });

    await withTransaction(async (client) => {
      await softDeletePendingQcHoldCompletionBoxesTx(client, {
        holdId: pk,
        userId: req.user?.id ?? null,
      });
    });
    await releaseQcHoldFromBoxes(pk);

    await logActivity(req, {
      action: "delete",
      entity: "qc_hold_material",
      entity_id: pk,
    });
    res.json({ success: true, message: QC_HOLD_MSG.QC_HOLD_DELETED });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcHoldReasonsViews = async (req, res) => {
  try {
    const { search, limit } = req.body || {};
    const rows = await findDistinctQcHoldReasons({ search, limit });
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
