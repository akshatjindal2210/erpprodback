import { findLocations, findLocation, findLocationDuplicate, insertLocation, updateLocations, deleteLocations, LOCATION_DEFAULT_FIELDS } from "../models/storeLocationMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { loadMappedItems } from "../../production/utils/erpItems.js";

const CFG = getCrudModuleConfig("rm_store_location_master");
const RACK_NO_NUMERIC_RE = /^\d+$/;
const ROW_NO_ALPHA_RE = /^[A-Za-z]+$/;

function normalizeRowNo(value) {
  return value?.toString().trim().toUpperCase() || "";
}

/** Loc No format: RM-{rack}{row} e.g. RM-12A */
function buildLocationNo(rackNo, rowNo) {
  return `RM-${rackNo || ""}${(rowNo || "").toString().toUpperCase()}`;
}

/** Optional item_dcode → null, or positive int. */
function parseOptionalItemDcode(value) {
  if (value === undefined) return { provided: false, value: undefined };
  if (value === null || value === "") return { provided: true, value: null };
  const n = parsePositiveIntId(value);
  if (!n) return { provided: true, error: "RM item code must be a valid number." };
  return { provided: true, value: n };
}

async function resolveRmItemSnapshot(item_dcode) {
  if (item_dcode == null) return { item_dcode: null, item_code: null, item_desc: null };
  try {
    const rows = await loadMappedItems("item", { type: "rm" });
    const raw = rows.find((r) => String(r.itemdcode) === String(item_dcode));
    return {
      item_dcode,
      item_code: raw?.item_code ?? null,
      item_desc: raw?.itemdesc ?? null,
    };
  } catch {
    // Still persist item_dcode if ERP lookup is temporarily unavailable
    return { item_dcode, item_code: null, item_desc: null };
  }
}

/** Map Postgres unique violations to the correct user-facing message. */
function locationUniqueViolationMessage(err, locationNo = "") {
  const constraint = err?.constraint || "";
  const loc = locationNo ? ` "${locationNo}"` : "";

  if (constraint === "rmstore_master_location_pkey") {
    return "Could not save location: database ID is out of sync. Restart the backend server and try again.";
  }
  if (constraint === "rmstore_master_location_rack_row_unique_active") {
    return loc
      ? `Location${loc} already exists for this RM rack and row.`
      : "A location with this RM rack and row already exists.";
  }
  if (constraint === "rmstore_master_location_location_no_unique_active") {
    return loc
      ? `Location number${loc} is already in use.`
      : "This location number is already in use. Use a different rack or row combination.";
  }
  if (err?.code === "23505") {
    return loc
      ? `Location${loc} could not be saved because a duplicate record exists.`
      : "Could not save location because a duplicate record exists.";
  }
  return err?.message || "Could not save location.";
}

