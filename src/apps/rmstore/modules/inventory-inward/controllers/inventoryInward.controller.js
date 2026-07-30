import { findInwards, findInward, insertInward, updateInward, softDeleteInward } from "../models/inventoryInward.model.js";
import { findCoilByUid, updateCoilsAfterInward, clearCoilsForInward, findCoils } from "../../coil/models/coil.model.js";
import { findPackingAreaByMrn } from "../utils/list/packingAreaList.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";

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

/** Group flat coil rows into `locations[]` for the edit modal (IMS inward analog). */
function groupCoilsIntoLocations(coils) {
  const map = {};
  for (const coil of coils || []) {
    const lid = coil.location_id != null ? Number(coil.location_id) : null;
    if (!lid) continue;
    if (!map[lid]) {
      const locName =
        String(coil.location_no || "").trim() ||
        `RM-${coil.rack_no || ""}${String(coil.row_no || "").toUpperCase()}`.trim() ||
        String(lid);
      map[lid] = {
        location_id: lid,
        name: locName,
        location_no: locName,
        coils: [],
      };
    }
    map[lid].coils.push(coil);
  }
  return Object.values(map);
}

async function resolveCoilsForInward(uids, { editInUid = null } = {}) {
  const resolved = [];
  for (const uid of uids) {
    const coil = await findCoilByUid(uid);
    if (!coil) {
      return { error: `Coil ${uid} was not found.` };
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status !== "active") {
      return { error: `Coil ${uid} is not available. Its current status is ${status}.` };
    }
    const coilInUid = coil.in_uid != null ? Number(coil.in_uid) : null;
    if (coil.location_id) {
      if (editInUid == null || coilInUid !== Number(editInUid)) {
        return {
          error: editInUid
            ? `Coil ${uid} is already stored on another store-in entry.`
            : `Coil ${uid} has already been stored in.`,
        };
      }
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
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** By Packing — coils in packing area grouped by mrn_uid. */
export const getPackingAreaList = async (req, res) => {
  try {
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
    const { page, limit, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const mrn_uid = req.body?.mrn_uid != null ? String(req.body.mrn_uid).trim() : "";
    const result = await findCoils({
      filters: {
        coil_area: true,
        ...(mrn_uid ? { mrn_uid } : {}),
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
    const coils = await findCoils({ filters: { in_uid: id }, limit: 5000, sortBy: "coil_uid", order: "ASC" });
    const coilRows = Array.isArray(coils?.data) ? coils.data : [];
    return res.json({
      success: true,
      data: {
        ...data,
        coils: coilRows,
        locations: groupCoilsIntoLocations(coilRows),
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

    const { resolved, error } = await resolveCoilsForInward(uids);
    if (error) return res.status(400).json({ success: false, message: error });

    const meta = buildInwardHeaderMeta(resolved);
    const user = auditUserName(req);

    const row = await insertInward({
      ...meta,
      remarks,
      created_by: user,
    });

    await Promise.all(
      locations.map((loc) => updateCoilsAfterInward(row.in_uid, loc.location_id, loc.coils, user))
    );

    // Verify coils linked — surface DB miss early
    const linked = await findCoils({ filters: { in_uid: row.in_uid }, limit: 5000 });
    const linkedCount = linked?.data?.length || 0;
    if (linkedCount !== uids.length) {
      await clearCoilsForInward(row.in_uid, user);
      await softDeleteInward(row.in_uid, user);
      return res.status(500).json({
        success: false,
        message: `Could not complete the Store In. Only ${linkedCount} of ${uids.length} coils were linked, so the entry was rolled back.`,
      });
    }

    // IMS Store In style — create as authorized (no separate approve gate on add)
    await updateInward(row.in_uid, {
      approved: true,
      approved_by: user,
      approved_at: new Date(),
    });

    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.INWARD_LINK,
      source_module: "inventory_inward",
      source_id: String(row.in_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: resolved,
      details: {
        in_uid: row.in_uid,
        location_count: locations.length,
        locations: locations.map((l) => ({
          location_id: l.location_id,
          coil_count: l.coils.length,
        })),
        coil_count: resolved.length,
      },
    });

    const data = await findInward(row.in_uid);
    const coilRows = linked.data || [];
    return res.status(201).json({
      success: true,
      data: {
        ...data,
        coils: coilRows,
        locations: groupCoilsIntoLocations(coilRows),
      },
      message: "Store In created successfully.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Update Store-In (edit / approve) — IMS update analog.
 * body: { in_uid, locations?: [{ location_id, coils }], remarks?, approved? }
 * Legacy: { in_uid, location_id?, coils?: [{ coil_no_uid }], remarks?, approved? }
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

    // Approve-only (no coil/location body)
    if (!hasLocationsBody && normalizedApproved !== undefined) {
      const approvalFields = { remarks };
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges: false,
        auditAsName: true,
      });
      await updateInward(id, approvalFields);
      const data = await findInward(id);
      const coils = await findCoils({ filters: { in_uid: id }, limit: 5000 });
      const coilRows = coils.data || [];
      return res.json({
        success: true,
        data: {
          ...data,
          coils: coilRows,
          locations: groupCoilsIntoLocations(coilRows),
        },
        message: approvalFields.approved ? "Store In authorized successfully." : "Store In set to pending.",
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

      const { resolved, error } = await resolveCoilsForInward(uids, { editInUid: id });
      if (error) return res.status(400).json({ success: false, message: error });

      await clearCoilsForInward(id, user);
      await Promise.all(
        locations.map((loc) => updateCoilsAfterInward(id, loc.location_id, loc.coils, user))
      );

      const linkedAfter = await findCoils({ filters: { in_uid: id }, limit: 5000 });
      const linkedCount = linkedAfter?.data?.length || 0;
      if (linkedCount !== uids.length) {
        return res.status(500).json({
          success: false,
          message: `Could not update the Store In. Only ${linkedCount} of ${uids.length} coils were linked, so please reopen the entry and try again.`,
        });
      }

      const meta = buildInwardHeaderMeta(resolved);
      const fields = {
        ...meta,
        remarks,
        updated_by: user,
        updated_at: new Date(),
        // IMS: edit keeps / re-asserts authorized
        approved: true,
        approved_by: existing.approved_by || user,
        approved_at: existing.approved_at || new Date(),
      };

      if (normalizedApproved === false) {
        applyApprovalWorkflow({
          req,
          fields,
          incomingApproved: false,
          hasBusinessChanges: false,
          auditAsName: true,
        });
      }

      await updateInward(id, fields);

      logCoilTransactionSafe({
        transaction_type: COIL_TX_TYPES.INWARD_LINK,
        source_module: "inventory_inward",
        source_id: String(id),
        user_name: user,
        user_id: req.user?.id,
        rows: resolved,
        details: {
          in_uid: id,
          location_count: locations.length,
          locations: locations.map((l) => ({
            location_id: l.location_id,
            coil_count: l.coils.length,
          })),
          coil_count: resolved.length,
          action: "update",
        },
      });
    } else {
      await updateInward(id, {
        remarks,
        updated_by: user,
        updated_at: new Date(),
      });
    }

    const data = await findInward(id);
    const coils = await findCoils({ filters: { in_uid: id }, limit: 5000 });
    const coilRows = coils.data || [];
    return res.json({
      success: true,
      data: {
        ...data,
        coils: coilRows,
        locations: groupCoilsIntoLocations(coilRows),
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

    return res.json({ success: true, message: "Store In deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
