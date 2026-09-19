import { findAdjustments, findAdjustmentById, insertAdjustment, updateAdjustment, softDeleteAdjustment } from "../models/stockAdjustment.model.js";
import { computeMrnQtyBudget } from "../utils/mrnQtyBudget.js";
import { applyStockAdjustmentOnApprove, syncStockAdjustmentAddCoils, revertStockAdjustmentOnUnapprove, parseRemovedCoilUids, buildRemovedCoilUidsJson, assertSaAddCoilsUnusedForEdit, needsSaAddCoilResync, shouldSyncStockAdjustmentAddCoils } from "../utils/apply/stockAdjustmentApply.js";
import { findActiveCoilsForMinus } from "../utils/minusCoilLookup.js";
import { findCoilsBySaId, findCoilsBySaIdWithMrn, findCoilByUid } from "../../coil/models/coil.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { getMrnCoilQtyAutoCalc } from "../../../../core/configuration/models/appConfig.model.js";
import { resolveAddCoilQtys, assertCoilQtysMatchTotal, parseStoredCoilQtys, roundSaQty, QTY_EPS } from "../utils/stockAdjustmentQty.js";
import { resolveEffectiveHeatNo } from "../utils/stockAdjustmentHeatNo.js";
import { normalizeSaEntryType, isSaAddLikeEntryType, saEntryTypeNeedsFinancialYear, isSaLotGateEntryType, assertSaGateMetaFields, saMetaFieldsForSave, parseSaGateMeta } from "../utils/stockAdjustmentEntryTypes.js";
import { requireAuthorizedRmSpecForItem } from "../../spec/models/specMaster.model.js";
import {
  buildPendingAddPreviewCoils,
  assertScannedCoilsForSaApprove,
  getExpectedSaApproveScanUids,
} from "../utils/stockAdjustmentPreviewCoils.js";
import { isCoilAvailableForSaMinus } from "../../../lib/utils/saMinusInventory.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";
import { applyRmMasterLabels, enrichRmMasterRows } from "../../production/utils/erpItems.js";
const MODULE = "rm_stock_adjustment";
const log = createRmstoreActivityLogger(MODULE);

function saCoilsEntryType(entryType) {
  return String(entryType || "").toLowerCase() === "minus" ? "stock_out" : "stock_in";
}

/** True when update body carries field edits (not approve/unapprove/scan flag alone). */
function hasSaEditPayload(body = {}) {
  const skip = new Set([
    "adjustment_id",
    "id",
    "approved",
    "approved_by",
    "approved_at",
    "scanned_coils",
    "scannedCoils",
  ]);
  return Object.keys(body).some((k) => !skip.has(k) && body[k] !== undefined);
}

async function loadAdjustmentCoils(row) {
  const entryType = String(row?.entry_type || "").toLowerCase();

  if (isSaAddLikeEntryType(entryType)) {
    let dbCoils = await findCoilsBySaIdWithMrn(row.adjustment_id, "stock_in");
    if (!dbCoils.length && !row?.approved) {
      try {
        await syncStockAdjustmentAddCoils({
          adjustment: row,
          userName: row.updated_by || row.created_by || "system",
          userId: null,
        });
        dbCoils = await findCoilsBySaIdWithMrn(row.adjustment_id, "stock_in");
      } catch {
        /* fall back to preview below */
      }
    }
    if (dbCoils.length) return dbCoils;
  }

  if (!row?.approved) {
    if (entryType === "minus") {
      return (
        await Promise.all(parseRemovedCoilUids(row.removed_coil_uids).map((uid) => findCoilByUid(uid)))
      ).filter(Boolean);
    }
    return buildPendingAddPreviewCoils(row);
  }

  return findCoilsBySaIdWithMrn(row.adjustment_id, saCoilsEntryType(entryType));
}

function normalizeEntryType(raw) {
  return normalizeSaEntryType(raw);
}

function normalizeMrnMetaFields(body = {}) {
  const bill_no =
    body?.bill_no != null && String(body.bill_no).trim() !== ""
      ? String(body.bill_no).trim()
      : null;
  const bill_dt = body?.bill_dt ?? body?.billdt ?? null;
  const mrn_dt = body?.mrn_dt ?? body?.mrndt ?? null;
  return {
    bill_no,
    bill_dt: bill_dt != null && String(bill_dt).trim() !== "" ? bill_dt : null,
    mrn_dt: mrn_dt != null && String(mrn_dt).trim() !== "" ? mrn_dt : null,
  };
}