const log = (req, action, entity_id, details, record = null) =>
  logRmstoreActivity(req, {
    action,
    entity: "rm_store_location_master",
    entity_id,
    details,
    record,
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

    const enrichedRows = result.data || [];
    return res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLocationById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid store location ID is required." });
    }

    const data = await findLocation({ location_id: id });
    if (!data) {
      return res.status(404).json({ success: false, message: "Store location not found." });
    }

    const [enriched] = data ? [data] : [];
    return res.json({ 
      success: true, 
      data: {
        ...enriched,
        id: enriched.location_id
      } 
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createLocation = async (req, res) => {
  let locationNo = "";
  try {
    const { rack_no, row_no, location_description, total_capacity, item_dcode, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    const normalizedRackNo = rack_no?.toString().trim();
    const normalizedRowNo = normalizeRowNo(row_no);
    locationNo = buildLocationNo(normalizedRackNo, normalizedRowNo);
    const itemParsed = parseOptionalItemDcode(item_dcode);

    if (!normalizedRackNo) {
      return res.status(400).json({ success: false, message: "RM rack is required." });
    }
    if (!RACK_NO_NUMERIC_RE.test(normalizedRackNo)) {
      return res.status(400).json({ success: false, message: "RM rack must contain numbers only." });
    }
    if (!normalizedRowNo) {
      return res.status(400).json({ success: false, message: "RM row is required." });
    }
    if (!ROW_NO_ALPHA_RE.test(normalizedRowNo)) {
      return res.status(400).json({ success: false, message: "RM row must contain letters only." });
    }

    if (total_capacity !== undefined && Number.isNaN(Number(total_capacity))) {
      return res.status(400).json({ success: false, message: "Capacity must be a valid number." });
    }
    if (itemParsed.error) {
      return res.status(400).json({ success: false, message: itemParsed.error });
    }

    const duplicate = await findLocationDuplicate({
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Location "${locationNo}" already exists for this RM rack and row.`,
      });
    }

    const itemSnap = await resolveRmItemSnapshot(itemParsed.provided ? itemParsed.value : null);

    const row = await insertLocation({
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
      location_no: locationNo,
      location_description: location_description?.toString().trim(),
      total_capacity,
      item_dcode: itemSnap.item_dcode,
      item_code: itemSnap.item_code,
      item_desc: itemSnap.item_desc,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, });
      await updateLocations(approvalFields, { location_id: row.location_id });
    }

    const data = await findLocation({ location_id: row.location_id });

    await log(req, "create", row.location_id, { rack_no: normalizedRackNo, row_no: normalizedRowNo, location_no: locationNo, item_dcode: itemSnap.item_dcode }, row);

    return res.status(201).json({ success: true, data: data ?? row, message: "Store location created successfully." });
  } catch (err) {
    console.error("[rmstore/store-location/create]", err?.message || err);
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
    const { rack_no, row_no, location_description, total_capacity, item_dcode, approved } = req.body;
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(approved);
    const itemParsed = parseOptionalItemDcode(item_dcode);

    if (!id) return res.status(400).json({ success: false, message: "A valid store location ID is required." });

    const existing = await findLocation({ location_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Store location not found." });

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

    if (itemParsed.error) {
      return res.status(400).json({ success: false, message: itemParsed.error });
    }

    const hasBusinessChanges =
      rack_no !== undefined ||
      row_no !== undefined ||
      location_description !== undefined ||
      total_capacity !== undefined ||
      itemParsed.provided;

    if (!hasBusinessChanges && normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    if (rack_no !== undefined && (!rack_no?.toString().trim() || !RACK_NO_NUMERIC_RE.test(rack_no?.toString().trim()))) {
      return res.status(400).json({ success: false, message: "RM rack must contain numbers only." });
    }
    if (row_no !== undefined) {
      const normalizedRowNo = normalizeRowNo(row_no);
      if (!normalizedRowNo) {
        return res.status(400).json({ success: false, message: "RM row is required." });
      }
      if (!ROW_NO_ALPHA_RE.test(normalizedRowNo)) {
        return res.status(400).json({ success: false, message: "RM row must contain letters only." });
      }
    }

    const fields = {
      ...(rack_no !== undefined && { rack_no: rack_no?.toString().trim() }),
      ...(row_no !== undefined && { row_no: normalizeRowNo(row_no) }),
      ...(location_description !== undefined && { location_description: location_description?.toString().trim() }),
      ...(total_capacity !== undefined && { total_capacity }),
      updated_by: auditUserName(req),
      updated_at: new Date(),
    };

    if (itemParsed.provided) {
      const itemSnap = await resolveRmItemSnapshot(itemParsed.value);
      fields.item_dcode = itemSnap.item_dcode;
      fields.item_code = itemSnap.item_code;
      fields.item_desc = itemSnap.item_desc;
    }

    const nextRackNo = fields.rack_no ?? existing.rack_no;
    const nextRowNo = fields.row_no ?? existing.row_no;
    fields.location_no = buildLocationNo(nextRackNo, nextRowNo);
    locationNo = fields.location_no;

    if (rack_no !== undefined || row_no !== undefined) {
      const duplicate = await findLocationDuplicate({
        rack_no: nextRackNo,
        row_no: nextRowNo,
        excludeLocationId: id,
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Location "${fields.location_no}" already exists for this RM rack and row.`,
        });
      }
    }

    applyApprovalWorkflow({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges,
      auditAsName: true,
    });

    const updated = await updateLocations(fields, { location_id: id });

    await log(req, "update", id, { updated_fields: fields });

    return res.json({ success: true, data: updated, message: "Store location updated successfully." });
  } catch (err) {
    console.error("[rmstore/store-location/update]", err?.message || err);
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
    const id = parsePositiveIntId(req.body?.id);

    if (!id) {
      return res.status(400).json({ success: false, message: "A valid store location ID is required." });
    }

    const existing = await findLocation({ location_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Store location not found." });
    }

    await deleteLocations(
      { location_id: id },
      { deleted_by: auditUserName(req)}
    );
    
    await log(req, "delete", id, { rack_no: existing.rack_no, row_no: existing.row_no }, existing);

    return res.json({ success: true, message: "Store location deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLocationsViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "location_no", order: "ASC" });

    if (id) {
      const fields = resolveViewsFields("locations", {
        permission_module: req.body.permission_module,
        permission_action: req.body.permission_action,
      });
      const location = await findLocation({ location_id: id, approved: true, is_deleted: false }, { fields: fields || LOCATION_DEFAULT_FIELDS });
      if (!location) return res.json({ success: true, data: null });
      return res.json({
        success: true,
        data: {
          id: location.location_id,
          location_id: location.location_id,
          rack_no: location.rack_no,
          row_no: location.row_no,
          location_no: location.location_no || `RM-${location.rack_no}${(location.row_no || "").toString().toUpperCase()}`,
          location_description: location.location_description ?? null,
          total_capacity: location.total_capacity,
          item_dcode: location.item_dcode ?? null,
          item_code: location.item_code ?? null,
          item_desc: location.item_desc ?? null,
        }
      });
    }

    const fields = resolveViewsFields("locations", {
      permission_module: req.body.permission_module,
      permission_action: req.body.permission_action,
    });

    const result = await findLocations({
      filters: {...sanitizeFilters(filters, CFG.filterFields), approved: true, is_deleted: false },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields,
      permission: req.permission
    });

    const rows = result.data || [];

    // If no results found with approved: true, check if there are any unapproved ones to provide feedback
    if (rows.length === 0 && !search && !id) {
      const anyLocations = await findLocations({
        filters: { is_deleted: false },
        limit: 1
      });
      if (anyLocations.total > 0) {
        return res.json({ 
          success: true, 
          data: [], 
          message: "No approved locations found. Please ensure locations are authorized in RM Store Location Master.",
          _debug_info: "Locations exist but might be unapproved or restricted by date."
        });
      }
    }

    return res.json({ success: true, ...result, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
