import {
  findLocations,
  findLocation,
  findLocationDuplicate,
  findProductionAreaTags,
  insertLocation,
  updateLocations,
  deleteLocations,
  LOCATION_DEFAULT_FIELDS,
} from "../models/productionLocationMaster.model.js";
import { LOCATION_APP_TYPE_PRODUCTION, normalizeIntIds, normalizeLocationRule } from "../../../../ims/modules/location/models/locationMaster.model.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, equalIntLists, normalizeApprovedInput, prepareUpdateByRules } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
const CFG = getCrudModuleConfig("production_location_master");
const RACK_NO_NUMERIC_RE = /^\d+$/;
const ROW_NO_ALPHA_RE = /^[A-Za-z]+$/;
const APP_TYPE = LOCATION_APP_TYPE_PRODUCTION;
const ENTITY = "production_location_master";

function normalizeRowNo(value) {
  return value?.toString().trim().toUpperCase() || "";
}

function toAreaTag(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

function tagFromLocationNo(locationNo) {
  const raw = String(locationNo || "").trim();
  const i = raw.indexOf("_");
  return i > 0 ? toAreaTag(raw.slice(0, i)) : "";
}

function buildProductionLocationCode(tag, rowNo, rackNo) {
  const t = toAreaTag(tag);
  const row = normalizeRowNo(rowNo);
  const rack = String(rackNo ?? "").trim();
  return `${t}_${row}_${rack}`;
}

async function resolveAreaTag(req, body, existing = null) {
  const raw =
    body?.area_tag ??
    (existing ? tagFromLocationNo(existing.location_no) || existing.process_tag : null);

  if (raw == null || String(raw).trim() === "") {
    throw Object.assign(new Error("Area is required."), { statusCode: 400 });
  }

  const tag = toAreaTag(raw);
  if (!tag) {
    throw Object.assign(new Error("Enter a valid area."), { statusCode: 400 });
  }

  const isSuper =
    String(req?.user?.type || req?.user?.role || "").toLowerCase().trim() === "super_admin";
  if (!isSuper) {
    const known = await findProductionAreaTags();
    const prior = existing ? tagFromLocationNo(existing.location_no) || toAreaTag(existing.process_tag) : "";
    if (!known.includes(tag) && tag !== prior) {
      throw Object.assign(
        new Error("Select an existing area or ask Super Admin to add a new one."),
        { statusCode: 403 },
      );
    }
  }
  return tag;
}

function prepareStoreLocationUpdate(existing, next = {}) {
  const base = {
    proccode: Number(existing.proccode) || null,
    rack_no: String(existing.rack_no ?? "").trim(),
    row_no: normalizeRowNo(existing.row_no),
    location_description: existing.location_description?.toString().trim() ?? "",
    total_capacity: Number(existing.total_capacity || 0),
    acc_codes: normalizeIntIds(
      Array.isArray(existing.acc_codes) && existing.acc_codes.length
        ? existing.acc_codes
        : existing.acc_code != null
          ? [existing.acc_code]
          : []
    ),
    item_dcodes: normalizeIntIds(
      Array.isArray(existing.item_dcodes) && existing.item_dcodes.length
        ? existing.item_dcodes
        : existing.item_dcode != null
          ? [existing.item_dcode]
          : []
    ),
    rule: normalizeLocationRule(existing.rule),
  };
  return prepareUpdateByRules({
    existing: base,
    input: next,
    rules: [
      { field: "proccode", normalize: (v) => Number(v) || null },
      { field: "rack_no", normalize: (v) => String(v ?? "").trim() },
      { field: "row_no", normalize: normalizeRowNo },
      { field: "location_description", normalize: (v) => v?.toString().trim() ?? "" },
      { field: "total_capacity", normalize: (v) => Number(v || 0) },
      { field: "acc_codes", normalize: normalizeIntIds, isEqual: equalIntLists },
      { field: "item_dcodes", normalize: normalizeIntIds, isEqual: equalIntLists },
      { field: "rule", normalize: normalizeLocationRule },
    ],
  });
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

    const areaTag =
      tagFromLocationNo(row.location_no) ||
      (row.process_tag ? toAreaTag(row.process_tag) : "");

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
      area_tag: areaTag || null,
      process_tag: row.process_tag || areaTag || null,
    };
  });
}