async function assertAddQtyWithinMrnLimit({
  mrn_uid,
  receiptQty,
  resolvedTotal,
  excludeAdjustmentId = null,
}) {
  const uid = String(mrn_uid || "").trim();
  const total = roundSaQty(resolvedTotal);
  if (!uid || !Number.isFinite(total) || total <= 0) {
    return;
  }
  const budget = await computeMrnQtyBudget(uid, {
    receiptQty,
    excludeAdjustmentId,
  });
  const receipt = budget.receipt_qty;
  const remainingQty = budget.remaining_qty;
  if (!Number.isFinite(receipt) || receipt <= 0) {
    if (budget.coil_used_qty + budget.pending_sa_add_qty > QTY_EPS && total > QTY_EPS) {
      const err = new Error(
        `Cannot add ${total} KG — ${budget.coil_used_qty + budget.pending_sa_add_qty} KG is already allocated on this MRN and the receipt qty could not be verified.`
      );
      err.statusCode = 400;
      throw err;
    }
    return;
  }
  if (total > remainingQty + QTY_EPS) {
    const parts = [];
    if (budget.coil_used_qty > 0) {
      parts.push(`${budget.coil_used_qty} KG in coils (MRN Portal / approved SA)`);
    }
    if (budget.pending_sa_add_qty > 0) {
      parts.push(`${budget.pending_sa_add_qty} KG in pending stock adjustment`);
    }
    const usedNote = parts.length ? ` Already used: ${parts.join("; ")}.` : "";
    const err = new Error(
      `Add quantity (${total}) exceeds remaining MRN receipt (${remainingQty} of ${receipt} KG).${usedNote}`
    );
    err.statusCode = 400;
    throw err;
  }
}

function canAuthorize(req) {
  return Boolean(req.permission?.can_authorize) || String(req.user?.type || "").toLowerCase() === "super_admin";
}

function parseScannedCoilsFromBody(body = {}) {
  const raw = body?.scanned_coils ?? body?.scannedCoils;
  if (!Array.isArray(raw)) return [];
  return raw.map((u) => String(u || "").trim()).filter(Boolean);
}

async function clearApprovalFlags(adjustmentId, user = null) {
  await updateAdjustment(
    {
      approved: false,
      approved_by: null,
      approved_at: null,
      ...(user ? { updated_by: user, updated_at: new Date() } : {}),
    },
    { adjustment_id: adjustmentId }
  );
}

