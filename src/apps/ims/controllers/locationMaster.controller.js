import { findLocations, findLocation, findLocationDuplicate, insertLocation, updateLocations, deleteLocations } from "../models/locationMaster.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { resolveLocationViewsSelectFields } from "../config/view-fields/location.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../utils/approval.js";
import { enrichRowsWithIMS } from "../utils/imsLookup.js";

const CFG = getCrudModuleConfig("location_master");
const RACK_NO_NUMERIC_RE = /^\d+$/;
const SHELF_NO_ALPHA_RE = /^[A-Za-z]+$/;

async function enrichLocationRows(rows = []) {
  return enrichRowsWithIMS(rows, {
    itemCodeField: "item_dcode",
    accCodeField: "acc_code",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
    accNameOut: "acc_name"
  });
}

function normalizeShelfNo(value) {
  return value?.toString().trim().toUpperCase() || "";
}
function buildLocationNo(rackNo, shelfNo) {
  return `${rackNo || ""}${(shelfNo || "").toString().toUpperCase()}`;
}

/** Map Postgres unique violations to the correct user-facing message. */
function locationUniqueViolationMessage(err, locationNo = "") {
  const constraint = err?.constraint || "";
  const loc = locationNo ? ` "${locationNo}"` : "";

  if (constraint === "ims_location_master_pkey") {
    return "Could not save location: database ID is out of sync. Restart the backend server and try again.";
  }
  if (constraint === "location_master_rack_shelf_unique_active") {
    return loc
      ? `Location${loc} already exists for this rack and shelf.`
      : "A location with this rack and shelf number already exists.";
  }
  if (constraint === "location_master_location_no_unique_active") {
    return loc
      ? `Location number${loc} is already in use.`
      : "This location number is already in use. Use a different rack or shelf combination.";
  }
  if (err?.code === "23505") {
    return loc
      ? `Location${loc} could not be saved because a duplicate record exists.`
      : "Could not save location because a duplicate record exists.";
  }
  return err?.message || "Could not save location.";
}

const log = (req, action, entity_id, details) =>
  logActivity(req, {
    action,
    entity: "location_master",
    entity_id,
    details
  }).catch(() => {});

