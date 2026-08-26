import { findLocations, findLocation, findLocationDuplicate, insertLocation, updateLocations, deleteLocations, LOCATION_DEFAULT_FIELDS } from "../models/storeLocationMaster.model.js";
import { LOCATION_APP_TYPE_RMSTORE, normalizeIntIds } from "../../../../ims/modules/location/models/locationMaster.model.js";
import { logRmstoreActivity } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";

const CFG = getCrudModuleConfig("rm_store_location_master");
const RACK_NO_NUMERIC_RE = /^\d+$/;
const ROW_NO_ALPHA_RE = /^[A-Za-z]+$/;
const APP_TYPE = LOCATION_APP_TYPE_RMSTORE;

function normalizeRowNo(value) {
  return value?.toString().trim().toUpperCase() || "";
}

function buildLocationNo(rackNo, rowNo) {
  return `${rackNo || ""}${(rowNo || "").toString().toUpperCase()}`;
}

function parseMultiIds(body, arrayKey, singleKey) {
  if (body?.[arrayKey] !== undefined) return normalizeIntIds(body[arrayKey]);
  if (body?.[singleKey] !== undefined) return normalizeIntIds(body[singleKey]);
  return undefined;
}

async function enrichLocationRows(rows = []) {
  if (!rows.length) return rows;
  const { itemMap, ledgerMap } = await getImsMapsSafe();

  return rows.map((row) => {
    const acc_codes = normalizeIntIds(
      Array.isArray(row.acc_codes) && row.acc_codes.length
        ? row.acc_codes
        : row.acc_code != null
          ? [row.acc_code]
          : []
    );
    const item_dcodes = normalizeIntIds(
      Array.isArray(row.item_dcodes) && row.item_dcodes.length
        ? row.item_dcodes
        : row.item_dcode != null
          ? [row.item_dcode]
          : []
    );
    const acc_names = acc_codes
      .map((c) => ledgerMap.get(canonicalCode(c)))
      .filter(Boolean);
    const item_labels = item_dcodes.map((d) => {
      const item = itemMap.get(canonicalCode(d));
      return item?.item_code || String(d);
    });
    const item_descs = item_dcodes
      .map((d) => itemMap.get(canonicalCode(d))?.item_desc)
      .filter(Boolean);

    return {
      ...row,
      acc_codes,
      item_dcodes,
      acc_code: acc_codes[0] ?? null,
      item_dcode: item_dcodes[0] ?? null,
      acc_name: acc_names.length ? acc_names.join(", ") : null,
      item_code: item_labels.length ? item_labels.join(", ") : null,
      item_desc: item_descs.length ? item_descs.join(", ") : null,
      acc_names,
      item_codes: item_labels,
    };
  });
}

function locationUniqueViolationMessage(err, locationNo = "") {
  const constraint = err?.constraint || "";
  const loc = locationNo ? ` "${locationNo}"` : "";

  if (constraint === "ims_location_master_pkey") {
    return "Could not save location: database ID is out of sync. Restart the backend server and try again.";
  }
  if (constraint === "location_master_rack_shelf_unique_active" || constraint === "location_master_rack_shelf_type_unique_active") {
    return loc
      ? `Location${loc} already exists for this RM rack and row.`
      : "A location with this RM rack and row already exists.";
  }
  if (constraint === "location_master_location_no_unique_active" || constraint === "location_master_location_no_type_unique_active") {
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

    const enrichedRows = await enrichLocationRows(result.data || []);
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

    const [enriched] = await enrichLocationRows(data ? [data] : []);
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
    const { rack_no, row_no, location_description, total_capacity, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    const normalizedRackNo = rack_no?.toString().trim();
    const normalizedRowNo = normalizeRowNo(row_no);
    locationNo = buildLocationNo(normalizedRackNo, normalizedRowNo);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code") ?? [];
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode") ?? [];

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

    const row = await insertLocation({
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
      location_no: locationNo,
      location_description: location_description?.toString().trim(),
      total_capacity,
      acc_codes,
      item_dcodes,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, });
      await updateLocations(approvalFields, { location_id: row.location_id });
    }

    const data = await findLocation({ location_id: row.location_id });

    await log(req, "create", row.location_id, { rack_no: normalizedRackNo, row_no: normalizedRowNo, location_no: locationNo, type: APP_TYPE, item_dcodes }, row);

    const authorized = normalizedApproved === true;
    return res.status(201).json({
      success: true,
      data: (await enrichLocationRows(data ? [data] : [row]))[0],
      toast_type: "success",
      message: authorized
        ? "Store location created and authorized."
        : "Store location created. Pending authorization.",
    });
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
    const { rack_no, row_no, location_description, total_capacity, approved } = req.body;
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(approved);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code");
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode");

    if (!id) return res.status(400).json({ success: false, message: "A valid store location ID is required." });

    const existing = await findLocation({ location_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Store location not found." });

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

    const hasBusinessChanges =
      rack_no !== undefined ||
      row_no !== undefined ||
      location_description !== undefined ||
      total_capacity !== undefined ||
      acc_codes !== undefined ||
      item_dcodes !== undefined;

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

    if (acc_codes !== undefined) fields.acc_codes = acc_codes;
    if (item_dcodes !== undefined) fields.item_dcodes = item_dcodes;

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

    await updateLocations(fields, { location_id: id });
    const data = await findLocation({ location_id: id });

    await log(req, "update", id, { updated_fields: fields });

    const authorized = fields.approved === true || data?.approved === true;
    return res.json({
      success: true,
      data: (await enrichLocationRows(data ? [data] : []))[0] ?? data,
      toast_type: "success",
      message: authorized
        ? "Store location updated and authorized."
        : hasBusinessChanges
          ? "Store location updated. Pending re-authorization."
          : "Store location set to pending.",
    });
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
      const location = await findLocation({ location_id: id, approved: true }, { fields: fields || LOCATION_DEFAULT_FIELDS });
      if (!location) return res.json({ success: true, data: null });
      return res.json({
        success: true,
        data: {
          id: location.location_id,
          location_id: location.location_id,
          rack_no: location.rack_no,
          row_no: location.row_no,
          location_no: location.location_no || `${location.rack_no}${(location.row_no || "").toString().toUpperCase()}`,
          type: location.type ?? APP_TYPE,
          acc_code: location.acc_code ?? null,
          acc_name: location.acc_name ?? null,
          location_description: location.location_description ?? null,
          total_capacity: location.total_capacity,
          occupied_capacity: location.occupied_capacity ?? 0,
          available_capacity: location.available_capacity ?? null,
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
      filters: {...sanitizeFilters(filters, CFG.filterFields), approved: true },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields,
      permission: req.permission
    });

    const rows = await enrichLocationRows(result.data || []);

    if (rows.length === 0 && !search && !id) {
      const anyLocations = await findLocations({
        filters: {},
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
