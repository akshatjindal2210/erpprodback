import { findInwards, findInward, insertInward, updateInward, softDeleteInward } from "../models/inventoryInward.model.js";
import { findCoilByUid, updateCoilsAfterInward, syncInwardRegisterCoils, clearCoilsForInward, findCoils } from "../../coil/models/coil.model.js";
import { groupRegisterCoilsIntoLocations, loadInwardRegisterPayload, buildInwardRegisterLogDetails } from "../utils/inwardRegister.js";
import { validateRmInwardLocationsAgainstCoils } from "../utils/validation/inwardLocationValidation.js";
import { findInProcessRequests, IPR_DOWNSTREAM } from "../../in-process-request/models/inProcessRequest.model.js";
import { findPackingAreaByMrn } from "../utils/list/packingAreaList.js";
import { materializePendingStockAdjustmentCoils } from "../../stock-adjustment/utils/apply/stockAdjustmentApply.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalUpdateFields, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { enrichIprWithMachineLabels } from "../utils/enrichIprMachineLabels.js";

const MODULE = "rm_inventory_inwards";

/** Store In saves are final — no separate approve step (IMS inward pattern). */
function stampInwardSave(fields, user, existing = null) {
  fields.approved = true;
  fields.approved_by = existing?.approved_by || user;
  fields.approved_at = existing?.approved_at || new Date();
  fields.updated_by = user;
  fields.updated_at = new Date();
  return fields;
}

const log = createRmstoreActivityLogger(MODULE);

/** Client may send coils as UID strings or `{ coil_no_uid }`. */
function inwardCoilUids(coils) {
  if (!Array.isArray(coils)) return [];
  return coils
    .map((c) => {
      if (c == null) return null;
      if (typeof c === "string" || typeof c === "number") return String(c).trim();
      if (typeof c === "object" && c.coil_no_uid != null) return String(c.coil_no_uid).trim();
      return null;
    })
    .filter(Boolean);
}

/**
 * Normalize create/update body to locations[].
 * Supports IMS-style `{ locations: [{ location_id, coils }] }`
 * and legacy `{ location_id, coils }`.
 */
function normalizeInwardLocationsBody(body) {
  if (Array.isArray(body?.locations) && body.locations.length > 0) {
    return body.locations
      .map((loc) => ({
        location_id: parsePositiveIntId(loc?.location_id),
        coils: inwardCoilUids(loc?.coils),
      }))
      .filter((loc) => loc.location_id && loc.coils.length > 0);
  }

  const location_id = parsePositiveIntId(body?.location_id);
  const coils = inwardCoilUids(body?.coils);
  if (location_id && coils.length) {
    return [{ location_id, coils }];
  }
  return [];
}

function uniqueCoilUidsFromLocations(locations) {
  const set = new Set();
  for (const loc of locations || []) {
    for (const uid of loc.coils || []) set.add(uid);
  }
  return [...set];
}

/** @deprecated use groupRegisterCoilsIntoLocations from inwardRegister.js */
function groupCoilsIntoLocations(coils) {
  return groupRegisterCoilsIntoLocations(coils);
}

async function resolveCoilsForInward(uids, { editInUid = null } = {}) {
  const resolved = [];
  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      return { error: `Coil ${uid} was not found.` };
    }
    const status = String(coil.status || "active").toLowerCase();
    const coilInUid = coil.in_uid != null ? Number(coil.in_uid) : null;
    const belongsToEditInward = editInUid != null && coilInUid === Number(editInUid);

    if (status !== "active" && !belongsToEditInward) {
      if (status === "rejected") {
        const rejectRef = coil.rm_uid != null ? `REJECT-${coil.rm_uid}` : null;
        return {
          error: rejectRef
            ? `Coil ${uid} is held in RM Rejection (${rejectRef}). Send it from Store Out, not Store In.`
            : `Coil ${uid} is held in RM Rejection. Send it from Store Out, not Store In.`,
        };
      }
      return { error: `Coil ${uid} is not available. Its current status is ${status}.` };
    }
    if (coil.out_uid != null || status === "out") {
      return { error: `Coil ${uid} is on Store Out. Revert Store Out before Store In.` };
    }
    resolved.push(coil);
  }
  return { resolved };
}