export const getLocations = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "location_id", order: "DESC" });

    const result = await findLocations({
      filters: sanitizeFilters(filters, CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG.listFields,
      permission: req.permission
    });

    const enrichedRows = await enrichLocationRows(result.data || []);
    return res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLocationById = async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ success: false, message: "ID required" });
    }

    const data = await findLocation({ location_id: id });
    if (!data) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const [enriched] = await enrichLocationRows([data]);
    return res.json({ success: true, data: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createLocation = async (req, res) => {
  let locationNo = "";
  try {
    const { rack_no, shelf_no, location_description, total_capacity, acc_code, item_dcode, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    const normalizedRackNo = rack_no?.toString().trim();
    const normalizedShelfNo = normalizeShelfNo(shelf_no);
    locationNo = buildLocationNo(normalizedRackNo, normalizedShelfNo);

    if (!normalizedRackNo) {
      return res.status(400).json({ success: false, message: "rack_no required" });
    }
    if (!RACK_NO_NUMERIC_RE.test(normalizedRackNo)) {
      return res.status(400).json({ success: false, message: "rack_no must be numeric only" });
    }
    if (!normalizedShelfNo) {
      return res.status(400).json({ success: false, message: "shelf_no required" });
    }
    if (!SHELF_NO_ALPHA_RE.test(normalizedShelfNo)) {
      return res.status(400).json({ success: false, message: "shelf_no must contain alphabets only" });
    }

    if (total_capacity !== undefined && Number.isNaN(Number(total_capacity))) {
      return res.status(400).json({ success: false, message: "total_capacity must be a valid number" });
    }

    const duplicate = await findLocationDuplicate({
      rack_no: normalizedRackNo,
      shelf_no: normalizedShelfNo,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Location "${locationNo}" already exists for this rack and shelf`,
      });
    }

    const row = await insertLocation({
      rack_no: normalizedRackNo,
      shelf_no: normalizedShelfNo,
      location_no: locationNo,
      location_description: location_description?.toString().trim(),
      total_capacity,
      acc_code,
      item_dcode,
      created_by: req.user.id,
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({
        req,
        fields: approvalFields,
        incomingApproved: true,
        hasBusinessChanges: false
      });
      await updateLocations(approvalFields, { location_id: row.location_id });
    }

    const data = await findLocation({ location_id: row.location_id });
    const [enriched] = await enrichLocationRows(data ? [data] : []);

    await log(req, "create", row.location_id, { rack_no: normalizedRackNo, shelf_no: normalizedShelfNo, location_no: locationNo });

    return res.status(201).json({ success: true, data: enriched ?? data, message: "Location created successfully" });
  } catch (err) {
    console.log("Error creating location:", err);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: locationUniqueViolationMessage(err, locationNo),
      });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateLocation = async (req, res) => {
  let locationNo = "";
  try {
    const { id, rack_no, shelf_no, location_description, total_capacity, acc_code, item_dcode, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);

    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findLocation({ location_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

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

    const hasBusinessChanges = rack_no !== undefined || shelf_no !== undefined || location_description !== undefined || total_capacity !== undefined || acc_code !== undefined || item_dcode !== undefined;

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    if (rack_no !== undefined && (!rack_no?.toString().trim() || !RACK_NO_NUMERIC_RE.test(rack_no?.toString().trim()))) {
      return res.status(400).json({ success: false, message: "rack_no must be numeric only" });
    }
    if (shelf_no !== undefined) {
      const normalizedShelfNo = normalizeShelfNo(shelf_no);
      if (!normalizedShelfNo) {
        return res.status(400).json({ success: false, message: "shelf_no required" });
      }
      if (!SHELF_NO_ALPHA_RE.test(normalizedShelfNo)) {
        return res.status(400).json({ success: false, message: "shelf_no must contain alphabets only" });
      }
    }

    const fields = {
      ...(rack_no !== undefined && { rack_no: rack_no?.toString().trim() }),
      ...(shelf_no !== undefined && { shelf_no: normalizeShelfNo(shelf_no) }),
      ...(location_description !== undefined && { location_description: location_description?.toString().trim() }),
      ...(total_capacity !== undefined && { total_capacity }),
      ...(acc_code !== undefined && { acc_code }),
      ...(item_dcode !== undefined && { item_dcode }),
      updated_by: req.user.id,
      updated_at: new Date(),
    };
    const nextRackNo = fields.rack_no ?? existing.rack_no;
    const nextShelfNo = fields.shelf_no ?? existing.shelf_no;
    fields.location_no = buildLocationNo(nextRackNo, nextShelfNo);
    locationNo = fields.location_no;

    if (rack_no !== undefined || shelf_no !== undefined) {
      const duplicate = await findLocationDuplicate({
        rack_no: nextRackNo,
        shelf_no: nextShelfNo,
        excludeLocationId: id,
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Location "${fields.location_no}" already exists for this rack and shelf`,
        });
      }
    }

    applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges });

    const updated = await updateLocations(fields, { location_id: id });

    await log(req, "update", id, { updated_fields: Object.keys(fields) });

    const [enriched] = await enrichLocationRows(updated ? [updated] : []);
    return res.json({ success: true, data: enriched ?? updated, message: "Location updated successfully" });
  } catch (err) {
    console.log("Error updating location:", err);
    if (err?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: locationUniqueViolationMessage(err, locationNo),
      });
    }
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const deleteLocation = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: "ID required" });
    }

    const existing = await findLocation({ location_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deleteLocations(
      { location_id: id },
      { deleted_by: req.user.id }
    );
    
    await log(req, "delete", id, { rack_no: existing.rack_no });

    return res.json({ success: true, message: "Location deleted successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLocationsViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "location_id", order: "DESC" });

    if (id) {
      const location = await findLocation({ location_id: id, approved: true, is_deleted: false });
      if (!location) return res.json({ success: true, data: null });
      const [enriched] = await enrichLocationRows([location]);
      return res.json({
        success: true,
        data: {
          id: enriched.location_id,
          location_id: enriched.location_id,
          rack_no: enriched.rack_no,
          shelf_no: enriched.shelf_no,
          location_no: enriched.location_no || `${enriched.rack_no}${(enriched.shelf_no || "").toString().toUpperCase()}`,
          acc_name: enriched.acc_name,
          item_code: enriched.item_code,
          item_desc: enriched.item_desc,
          total_capacity: enriched.total_capacity
        }
      });
    }

    const fields = resolveLocationViewsSelectFields({ permission_module: req.body.permission_module, permission_action: req.body.permission_action });
    if (fields == null) {
      return res.status(400).json({
        success: false,
        message: "Invalid permission_module / permission_action for location views"
      });
    }

    const result = await findLocations({
      filters: {...sanitizeFilters(filters, CFG.filterFields), approved: true, is_deleted: false },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields,
      permission: req.permission
    });

    const enrichedRows = await enrichLocationRows(result.data || []);
    
    // If no results found with approved: true, check if there are any unapproved ones to provide feedback
    if (enrichedRows.length === 0 && !search && !id) {
      const anyLocations = await findLocations({
        filters: { is_deleted: false },
        limit: 1
      });
      if (anyLocations.total > 0) {
        return res.json({ 
          success: true, 
          data: [], 
          message: "No approved locations found. Please ensure locations are authorized in Location Master.",
          _debug_info: "Locations exist but might be unapproved or restricted by date."
        });
      }
    }

    return res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLocationViewById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });
    const location = await findLocation({ location_id: id });
    if (!location) return res.status(404).json({ success: false, message: "Location not found" });
    const [enriched] = await enrichLocationRows([location]);
    res.json({
      success: true,
      data: {
        id: enriched.location_id,
        location_id: enriched.location_id,
        rack_no: enriched.rack_no,
        shelf_no: enriched.shelf_no,
        location_no: enriched.location_no || `${enriched.rack_no}${(enriched.shelf_no || "").toString().toUpperCase()}`,
        acc_name: enriched.acc_name,
        item_code: enriched.item_code,
        item_desc: enriched.item_desc,
        total_capacity: enriched.total_capacity,
        approved: enriched.approved
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
