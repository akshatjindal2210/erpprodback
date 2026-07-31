import { findAdjustments, findAdjustmentById, insertAdjustment, updateAdjustment, softDeleteAdjustment } from "../models/stockAdjustment.model.js";
import { applyStockAdjustmentOnApprove, revertStockAdjustmentOnUnapprove, parseRemovedCoilUids, buildRemovedCoilUidsJson } from "../utils/apply/stockAdjustmentApply.js";
import { findCoilsBySaId, findCoilByUid } from "../../coil/models/coil.model.js";
import { findCoils } from "../../coil/models/coil.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";

const MODULE = "rm_stock_adjustment";
const log = createRmstoreActivityLogger(MODULE);

function normalizeEntryType(raw) {
  const t = String(raw || "").trim().toLowerCase();
  return t === "add" || t === "minus" ? t : null;
}

function canAuthorize(req) {
  return (
    Boolean(req.permission?.can_authorize) ||
    String(req.user?.type || "").toLowerCase() === "super_admin"
  );
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

async function buildCreatePayload(body, user) {
  const entry_type = normalizeEntryType(body?.entry_type);
  if (!entry_type) {
    const err = new Error("Adjustment type must be either Add or Minus.");
    err.statusCode = 400;
    throw err;
  }

  const remarks = body?.remarks != null ? String(body.remarks).trim() : null;
  const unit = body?.unit != null ? String(body.unit).trim() || "KG" : "KG";
  const wantApprove = normalizeApprovedInput(body?.approved) === true;

  if (entry_type === "add") {
    const coilCount = parseInt(String(body?.coil_count_impact ?? body?.no_of_coils ?? ""), 10);
    const per_coil_qty = Number(body?.per_coil_qty);
    if (!Number.isFinite(coilCount) || coilCount < 1) {
      const err = new Error("An Add adjustment requires a number of coils of at least 1.");
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isFinite(per_coil_qty) || per_coil_qty <= 0) {
      const err = new Error("An Add adjustment requires a quantity per coil greater than 0.");
      err.statusCode = 400;
      throw err;
    }
    const item_dcode = body?.item_dcode != null ? Number(body.item_dcode) : null;
    const item_code = body?.item_code != null ? String(body.item_code).trim() : null;
    if (!item_dcode && !item_code) {
      const err = new Error("An Add adjustment requires an RM item.");
      err.statusCode = 400;
      throw err;
    }

    return {
      entry_type,
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
      per_coil_qty,
      coil_count_impact: coilCount,
      qty: coilCount * per_coil_qty,
      unit,
      remarks,
      created_by: user,
      approved: false,
    };
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
  let heat_no = null;

  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      const err = new Error(`Coil ${uid} was not found.`);
      err.statusCode = 400;
      throw err;
    }
    if (String(coil.status || "active").toLowerCase() !== "active") {
      const err = new Error(`Coil ${uid} is not active.`);
      err.statusCode = 400;
      throw err;
    }
    sumQty += Number(coil.qty) || 0;
    if (!item_code && coil.item_code) {
      item_dcode = coil.item_dcode ?? null;
      item_code = coil.item_code;
      item_desc = coil.item_desc ?? null;
    }
    if (!heat_no && coil.heat_no) heat_no = coil.heat_no;
  }

  return {
    entry_type,
    item_dcode,
    item_code,
    item_desc,
    heat_no,
    mrn_uid: body?.mrn_uid != null ? String(body.mrn_uid).trim() || null : null,
    mrn_no:
      body?.mrn_no != null && String(body.mrn_no).trim() !== ""
        ? Number(body.mrn_no)
        : null,
    removed_coil_uids: buildRemovedCoilUidsJson(uids),
    coil_count_impact: uids.length,
    qty: -Math.abs(sumQty),
    unit,
    remarks,
    created_by: user,
    approved: false,
    _wantApprove: wantApprove,
  };
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
    });
    return res.json({ success: true, ...result });
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

    const coils = data.approved
      ? await findCoilsBySaId(id)
      : data.entry_type === "minus"
        ? (
            await Promise.all(
              parseRemovedCoilUids(data.removed_coil_uids).map((uid) => findCoilByUid(uid))
            )
          ).filter(Boolean)
        : [];

    return res.json({ success: true, data: { ...data, coils } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Active coils available for Minus selection. */
export const getActiveCoilsForMinus = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const item_code = req.body?.item_code != null ? String(req.body.item_code).trim() : "";
    const heat_no = req.body?.heat_no != null ? String(req.body.heat_no).trim() : "";
    const mrn_uid = req.body?.mrn_uid != null ? String(req.body.mrn_uid).trim() : "";
    const mrn_no = req.body?.mrn_no != null ? String(req.body.mrn_no).trim() : "";
    const result = await findCoils({
      filters: {
        status: "active",
        ...(item_code ? { item_code } : {}),
        ...(heat_no ? { heat_no } : {}),
        ...(mrn_uid ? { mrn_uid } : {}),
        ...(mrn_no ? { mrn_no } : {}),
      },
      search: sanitizeSearch(search),
      page,
      limit: limit || 200,
      sortBy: "coil_uid",
      order: "DESC",
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
    const wantApprove = payload._wantApprove || normalizeApprovedInput(req.body?.approved) === true;
    delete payload._wantApprove;

    if (wantApprove && !canAuthorize(req)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to approve a stock adjustment while creating it.",
      });
    }

    const row = await insertAdjustment(payload);

    if (wantApprove) {
      await updateAdjustment(
        {
          approved: true,
          approved_by: user,
          approved_at: new Date(),
        },
        { adjustment_id: row.adjustment_id }
      );
      try {
        const fresh = await findAdjustmentById(row.adjustment_id);
        await applyStockAdjustmentOnApprove({
          adjustment: fresh,
          userName: user,
          userId: req.user?.id,
        });
      } catch (applyErr) {
        await clearApprovalFlags(row.adjustment_id);
        throw applyErr;
      }
      const data = await findAdjustmentById(row.adjustment_id);
      const coils = await findCoilsBySaId(row.adjustment_id);
      log(req, "create_approve", String(row.adjustment_id), {
        adjustment_id: row.adjustment_id,
        entry_type: row.entry_type,
        coil_count: coils?.length ?? 0,
        approved: true,
      }, data);
      return res.status(201).json({
        success: true,
        data: { ...data, coils },
        message: "Stock adjustment created and approved successfully.",
      });
    }

    log(req, "create", String(row.adjustment_id), {
      adjustment_id: row.adjustment_id,
      entry_type: row.entry_type,
      approved: false,
    }, row);

    return res.status(201).json({
      success: true,
      data: row,
      message: "Stock adjustment saved as pending.",
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

    const user = auditUserName(req);
    const incomingApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;

    // Approve-only
    if (incomingApproved === true && !existing.approved) {
      if (!canAuthorize(req)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to approve this stock adjustment.",
        });
      }
      await updateAdjustment(
        {
          approved: true,
          approved_by: user,
          approved_at: new Date(),
          updated_by: user,
          updated_at: new Date(),
        },
        { adjustment_id: id }
      );
      try {
        const fresh = await findAdjustmentById(id);
        await applyStockAdjustmentOnApprove({
          adjustment: fresh,
          userName: user,
          userId: req.user?.id,
        });
      } catch (applyErr) {
        await clearApprovalFlags(id, user);
        throw applyErr;
      }
      const data = await findAdjustmentById(id);
      const coils = await findCoilsBySaId(id);
      return res.json({
        success: true,
        data: { ...data, coils },
        message: "Stock adjustment approved successfully.",
      });
    }

    // Already authorized — do not fall through to edit (would revert stock)
    if (incomingApproved === true && existing.approved) {
      const coils = await findCoilsBySaId(id);
      return res.json({
        success: true,
        data: { ...existing, coils },
        message: "This stock adjustment has already been authorized.",
      });
    }

    // Unapprove
    if (incomingApproved === false && existing.approved) {
      if (!canAuthorize(req)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to approve this stock adjustment.",
        });
      }
      await revertStockAdjustmentOnUnapprove({
        adjustment: existing,
        userName: user,
        userId: req.user?.id,
      });
      await clearApprovalFlags(id, user);
      const data = await findAdjustmentById(id);
      return res.json({ success: true, data, message: "Stock adjustment set to pending." });
    }

    // Edit metadata — if was approved, revert first then keep pending
    if (existing.approved) {
      await revertStockAdjustmentOnUnapprove({
        adjustment: existing,
        userName: user,
        userId: req.user?.id,
      });
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

    if (entry_type === "add") {
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
      if (req.body?.per_coil_qty != null) fields.per_coil_qty = Number(req.body.per_coil_qty);
      if (req.body?.coil_count_impact != null || req.body?.no_of_coils != null) {
        fields.coil_count_impact = parseInt(
          String(req.body.coil_count_impact ?? req.body.no_of_coils),
          10
        );
      }
      const n = fields.coil_count_impact ?? existing.coil_count_impact;
      const p = fields.per_coil_qty ?? existing.per_coil_qty;
      if (Number.isFinite(Number(n)) && Number.isFinite(Number(p))) {
        fields.qty = Number(n) * Number(p);
      }
    }

    if (entry_type === "minus" && (req.body?.removed_coil_uids || req.body?.removed_coil_uids_json)) {
      const uids = parseRemovedCoilUids(req.body.removed_coil_uids ?? req.body.removed_coil_uids_json);
      let sumQty = 0;
      for (const uid of uids) {
        const coil = await findCoilByUid(uid);
        if (!coil || String(coil.status || "active").toLowerCase() !== "active") {
          const err = new Error(`Coil ${uid} is not available.`);
          err.statusCode = 400;
          throw err;
        }
        sumQty += Number(coil.qty) || 0;
      }
      fields.removed_coil_uids = buildRemovedCoilUidsJson(uids);
      fields.coil_count_impact = uids.length;
      fields.qty = -Math.abs(sumQty);
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
      if (req.body?.heat_no != null) fields.heat_no = String(req.body.heat_no).trim();
    }

    await updateAdjustment(fields, { adjustment_id: id });
    const data = await findAdjustmentById(id);
    return res.json({
      success: true,
      data,
      message: "Stock adjustment updated and set to pending. Approve it to apply the change.",
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
    if (existing.approved) {
      await revertStockAdjustmentOnUnapprove({
        adjustment: existing,
        userName: user,
        userId: req.user?.id,
      });
    }
    await softDeleteAdjustment(id, user);
    return res.json({ success: true, message: "Stock adjustment deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