function locationUniqueViolationMessage(err, locationNo = "") {
  const constraint = err?.constraint || "";
  const loc = locationNo ? ` "${locationNo}"` : "";

  if (constraint === "ims_location_master_pkey") {
    return "Could not save location: database ID is out of sync. Restart the backend server and try again.";
  }
  if (
    constraint === "location_master_rack_shelf_unique_active" ||
    constraint === "location_master_rack_shelf_type_unique_active" ||
    constraint === "location_master_rack_slot_type_unique_active"
  ) {
    return loc
      ? `Location${loc} conflicts with another location on the same zone and number.`
      : "A location with this zone and number already exists.";
  }
  if (constraint === "location_master_location_no_unique_active" || constraint === "location_master_location_no_type_unique_active") {
    return loc
      ? `Location${loc} already exists.`
      : "This location code is already in use. Use a different area, zone, or number.";
  }
  if (err?.code === "23505") {
    return loc
      ? `Location${loc} could not be saved because a duplicate record exists.`
      : "Could not save location because a duplicate record exists.";
  }
  return err?.message || "Could not save location.";
}

const log = (req, action, entity_id, details, record = null, existing = null) =>
  logActivity(req, {
    action,
    entity: ENTITY,
    entity_id,
    appType: "production",
    details,
    record,
    existing,
  }).catch(() => {});

