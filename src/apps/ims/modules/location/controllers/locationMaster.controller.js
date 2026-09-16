import { findLocations, findLocation, findLocationDuplicate, insertLocation, updateLocations, deleteLocations, LOCATION_DEFAULT_FIELDS, LOCATION_APP_TYPE_IMS, normalizeIntIds, normalizeLocationRule } from "../models/locationMaster.model.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput, applyApprovalUpdateFields, prepareUpdateByRules, equalIntLists } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { getImsMapsSafe, canonicalCode } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import logger from "../../../../core/lib/utils/logging/logger.js";

const CFG = getCrudModuleConfig("location_master");
const RACK_NO_NUMERIC_RE = /^\d+$/;
const SHELF_NO_ALPHA_RE = /^[A-Za-z]+$/;
const APP_TYPE = LOCATION_APP_TYPE_IMS;

function parseMultiIds(body, arrayKey, singleKey) {
  if (body?.[arrayKey] !== undefined) return normalizeIntIds(body[arrayKey]);
  if (body?.[singleKey] !== undefined) return normalizeIntIds(body[singleKey]);
  return undefined;
}

function prepareLocationUpdate(existing, next = {}) {
  const rules = [
    { field: "rack_no", normalize: (v) => String(v ?? "").trim() },
    { field: "shelf_no", normalize: normalizeShelfNo },
    { field: "location_description", normalize: (v) => v?.toString().trim() },
    { field: "total_capacity", normalize: (v) => Number(v || 0) },
    { field: "acc_codes", normalize: normalizeIntIds, isEqual: (a, b) => equalIntLists(a, b) },
    { field: "item_dcodes", normalize: normalizeIntIds, isEqual: (a, b) => equalIntLists(a, b) },
    { field: "rule", normalize: normalizeLocationRule },
  ];
  return prepareUpdateByRules({ existing, input: next, rules });
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

function normalizeShelfNo(value) {
  return value?.toString().trim().toUpperCase() || "";
}
function buildLocationNo(rackNo, shelfNo) {
  return `${rackNo || ""}${(shelfNo || "").toString().toUpperCase()}`;
}

function locationUniqueViolationMessage(err, locationNo = "") {
  const constraint = err?.constraint || "";
  const loc = locationNo ? ` "${locationNo}"` : "";

  if (constraint === "ims_location_master_pkey") {
    return "Could not save location: database ID is out of sync. Restart the backend server and try again.";
  }
  if (constraint === "location_master_rack_shelf_unique_active" || constraint === "location_master_rack_shelf_type_unique_active") {
    return loc
      ? `Location${loc} already exists for this rack and shelf.`
      : "A location with this rack and shelf number already exists.";
  }
  if (constraint === "location_master_location_no_unique_active" || constraint === "location_master_location_no_type_unique_active") {
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

const log = (req, action, entity_id, details, record = null) =>
  logActivity(req, {
    action,
    entity: "location_master",
    entity_id,
    details,
    record,
  }).catch(() => {});

export const getLocations = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "location_id", order: "DESC" });

    const result = await findLocations({
      filters: { ...sanitizeFilters(filters, CFG.filterFields), type: APP_TYPE },
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
      return res.status(400).json({ success: false, message: "Valid ID required" });
    }

    const data = await findLocation({ location_id: id, type: APP_TYPE });
    if (!data) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const [enriched] = await enrichLocationRows([data]);
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
    const { rack_no, shelf_no, location_description, total_capacity, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    const normalizedRackNo = rack_no?.toString().trim();
    const normalizedShelfNo = normalizeShelfNo(shelf_no);
    locationNo = buildLocationNo(normalizedRackNo, normalizedShelfNo);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code") ?? [];
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode") ?? [];
    const rule = item_dcodes.length
      ? normalizeLocationRule(req.body?.rule ?? req.body?.restriction_mode)
      : "include";

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
      type: APP_TYPE,
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
      type: APP_TYPE,
      location_description: location_description?.toString().trim(),
      total_capacity,
      acc_codes,
      item_dcodes,
      rule,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, approvalTimestamp: row?.created_at || new Date() });
      await updateLocations(approvalFields, { location_id: row.location_id });
    }

    const data = await findLocation({ location_id: row.location_id, type: APP_TYPE });
    const [enriched] = await enrichLocationRows(data ? [data] : []);

    await log(req, "create", row.location_id, { rack_no: normalizedRackNo, shelf_no: normalizedShelfNo, location_no: locationNo, type: APP_TYPE, acc_codes, item_dcodes, rule }, row);

    return res.status(201).json({ success: true, data: enriched ?? data, message: "Location created successfully" });
  } catch (err) {
    logger.error(`Error creating location: ${err?.message || err}`);
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
    const { rack_no, shelf_no, location_description, total_capacity, approved } = req.body;
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(approved);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code");
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode");
    const ruleRaw = req.body?.rule !== undefined ? req.body.rule : req.body?.restriction_mode;
    const rule =
      ruleRaw !== undefined
        ? normalizeLocationRule(ruleRaw)
        : undefined;

    if (!id) return res.status(400).json({ success: false, message: "Valid ID required" });

    const existing = await findLocation({ location_id: id, type: APP_TYPE });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

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

    const { hasChanges: hasBusinessChanges, fields: preparedFields } = prepareLocationUpdate(existing, { rack_no, shelf_no, location_description, total_capacity, acc_codes, item_dcodes, rule });

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

    const fields = { ...preparedFields, type: APP_TYPE };
    const resolvedItems = fields.item_dcodes !== undefined
      ? fields.item_dcodes
      : normalizeIntIds(
          Array.isArray(existing.item_dcodes) && existing.item_dcodes.length
            ? existing.item_dcodes
            : existing.item_dcode != null
              ? [existing.item_dcode]
              : []
        );
    if (resolvedItems.length === 0) {
      fields.rule = "include";
    } else if (fields.rule !== undefined) {
      fields.rule = normalizeLocationRule(fields.rule);
    }

    const finalRackNo = fields.rack_no ?? existing.rack_no;
    const finalShelfNo = fields.shelf_no ?? existing.shelf_no;
    fields.location_no = buildLocationNo(finalRackNo, finalShelfNo);
    locationNo = fields.location_no;

    if (fields.rack_no !== undefined || fields.shelf_no !== undefined) {
      const duplicate = await findLocationDuplicate({
        rack_no: finalRackNo,
        shelf_no: finalShelfNo,
        type: APP_TYPE,
        excludeLocationId: id,
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Location "${fields.location_no}" already exists for this rack and shelf`,
        });
      }
    }

    applyApprovalUpdateFields({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges, alreadyApproved: existing.approved === true, auditAsName: true });

    const updated = await updateLocations(fields, { location_id: id });
    const data = await findLocation({ location_id: id, type: APP_TYPE });

    await log(req, "update", id, { updated_fields: fields });

    const [enriched] = await enrichLocationRows(data ? [data] : updated ? [updated] : []);
    return res.json({ success: true, data: enriched ?? data ?? updated, message: "Location updated successfully" });
  } catch (err) {
    logger.error(`Error updating location: ${err?.message || err}`);
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
      return res.status(400).json({ success: false, message: "Valid ID required" });
    }

    const existing = await findLocation({ location_id: id, type: APP_TYPE });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deleteLocations(
      { location_id: id },
      { deleted_by: auditUserName(req)}
    );

    await log(req, "delete", id, { rack_no: existing.rack_no, shelf_no: existing.shelf_no }, existing);

    return res.json({ success: true, message: "Location deleted successfully" });
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
      const location = await findLocation({ location_id: id, approved: true, type: APP_TYPE }, { fields: fields || LOCATION_DEFAULT_FIELDS });
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
          type: enriched.type ?? APP_TYPE,
          acc_name: enriched.acc_name,
          item_code: enriched.item_code,
          item_desc: enriched.item_desc,
          location_description: enriched.location_description ?? null,
          total_capacity: enriched.total_capacity,
          occupied_capacity: enriched.occupied_capacity ?? 0,
          available_capacity: enriched.available_capacity ?? null,
          box_count: enriched.box_count
        }
      });
    }

    const fields = resolveViewsFields("locations", {
      permission_module: req.body.permission_module,
      permission_action: req.body.permission_action,
    });

    const result = await findLocations({
      filters: { ...sanitizeFilters(filters, CFG.filterFields), approved: true, type: APP_TYPE },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields,
    });

    const enrichedRows = await enrichLocationRows(result.data || []);

    if (enrichedRows.length === 0 && !search && !id) {
      const anyLocations = await findLocations({
        filters: { type: APP_TYPE },
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