async function approveAdjustment(id, user, userId, { scannedCoils = null } = {}) {
  const row = await findAdjustmentById(id);
  if (!row) {
    const err = new Error("Stock adjustment not found.");
    err.statusCode = 404;
    throw err;
  }
  if (row.approved) {
    const coils = await findCoilsBySaIdWithMrn(id, saCoilsEntryType(row.entry_type));
    return { data: row, coils };
  }

  const expectedScanUids = await getExpectedSaApproveScanUids(row);
  assertScannedCoilsForSaApprove(expectedScanUids, scannedCoils);

  if (isSaAddLikeEntryType(String(row.entry_type || ""))) {
    await requireAuthorizedRmSpecForItem({
      item_dcode: row.item_dcode,
      item_code: row.item_code,
      item_desc: row.item_desc,
    });
    if (row.mrn_uid) {
      // Receipt cap is resolved from ERP/local (same as MRN search) — not stored on adjustment rows.
      await assertAddQtyWithinMrnLimit({
        mrn_uid: row.mrn_uid,
        receiptQty: null,
        resolvedTotal: row.qty,
        excludeAdjustmentId: id,
      });
    }
  }

  try {
    await applyStockAdjustmentOnApprove({ adjustment: row, userName: user, userId });
  } catch (err) {
    throw err;
  }

  await updateAdjustment(
    { approved: true, approved_by: user, approved_at: new Date() },
    { adjustment_id: id }
  );
  const data = await findAdjustmentById(id);
  const coils = await findCoilsBySaIdWithMrn(id, saCoilsEntryType(data.entry_type));
  return { data, coils };
}
async function buildCreatePayload(body, user) {
  const entry_type = normalizeEntryType(body?.entry_type);
  if (!entry_type) {
    const err = new Error("Adjustment type must be Add, Minus, or Old.");
    err.statusCode = 400;
    throw err;
  }

  assertSaGateMetaFields(body, entry_type);

  const remarks = body?.remarks != null ? String(body.remarks).trim() : null;
  const unit = body?.unit != null ? String(body.unit).trim() || "KG" : "KG";

  if (isSaAddLikeEntryType(entry_type)) {
    const coilCount = parseInt(String(body?.coil_count_impact ?? body?.no_of_coils ?? ""), 10);
    if (!Number.isFinite(coilCount) || coilCount < 1) {
      const err = new Error("An Add adjustment requires a number of coils of at least 1.");
      err.statusCode = 400;
      throw err;
    }

    const qtyAutoCalc = await getMrnCoilQtyAutoCalc();
    const receiptQty = roundSaQty(body?.it_recp_qty ?? body?.mrn_receipt_qty);
    const totalQty = roundSaQty(body?.qty ?? body?.total_qty);
    const coilQtys = resolveAddCoilQtys(body, coilCount, { qtyAutoCalc, qtyEditable: true });
    if (!coilQtys?.length) {
      const err = new Error("An Add adjustment requires a total quantity and coil breakdown.");
      err.statusCode = 400;
      throw err;
    }
    assertCoilQtysMatchTotal(coilQtys, totalQty || coilQtys.reduce((s, q) => s + q, 0));
    const resolvedTotal = coilQtys.reduce((s, q) => s + roundSaQty(q), 0);

    const mrn_uid = body?.mrn_uid != null ? String(body.mrn_uid).trim() || null : null;
    const excludeId = parsePositiveIntId(body?.adjustment_id ?? body?.exclude_adjustment_id);
    await assertAddQtyWithinMrnLimit({
      mrn_uid,
      receiptQty,
      resolvedTotal,
      excludeAdjustmentId: excludeId,
    });

    const avgPer = coilCount > 0 ? resolvedTotal / coilCount : 0;

    const item_dcode = body?.item_dcode != null ? Number(body.item_dcode) : null;
    const item_code = body?.item_code != null ? String(body.item_code).trim() : null;
    if (!item_dcode && !item_code) {
      const err = new Error("An Add adjustment requires an RM item.");
      err.statusCode = 400;
      throw err;
    }

    await requireAuthorizedRmSpecForItem({
      item_dcode,
      item_code,
      item_desc: body?.item_desc,
    });

    const payload = {
      entry_type,
      ...saMetaFieldsForSave(body, entry_type),
      item_dcode: Number.isFinite(item_dcode) ? item_dcode : null,
      item_code: item_code || null,
      item_desc: body?.item_desc != null ? String(body.item_desc).trim() : null,
      heat_no: body?.heat_no != null ? String(body.heat_no).trim() : null,
      acc_code: body?.acc_code != null ? Number(body.acc_code) : null,
      acc_name: body?.acc_name != null ? String(body.acc_name).trim() : null,
      mrn_uid: body?.mrn_uid != null ? String(body.mrn_uid).trim() || null : null,
      mrn_no:
        body?.mrn_no != null && String(body.mrn_no).trim() !== ""
          ? Number(body.mrn_no)
          : null,
      serial_no:
        body?.serial_no != null && String(body.serial_no).trim() !== ""
          ? Number(body.serial_no)
          : null,
      ...normalizeMrnMetaFields(body),
      per_coil_qty: avgPer,
      coil_qtys: coilQtys,
      coil_count_impact: coilCount,
      qty: resolvedTotal,
      unit,
      remarks,
      created_by: user,
      approved: false,
    };
    return applyRmMasterLabels(payload);
  }

  // minus
  const uids = parseRemovedCoilUids(body?.removed_coil_uids ?? body?.removed_coil_uids_json);
  if (!uids.length) {
    const err = new Error("A Minus adjustment requires at least one coil.");
    err.statusCode = 400;
    throw err;
  }

  let sumQty = 0;
  let item_dcode = null;
  let item_code = null;
  let item_desc = null;
  let acc_code = body?.acc_code != null ? Number(body.acc_code) : null;
  let acc_name = body?.acc_name != null ? String(body.acc_name).trim() : null;
  const loadedCoils = [];

  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      const err = new Error(`Coil ${uid} was not found.`);
      err.statusCode = 400;
      throw err;
    }
    if (!isCoilAvailableForSaMinus(coil)) {
      const err = new Error(`Coil ${uid} is not active.`);
      err.statusCode = 400;
      throw err;
    }
    loadedCoils.push(coil);
    sumQty += Number(coil.qty) || 0;
    if (!item_code && coil.item_code) {
      item_dcode = coil.item_dcode ?? null;
      item_code = coil.item_code;
      item_desc = coil.item_desc ?? null;
    }
    if (!acc_name && coil.acc_name) {
      acc_code = coil.acc_code ?? acc_code;
      acc_name = String(coil.acc_name).trim();
    }
  }

  const heat_no = resolveEffectiveHeatNo({
    bodyHeatNo: body?.heat_no,
    coils: loadedCoils,
  });

  const payload = {
    entry_type,
    item_dcode,
    item_code,
    item_desc,
    heat_no,
    acc_code: Number.isFinite(acc_code) ? acc_code : null,
    acc_name: acc_name || null,
    mrn_uid: body?.mrn_uid != null ? String(body.mrn_uid).trim() || null : null,
    mrn_no:
      body?.mrn_no != null && String(body.mrn_no).trim() !== ""
        ? Number(body.mrn_no)
        : null,
    ...normalizeMrnMetaFields(body),
    removed_coil_uids: buildRemovedCoilUidsJson(uids),
    coil_count_impact: uids.length,
    qty: -Math.abs(sumQty),
    unit,
    remarks,
    created_by: user,
    approved: false,
  };
  return applyRmMasterLabels(payload);
}