export const getLocations = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "location_id", order: "DESC" });

    const listFilters = sanitizeFilters(filters, CFG.filterFields);
    delete listFilters.from_date;
    delete listFilters.to_date;
    const result = await findLocations({
      filters: listFilters,
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
      return res.status(400).json({ success: false, message: "A valid production location ID is required." });
    }

    const data = await findLocation({ location_id: id });
    if (!data) {
      return res.status(404).json({ success: false, message: "Production location not found." });
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
    const { rack_no, row_no, location_description, approved } = req.body;
    const normalizedApproved = normalizeApprovedInput(approved);
    const normalizedRackNo = rack_no?.toString().trim();
    const normalizedRowNo = normalizeRowNo(row_no);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code") ?? [];
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode") ?? [];
    const rule = item_dcodes.length ? normalizeLocationRule(req.body?.rule ?? req.body?.restriction_mode) : "include";

    let tag;
    try {
      tag = await resolveAreaTag(req, req.body);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ success: false, message: err.message });
    }

    if (!normalizedRackNo) {
      return res.status(400).json({ success: false, message: "Rack is required." });
    }
    if (!RACK_NO_NUMERIC_RE.test(normalizedRackNo)) {
      return res.status(400).json({ success: false, message: "Rack must contain numbers only." });
    }
    if (!normalizedRowNo) {
      return res.status(400).json({ success: false, message: "Row is required." });
    }
    if (!ROW_NO_ALPHA_RE.test(normalizedRowNo)) {
      return res.status(400).json({ success: false, message: "Row must contain letters only." });
    }
    locationNo = buildProductionLocationCode(tag, normalizedRowNo, normalizedRackNo);

    const duplicate = await findLocationDuplicate({
      location_no: locationNo,
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Location "${locationNo}" already exists for this area, zone, and number.`,
      });
    }

    const row = await insertLocation({
      proccode: null,
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
      location_no: locationNo,
      location_description: location_description?.toString().trim(),
      total_capacity: 0,
      acc_codes,
      item_dcodes,
      rule,
      created_by: auditUserName(req),
    });

    if (normalizedApproved === true) {
      const approvalFields = {};
      applyApprovalWorkflow({ req, fields: approvalFields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true, });
      await updateLocations(approvalFields, { location_id: row.location_id });
    }

    const data = await findLocation({ location_id: row.location_id });

    await log(req, "create", row.location_id, {
      area_tag: tag,
      rack_no: normalizedRackNo,
      row_no: normalizedRowNo,
      location_no: locationNo,
      type: APP_TYPE,
      item_dcodes,
      rule,
    }, row);

    const authorized = normalizedApproved === true;
    return res.status(201).json({
      success: true,
      data: (await enrichLocationRows(data ? [data] : [row]))[0],
      toast_type: "success",
      message: authorized
        ? "Production location created and authorized."
        : "Production location created. Pending authorization.",
    });
  } catch (err) {
    console.error("[production/location/create]", err?.message || err);
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
    const { rack_no, row_no, location_description, approved } = req.body;
    const areaTagTouched = req.body?.area_tag !== undefined;
    const id = parsePositiveIntId(req.body?.id);
    const normalizedApproved = normalizeApprovedInput(approved);
    const acc_codes = parseMultiIds(req.body, "acc_codes", "acc_code");
    const item_dcodes = parseMultiIds(req.body, "item_dcodes", "item_dcode");

    if (!id) return res.status(400).json({ success: false, message: "A valid production location ID is required." });

    const existing = await findLocation({ location_id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Production location not found." });

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

    const ruleRaw = req.body?.rule !== undefined ? req.body.rule : req.body?.restriction_mode;
    const rule =
      ruleRaw !== undefined
        ? normalizeLocationRule(ruleRaw)
        : item_dcodes !== undefined && !normalizeIntIds(item_dcodes).length
          ? "include"
          : undefined;

    const { hasChanges: hasBusinessChanges, fields: preparedFields } = prepareStoreLocationUpdate(existing, {
      rack_no,
      row_no,
      location_description,
      acc_codes,
      item_dcodes,
      rule,
    });

    const tagOrSlotTouched =
      areaTagTouched ||
      (hasBusinessChanges && (preparedFields.rack_no !== undefined || preparedFields.row_no !== undefined));

    if (!hasBusinessChanges && normalizedApproved === undefined && !tagOrSlotTouched) {
      return res.status(400).json({ success: false, message: "There are no fields to update." });
    }

    if (preparedFields.rack_no !== undefined && (!preparedFields.rack_no || !RACK_NO_NUMERIC_RE.test(preparedFields.rack_no))) {
      return res.status(400).json({ success: false, message: "Rack must contain numbers only." });
    }
    if (preparedFields.row_no !== undefined) {
      if (!preparedFields.row_no) {
        return res.status(400).json({ success: false, message: "Row is required." });
      }
      if (!ROW_NO_ALPHA_RE.test(preparedFields.row_no)) {
        return res.status(400).json({ success: false, message: "Row must contain letters only." });
      }
    }
    const fields = hasBusinessChanges ? { ...preparedFields } : {};
    if (tagOrSlotTouched) {
      const nextRackNo = preparedFields.rack_no ?? existing.rack_no;
      const nextRowNo = preparedFields.row_no ?? existing.row_no;
      let tag;
      try {
        tag = await resolveAreaTag(req, req.body, existing);
      } catch (err) {
        return res.status(err.statusCode || 400).json({ success: false, message: err.message });
      }
      fields.location_no = buildProductionLocationCode(tag, nextRowNo, nextRackNo);
      fields.proccode = null;
      locationNo = fields.location_no;

      const duplicate = await findLocationDuplicate({
        location_no: fields.location_no,
        rack_no: nextRackNo,
        row_no: nextRowNo,
        excludeLocationId: id,
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Location "${fields.location_no}" already exists for this area, zone, and number.`,
        });
      }
    }

    if (fields.item_dcodes !== undefined && !normalizeIntIds(fields.item_dcodes).length) {
      fields.rule = "include";
    } else if (fields.rule !== undefined) {
      fields.rule = normalizeLocationRule(fields.rule);
    }

    const effectiveBusinessChanges = hasBusinessChanges || tagOrSlotTouched;

    applyApprovalUpdateFields({
      req,
      fields,
      incomingApproved: normalizedApproved,
      hasBusinessChanges: effectiveBusinessChanges,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
    });

    await updateLocations(fields, { location_id: id });
    const data = await findLocation({ location_id: id });

    await log(req, "update", id, hasBusinessChanges
        ? { updated_fields: fields }
        : { approval_only: true, approved: fields.approved === true },
      null,
      existing
    );

    const authorized = fields.approved === true || data?.approved === true;
    return res.json({
      success: true,
      data: (await enrichLocationRows(data ? [data] : []))[0] ?? data,
      toast_type: "success",
      message: authorized
        ? "Production location updated and authorized."
        : effectiveBusinessChanges
          ? "Production location updated. Pending re-authorization."
          : "Production location set to pending.",
    });
  } catch (err) {
    console.error("[production/location/update]", err?.message || err);
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
      return res.status(400).json({ success: false, message: "A valid production location ID is required." });
    }

    const existing = await findLocation({ location_id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Production location not found." });
    }

    await deleteLocations(
      { location_id: id },
      { deleted_by: auditUserName(req)}
    );

    await log(req, "delete", id, { rack_no: existing.rack_no, row_no: existing.row_no }, existing);

    return res.json({ success: true, message: "Production location deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getProductionAreaTags = async (req, res) => {
  try {
    const search = req.body?.search;
    const tags = await findProductionAreaTags({ search });
    return res.json({
      success: true,
      data: tags.map((area) => ({ id: area, area })),
    });
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
          message: "No approved locations found. Please ensure locations are authorized in Production Location Master.",
          _debug_info: "Locations exist but might be unapproved.",
        });
      }
    }

    return res.json({ success: true, ...result, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