function buildInwardHeaderMeta(resolved) {
  const mrnRefs = [...new Set(resolved.map((c) => c.mrn_no).filter((v) => v != null))].join(" | ");
  const mrnUids = [...new Set(resolved.map((c) => c.mrn_uid).filter(Boolean))].join(" | ");
  const heatNos = [...new Set(resolved.map((c) => c.heat_no).filter(Boolean))].join(" | ");
  const itemCodes = [...new Set(resolved.map((c) => c.item_code).filter(Boolean))].join(" | ");
  const itemDescs = [...new Set(resolved.map((c) => c.item_desc).filter(Boolean))].join(" | ");
  const total_qty = resolved.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const qtys = resolved.map((c) => c.qty ?? "").join(",");
  return {
    mrn_refs: mrnRefs || null,
    mrn_uids: mrnUids || null,
    heat_nos: heatNos || null,
    item_codes: itemCodes || null,
    item_descs: itemDescs || null,
    qtys,
    total_qty,
    coil_count: resolved.length,
  };
}

export const getInwards = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "in_uid",
      order: "DESC",
    });
    const result = await findInwards({
      filters: sanitizeFilters(filters || {}, ["approved", "from_date", "to_date"]),
      search: sanitizeSearch(search),
      page,
      limit,
      permission: req.permission,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Approved in-process store-in returns waiting to be received (one pending API). */
export const getPendingStoreInList = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, {
      sortBy: "ipr_uid",
      order: "DESC",
    });
    const result = await findInProcessRequests({
      pendingStoreInQueue: true,
      filters: {
        approved: true,
        downstream: IPR_DOWNSTREAM.PENDING_STORE_IN,
      },
      search: sanitizeSearch(search),
      page,
      limit: limit || 1000,
    });
    result.data = await enrichIprWithMachineLabels(result.data);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** By Packing — coils in packing area grouped by mrn_uid. */
export const getPackingAreaList = async (req, res) => {
  try {
    await materializePendingStockAdjustmentCoils({
      userName: auditUserName(req),
      userId: req.user?.id,
    });
    const { page, limit, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "mrn_no",
      order: "DESC",
    });
    const result = await findPackingAreaByMrn({
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit: limit || 1000,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** By Coil — individual coils in packing area (optional mrn_uid filter). */
export const getCoilAreaList = async (req, res) => {
  try {
    await materializePendingStockAdjustmentCoils({
      userName: auditUserName(req),
      userId: req.user?.id,
    });
    const { page, limit, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const mrn_uid = req.body?.mrn_uid != null ? String(req.body.mrn_uid).trim() : "";
    const source = req.body?.source != null ? String(req.body.source).trim() : "";
    const result = await findCoils({
      filters: {
        coil_area: true,
        ...(mrn_uid ? { mrn_uid } : {}),
        ...(source ? { source } : {}),
      },
      search: sanitizeSearch(search),
      page,
      limit: limit || 1000,
      sortBy,
      order,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getInwardById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.in_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-in entry ID is required." });
    const data = await findInward(id);
    if (!data) return res.status(404).json({ success: false, message: "Store-in entry not found." });

    const register = await loadInwardRegisterPayload(id, {
      expectedCoilCount: Number(data.coil_count) || 0,
    });
    return res.json({
      success: true,
      data: {
        ...data,
        coils: register.coils,
        locations: register.locations,
        history_locations: register.history_locations || [],
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Create Store-In from scanned coils + location(s) (IMS inward analog).
 * body: { locations: [{ location_id, coils: [{ coil_no_uid }] }], remarks }
 * Legacy: { location_id, coils: [{ coil_no_uid }], remarks }
 */
export const createInward = async (req, res) => {
  try {
    const locations = normalizeInwardLocationsBody(req.body);
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;

    if (!locations.length) {
      return res.status(400).json({
        success: false,
        message: "At least one location with coils is required.",
      });
    }

    const uids = uniqueCoilUidsFromLocations(locations);
    if (uids.length !== locations.reduce((s, l) => s + l.coils.length, 0)) {
      return res.status(400).json({
        success: false,
        message: "The same coil cannot be assigned to more than one location.",
      });
    }

    const locErr = await validateRmInwardLocationsAgainstCoils(locations);
    if (locErr) return res.status(400).json({ success: false, message: locErr });

    const { resolved, error } = await resolveCoilsForInward(uids);
    if (error) return res.status(400).json({ success: false, message: error });

    const meta = buildInwardHeaderMeta(resolved);
    const user = auditUserName(req);

    const now = new Date();
    const row = await insertInward({
      ...meta,
      remarks,
      created_by: user,
      approved: true,
      approved_by: user,
      approved_at: now,
    });

    await Promise.all(
      locations.map((loc) => updateCoilsAfterInward(row.in_uid, loc.location_id, loc.coils, user))
    );

    // Verify every coil is linked with a rack location — rollback on partial write
    const linked = await findCoils({ filters: { in_uid: row.in_uid }, limit: 5000 });
    const linkedRows = linked?.data || [];
    const linkedActiveWithLoc = linkedRows.filter(
      (c) =>
        String(c.status || "active").toLowerCase() === "active" &&
        Number(c.in_uid) === Number(row.in_uid) &&
        c.location_id != null
    ).length;
    if (linkedActiveWithLoc !== uids.length) {
      await clearCoilsForInward(row.in_uid, user);
      await softDeleteInward(row.in_uid, user);
      return res.status(500).json({
        success: false,
        message: `Could not complete the Store In. Only ${linkedActiveWithLoc} of ${uids.length} coils were linked with a location, so the entry was rolled back.`,
      });
    }

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.INWARD_LINK,
      source_module: "inventory_inward",
      source_id: String(row.in_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: linked.data || [],
      details: {
        in_uid: row.in_uid,
        ...buildInwardRegisterLogDetails(locations, linked.data || []),
      },
    });

    const data = await findInward(row.in_uid);
    const coilRows = linked.data || [];
    const locationsOut = groupCoilsIntoLocations(coilRows);
    log(req, "create", String(row.in_uid), {
      in_uid: row.in_uid,
      mrn_no: meta.mrn_no ?? null,
      mrn_uid: meta.mrn_uid ?? null,
      item_code: meta.item_code ?? null,
      location_count: locations.length,
      locations: locations.map((l) => ({ location_id: l.location_id, coil_count: l.coils.length })),
      coil_count: resolved.length,
      coil_no_uids: uids,
      remarks,
    }, data);
    return res.status(201).json({
      success: true,
      data: {
        ...data,
        coils: coilRows,
        locations: locationsOut,
      },
      message: "Store In created successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Update Store-In.
 * body: { in_uid, locations?: [{ location_id, coils }], remarks? }
 * Legacy: { in_uid, location_id?, coils?: [{ coil_no_uid }], remarks? }
 */
export const updateInwardCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.in_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-in entry ID is required." });

    const existing = await findInward(id);
    if (!existing) return res.status(404).json({ success: false, message: "Store-in entry not found." });

    if (req.user?.type !== "super_admin" && req.permission && req.permission.can_edit_days > 0) {
      const createdAt = new Date(existing.created_at);
      const diffDays = Math.ceil(Math.abs(Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > req.permission.can_edit_days) {
        return res.status(403).json({
          success: false,
          message: `Edit time limit exceeded. You can only edit records from the last ${req.permission.can_edit_days} days.`,
        });
      }
    }

    const user = auditUserName(req);
    const remarks =
      req.body?.remarks !== undefined
        ? req.body.remarks != null
          ? String(req.body.remarks).trim()
          : null
        : existing.remarks;

    const hasLocationsBody =
      Array.isArray(req.body?.locations) ||
      Array.isArray(req.body?.coils) ||
      req.body?.location_id != null;
    const locations = hasLocationsBody ? normalizeInwardLocationsBody(req.body) : [];
    const normalizedApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;
    const remarksChanged = String(remarks ?? "") !== String(existing.remarks ?? "");

    // Approve-only (no coil/location body) — API kept for future authorize flow
    if (!hasLocationsBody && normalizedApproved !== undefined) {
      const fields = {};
      if (remarksChanged) fields.remarks = remarks;
      applyApprovalUpdateFields({
        req,
        fields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: remarksChanged,
        alreadyApproved: existing.approved === true,
        auditAsName: true,
      });
      if (!Object.keys(fields).length) {
        return res.status(400).json({ success: false, message: "There are no fields to update." });
      }
      await updateInward(id, fields);
      const data = await findInward(id);
      const register = await loadInwardRegisterPayload(id, {
        expectedCoilCount: Number(data?.coil_count) || 0,
      });
      log(req, fields.approved === true ? "approve" : "unapprove", String(id), {
        in_uid: id,
        approval_only: !remarksChanged,
        approved: fields.approved === true,
        coil_count: register.coils.length,
        remarks,
      }, data);
      return res.json({
        success: true,
        data: {
          ...data,
          coils: register.coils,
          locations: register.locations,
          history_locations: register.history_locations || [],
        },
        message: fields.approved === true ? "Store In authorized successfully." : "Store In set to pending.",
      });
    }

    if (hasLocationsBody) {
      if (!locations.length) {
        return res.status(400).json({
          success: false,
          message: "At least one location with coils is required.",
        });
      }

      const uids = uniqueCoilUidsFromLocations(locations);
      if (uids.length !== locations.reduce((s, l) => s + l.coils.length, 0)) {
        return res.status(400).json({
          success: false,
          message: "The same coil cannot be assigned to more than one location.",
        });
      }

      const locErr = await validateRmInwardLocationsAgainstCoils(locations);
      if (locErr) return res.status(400).json({ success: false, message: locErr });

      const { resolved, error } = await resolveCoilsForInward(uids, { editInUid: id });
      if (error) return res.status(400).json({ success: false, message: error });

      await syncInwardRegisterCoils(id, locations, user);

      const linkedAfter = await findCoils({ filters: { in_uid: id }, limit: 5000 });
      const linkedRows = linkedAfter?.data || [];
      const linkedActiveWithLoc = linkedRows.filter(
        (c) =>
          String(c.status || "active").toLowerCase() === "active" &&
          Number(c.in_uid) === id &&
          c.location_id != null
      ).length;
      if (linkedActiveWithLoc !== uids.length) {
        return res.status(500).json({
          success: false,
          message: `Could not update the Store In. Only ${linkedActiveWithLoc} of ${uids.length} coils were saved with a location. Please reopen and try again.`,
        });
      }

      const meta = buildInwardHeaderMeta(resolved);
      await updateInward(id, stampInwardSave({ ...meta, remarks }, user, existing));

      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.INWARD_LINK,
        source_module: "inventory_inward",
        source_id: String(id),
        user_name: user,
        user_id: req.user?.id,
        rows: linkedAfter?.data || resolved,
        details: {
          in_uid: id,
          action: "update",
          ...buildInwardRegisterLogDetails(locations, linkedAfter?.data || resolved),
        },
      });
    } else if (remarksChanged) {
      await updateInward(id, stampInwardSave({ remarks }, user, existing));
    } else {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    const data = await findInward(id);
    const register = await loadInwardRegisterPayload(id, {
      expectedCoilCount: Number(data?.coil_count) || 0,
    });
    log(req, hasLocationsBody && locations.length ? "update" : "update_remarks", String(id), {
      in_uid: id,
      location_count: locations.length,
      coil_count: register.coils.length,
      coil_no_uids: register.coils.map((c) => c.coil_no_uid),
      remarks,
    }, data);
    return res.json({
      success: true,
      data: {
        ...data,
        coils: register.coils,
        locations: register.locations,
        history_locations: register.history_locations || [],
      },
      message: "Store In updated successfully.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteInward = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.in_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid store-in entry ID is required." });
    const existing = await findInward(id);
    if (!existing) return res.status(404).json({ success: false, message: "Store-in entry not found." });
    const user = auditUserName(req);
    const coils = await findCoils({ filters: { in_uid: id }, limit: 5000 });
    await clearCoilsForInward(id, user);
    await softDeleteInward(id, user);

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.INWARD_UNLINK,
      source_module: "inventory_inward",
      source_id: String(id),
      user_name: user,
      user_id: req.user?.id,
      rows: coils.data || [],
      details: { in_uid: id, coil_count: coils.data?.length || 0 },
    });

    log(req, "delete", String(id), {
      in_uid: id,
      mrn_no: existing.mrn_no ?? null,
      coil_count: coils.data?.length || 0,
      coil_no_uids: (coils.data || []).map((c) => c.coil_no_uid),
    }, existing);

    return res.json({ success: true, message: "Store In deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