export const getAdjustments = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "adjustment_id",
      order: "DESC",
    });
    const result = await findAdjustments({
      filters: sanitizeFilters(filters || {}, [
        "adjustment_id",
        "approved",
        "entry_type",
        "from_date",
        "to_date",
        "fromDate",
        "toDate",
      ]),
      search: sanitizeSearch(search),
      page,
      limit,
      permission: req.permission,
    });
    const data = await enrichRmMasterRows(result.data || []);
    return res.json({ success: true, ...result, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAdjustmentById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.adjustment_id ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid stock adjustment ID is required." });
    const data = await findAdjustmentById(id);
    if (!data) return res.status(404).json({ success: false, message: "Stock adjustment not found." });

    const coils = await loadAdjustmentCoils(data);

    const coil_qtys = parseStoredCoilQtys(data.coil_qtys);

    const [enriched] = await enrichRmMasterRows([data]);
    return res.json({ success: true, data: { ...(enriched || data), coil_qtys, coils } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Active coils for Minus picker. */
export const getActiveCoilsForMinus = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, { sortBy: "coil_index", order: "ASC" });
    const result = await findActiveCoilsForMinus({
      mrn_uid: req.body?.mrn_uid,
      mrn_no: req.body?.mrn_no,
      item_code: req.body?.item_code,
      item_dcode: req.body?.item_dcode,
      search: sanitizeSearch(search),
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
export const createAdjustment = async (req, res) => {
  try {
    const user = auditUserName(req);
    const payload = await buildCreatePayload(req.body, user);
    const wantApprove = normalizeApprovedInput(req.body?.approved) === true;

    if (wantApprove && !canAuthorize(req)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to approve a stock adjustment while creating it.",
      });
    }

    const row = await insertAdjustment(payload);

    let savedRow = row;
    if (isSaAddLikeEntryType(String(row.entry_type || ""))) {
      await syncStockAdjustmentAddCoils({
        adjustment: row,
        userName: user,
        userId: req.user?.id,
      });
      savedRow = (await findAdjustmentById(row.adjustment_id)) || row;
    }

    if (wantApprove) {
      const { data, coils } = await approveAdjustment(savedRow.adjustment_id, user, req.user?.id, {
        scannedCoils: parseScannedCoilsFromBody(req.body),
      });
      log(req, "create_approve", String(row.adjustment_id), {
        adjustment_id: row.adjustment_id,
        entry_type: row.entry_type,
        coil_count: coils?.length ?? 0,
        approved: true,
        approval_only: true,
      }, data);
      return res.status(201).json({
        success: true,
        data: { ...data, coils },
        message: "Stock adjustment created and approved.",
      });
    }
    const coils = isSaAddLikeEntryType(String(savedRow.entry_type || ""))
      ? await findCoilsBySaIdWithMrn(savedRow.adjustment_id, "stock_in")
      : [];
    log(req, "create", String(savedRow.adjustment_id), {
      adjustment_id: savedRow.adjustment_id,
      entry_type: savedRow.entry_type,
      approved: false,
      coil_count: coils.length,
    }, savedRow);

    return res.status(201).json({
      success: true,
      data: { ...savedRow, coils },
      toast_type: "warning",
      message: "Stock adjustment saved. Coils are available in Store In — approve when ready for downstream use.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const updateAdjustmentCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.adjustment_id ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid stock adjustment ID is required." });

    const existing = await findAdjustmentById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Stock adjustment not found." });

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const user = auditUserName(req);
    const incomingApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;

    // Approve-only
    if (incomingApproved === true && !existing.approved) {
      if (!canAuthorize(req)) {
        return res.status(403).json({ success: false, message: "You cannot approve this stock adjustment." });
      }
      const { data, coils } = await approveAdjustment(id, user, req.user?.id, {
        scannedCoils: parseScannedCoilsFromBody(req.body),
      });
      log(req, "approve", String(id), {
        adjustment_id: id,
        entry_type: data?.entry_type,
        coil_count: coils?.length ?? 0,
        approved: true,
        approval_only: true,
      }, data);
      return res.json({
        success: true,
        data: { ...data, coils },
        message: "Stock adjustment approved.",
      });
    }
    // Already authorized — do not fall through to edit (would revert stock)
    if (incomingApproved === true && existing.approved) {
      const coils = await findCoilsBySaIdWithMrn(id, saCoilsEntryType(existing.entry_type));
      return res.json({
        success: true,
        data: { ...existing, coils },
        message: "This stock adjustment has already been authorized.",
      });
    }

    // Unapprove only — skip when the same request also saves edited coils/qty/metadata.
    if (incomingApproved === false && existing.approved && !hasSaEditPayload(req.body)) {
      if (!canAuthorize(req)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to set this stock adjustment back to pending.",
        });
      }
      // Add/Old: keep coils in Store In — approval only gates downstream modules.
      if (String(existing.entry_type || "").toLowerCase() === "minus") {
        await revertStockAdjustmentOnUnapprove({
          adjustment: existing,
          userName: user,
          userId: req.user?.id,
        });
      }
      await clearApprovalFlags(id, user);
      const data = await findAdjustmentById(id);
      log(req, "unapprove", String(id), {
        adjustment_id: id,
        entry_type: existing.entry_type,
        old_values: { approved: true },
        new_values: { approved: false },
      }, data);
      return res.json({ success: true, data, message: "Stock adjustment set to pending." });
    }

    const entry_type = normalizeEntryType(req.body?.entry_type) || existing.entry_type;
    const fields = {
      entry_type,
      updated_by: user,
      updated_at: new Date(),
      approved: false,
      approved_by: null,
      approved_at: null,
    };

    if (req.body?.remarks !== undefined) {
      fields.remarks = req.body.remarks != null ? String(req.body.remarks).trim() : null;
    }

    if (isSaAddLikeEntryType(entry_type)) {
      assertSaGateMetaFields({ ...existing, ...req.body }, entry_type);
      const meta = parseSaGateMeta(req.body, entry_type);
      if (
        saEntryTypeNeedsFinancialYear(entry_type) &&
        (req.body?.financial_year !== undefined || req.body?.financialYear !== undefined)
      ) {
        fields.financial_year = meta.financial_year;
      }
      if (
        isSaLotGateEntryType(entry_type) &&
        (req.body?.it_lot_no !== undefined || req.body?.itLotNo !== undefined)
      ) {
        fields.it_lot_no = meta.it_lot_no;
      }
      if (req.body?.item_dcode != null) fields.item_dcode = Number(req.body.item_dcode) || null;
      if (req.body?.item_code != null) fields.item_code = String(req.body.item_code).trim();
      if (req.body?.item_desc != null) fields.item_desc = String(req.body.item_desc).trim();
      if (req.body?.heat_no != null) fields.heat_no = String(req.body.heat_no).trim();
      if (req.body?.acc_code !== undefined) {
        fields.acc_code = req.body.acc_code != null ? Number(req.body.acc_code) || null : null;
      }
      if (req.body?.acc_name !== undefined) {
        fields.acc_name = req.body.acc_name != null ? String(req.body.acc_name).trim() : null;
      }
      if (req.body?.mrn_uid !== undefined) {
        fields.mrn_uid =
          req.body.mrn_uid != null ? String(req.body.mrn_uid).trim() || null : null;
      }
      if (req.body?.mrn_no !== undefined) {
        const n =
          req.body.mrn_no != null && String(req.body.mrn_no).trim() !== ""
            ? Number(req.body.mrn_no)
            : null;
        fields.mrn_no = Number.isFinite(n) ? n : null;
      }
      if (req.body?.serial_no !== undefined) {
        const sn =
          req.body.serial_no != null && String(req.body.serial_no).trim() !== ""
            ? Number(req.body.serial_no)
            : null;
        fields.serial_no = Number.isFinite(sn) ? sn : null;
      }
      if (
        req.body?.bill_no !== undefined ||
        req.body?.bill_dt !== undefined ||
        req.body?.mrn_dt !== undefined
      ) {
        Object.assign(fields, normalizeMrnMetaFields(req.body));
      }
      if (req.body?.coil_count_impact != null || req.body?.no_of_coils != null) {
        fields.coil_count_impact = parseInt(
          String(req.body.coil_count_impact ?? req.body.no_of_coils),
          10
        );
      }
      if (req.body?.coil_qtys != null || req.body?.qty != null || req.body?.total_qty != null) {
        const n = fields.coil_count_impact ?? existing.coil_count_impact;
        const qtyAutoCalc = await getMrnCoilQtyAutoCalc();
        const coilQtys = resolveAddCoilQtys(req.body, n, { qtyAutoCalc, qtyEditable: true });
        if (coilQtys?.length) {
          const receiptQty = roundSaQty(req.body?.it_recp_qty ?? req.body?.mrn_receipt_qty);
          const total =
            roundSaQty(req.body?.qty ?? req.body?.total_qty) ||
            coilQtys.reduce((s, q) => s + q, 0);
          assertCoilQtysMatchTotal(coilQtys, total);
          fields.coil_qtys = coilQtys;
          fields.qty = coilQtys.reduce((s, q) => s + roundSaQty(q), 0);
          fields.per_coil_qty = fields.qty / coilQtys.length;
        }
      } else {
        const n = fields.coil_count_impact ?? existing.coil_count_impact;
        const p = fields.per_coil_qty ?? existing.per_coil_qty;
        if (Number.isFinite(Number(n)) && Number.isFinite(Number(p))) {
          fields.qty = Number(n) * Number(p);
        }
      }
      if (Number.isFinite(Number(fields.qty)) && Number(fields.qty) > 0) {
        await assertAddQtyWithinMrnLimit({
          mrn_uid: fields.mrn_uid ?? existing.mrn_uid,
          receiptQty: req.body?.it_recp_qty ?? req.body?.mrn_receipt_qty,
          resolvedTotal: fields.qty,
          excludeAdjustmentId: id,
        });
      }
      if (req.body?.per_coil_qty != null) {
        const pb = Number(req.body.per_coil_qty);
        if (Number.isFinite(pb) && pb > 0) fields.per_coil_qty = pb;
      }
      await requireAuthorizedRmSpecForItem({
        item_dcode: fields.item_dcode ?? existing.item_dcode,
        item_code: fields.item_code ?? existing.item_code,
        item_desc: fields.item_desc ?? existing.item_desc,
      });
    }

    if (entry_type === "minus") {
      if (req.body?.item_dcode != null) fields.item_dcode = Number(req.body.item_dcode) || null;
      if (req.body?.item_code != null) fields.item_code = String(req.body.item_code).trim();
      if (req.body?.item_desc != null) fields.item_desc = String(req.body.item_desc).trim();
      if (req.body?.heat_no != null) fields.heat_no = String(req.body.heat_no).trim() || null;
      if (req.body?.acc_code !== undefined) {
        fields.acc_code = req.body.acc_code != null ? Number(req.body.acc_code) || null : null;
      }
      if (req.body?.acc_name !== undefined) {
        fields.acc_name = req.body.acc_name != null ? String(req.body.acc_name).trim() : null;
      }
      if (req.body?.mrn_uid !== undefined) {
        fields.mrn_uid =
          req.body.mrn_uid != null ? String(req.body.mrn_uid).trim() || null : null;
      }
      if (req.body?.mrn_no !== undefined) {
        const n =
          req.body.mrn_no != null && String(req.body.mrn_no).trim() !== ""
            ? Number(req.body.mrn_no)
            : null;
        fields.mrn_no = Number.isFinite(n) ? n : null;
      }
      if (
        req.body?.bill_no !== undefined ||
        req.body?.bill_dt !== undefined ||
        req.body?.mrn_dt !== undefined
      ) {
        Object.assign(fields, normalizeMrnMetaFields(req.body));
      }

      if (req.body?.removed_coil_uids || req.body?.removed_coil_uids_json) {
        const uids = parseRemovedCoilUids(req.body.removed_coil_uids ?? req.body.removed_coil_uids_json);
        let sumQty = 0;
        let acc_code = req.body?.acc_code != null ? Number(req.body.acc_code) : null;
        let acc_name = req.body?.acc_name != null ? String(req.body.acc_name).trim() : null;
        const loadedCoils = [];
        for (const uid of uids) {
          const coil = await findCoilByUid(uid);
          if (!isCoilAvailableForSaMinus(coil, { excludeAdjustmentId: id })) {
            const err = new Error(`Coil ${uid} is not available.`);
            err.statusCode = 400;
            throw err;
          }
          loadedCoils.push(coil);
          sumQty += Number(coil.qty) || 0;
          if (!acc_name && coil.acc_name) {
            acc_code = coil.acc_code ?? acc_code;
            acc_name = String(coil.acc_name).trim();
          }
        }
        fields.removed_coil_uids = buildRemovedCoilUidsJson(uids);
        fields.coil_count_impact = uids.length;
        fields.qty = -Math.abs(sumQty);
        if (Number.isFinite(acc_code)) fields.acc_code = acc_code;
        if (acc_name) fields.acc_name = acc_name;
        if (req.body?.heat_no == null) {
          fields.heat_no = resolveEffectiveHeatNo({ coils: loadedCoils });
        }
      }
    }

    const mergedPreview = { ...existing, ...fields };
    const addLike = isSaAddLikeEntryType(String(entry_type || existing.entry_type || ""));
    const coilResyncNeeded = addLike && needsSaAddCoilResync(existing, mergedPreview);

    // Validate first — only revert inventory when coil-defining fields change.
    if (existing.approved) {
      if (addLike && coilResyncNeeded) {
        await assertSaAddCoilsUnusedForEdit(id);
        await revertStockAdjustmentOnUnapprove({
          adjustment: existing,
          userName: user,
          userId: req.user?.id,
        });
      } else if (String(existing.entry_type || "").toLowerCase() === "minus") {
        await revertStockAdjustmentOnUnapprove({
          adjustment: existing,
          userName: user,
          userId: req.user?.id,
        });
      }
    }

    await applyRmMasterLabels(fields, existing);
    await updateAdjustment(fields, { adjustment_id: id });
    const data = await findAdjustmentById(id);
    if (addLike && (await shouldSyncStockAdjustmentAddCoils(existing, data))) {
      await syncStockAdjustmentAddCoils({
        adjustment: data,
        userName: user,
        userId: req.user?.id,
      });
    }
    log(req, existing.approved ? "update_revert" : "update", String(id), {
      adjustment_id: id,
      entry_type: data?.entry_type,
      qty: data?.qty,
      approved: false,
    }, data);
    const coils = isSaAddLikeEntryType(String(data?.entry_type || ""))
      ? await findCoilsBySaIdWithMrn(id, "stock_in")
      : [];
    return res.json({
      success: true,
      data: { ...data, coils },
      toast_type: "warning",
      message: "Stock adjustment updated. Coils are available in Store In — approve when ready for downstream use.",
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteAdjustment = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.adjustment_id ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid stock adjustment ID is required." });
    const existing = await findAdjustmentById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Stock adjustment not found." });

    const user = auditUserName(req);
    if (existing.approved || isSaAddLikeEntryType(String(existing.entry_type || ""))) {
      await revertStockAdjustmentOnUnapprove({
        adjustment: existing,
        userName: user,
        userId: req.user?.id,
      });
    }
    await softDeleteAdjustment(id, user);
    log(req, "delete", String(id), {
      adjustment_id: id,
      entry_type: existing.entry_type,
      was_approved: Boolean(existing.approved),
    });
    return res.json({ success: true, message: "Stock adjustment deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
