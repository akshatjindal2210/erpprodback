import { findInventoryInwards, findInventoryInward, insertInventoryInward, updateInventoryInwards, deleteInventoryInwards, resetBoxesForInward } from "../models/inventoryInward.model.js";

import { logActivity } from "../utils/activityLogger.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import {
  getPackingNumberFromBox,
  updateBoxesAfterInward,
  getDistinctPackingNumbersFromBoxNoUids,
  findInHandBoxesByScanCodes,
  findBoxesByScanCodesAny,
  matchBoxRowByScanCode,
  inwardScanRejectMessage,
} from "../models/box.model.js";
import { logInwardLinkBatch } from "../utils/logBoxTransaction.js";
import { sanitizeSearch } from "../utils/helper.js";
import { validateInwardLocationsAgainstBoxes, validateSingleBoxAtLocation, validateBoxesAtLocationBatch, isInwardLocationValidationEnabled } from "../utils/inwardLocationValidation.js";

const INWARD_CFG = getCrudModuleConfig("inventory_inwards");

/** Client may send `boxes: ["uid"]` or `boxes: [{ box_no_uid, qty }]`. DB only needs box_no_uid. */
function inwardBoxNoUids(boxes) {
  if (!Array.isArray(boxes)) return [];
  return boxes
    .map((b) => {
      if (b == null) return null;
      if (typeof b === "string" || typeof b === "number") return String(b).trim();
      if (typeof b === "object" && b.box_no_uid != null) return String(b.box_no_uid).trim();
      return null;
    })
    .filter(Boolean);
}

function uniqueBoxNoUidsFromLocations(locations) {
  const set = new Set();
  for (const loc of locations || []) {
    for (const id of inwardBoxNoUids(loc?.boxes)) {
      set.add(id);
    }
  }
  return [...set];
}

/** One header string: all distinct packings across every box on this inward (e.g. `PN1 | PN2`). */
async function resolveAggregatePackingForLocations(locations) {
  const ids = uniqueBoxNoUidsFromLocations(locations);
  if (!ids.length) return null;
  let list = await getDistinctPackingNumbersFromBoxNoUids(ids);
  if (!list.length) {
    const fb = await getPackingNumberFromBox(ids[0]);
    if (fb != null && String(fb).trim() !== "") list = [String(fb).trim()];
  }
  return list.length ? list.join(" | ") : null;
}

// ─── GET LIST ─────────────────────────────
export const getInventoryInwards = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC"
    });

    const result = await findInventoryInwards({
      filters: sanitizeFilters(filters, INWARD_CFG.filterFields),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: INWARD_CFG.listFields,
      permission: req.permission
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET BY ID ────────────────────────────
export const getInventoryInwardById = async (req, res) => {
  try {
    const { in_uid } = req.body;

    if (!in_uid) {
      return res.status(400).json({ success: false, message: "in_uid required" });
    }

    const data = await findInventoryInward({ in_uid });

    if (!data) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE ──────────────────────────────
export const createInventoryInward = async (req, res) => {
  try {
    const { remarks, locations } = req.body;
    const userId = req.user.id;

    if (!locations || locations.length === 0) {
      return res.status(400).json({ success: false, message: "Locations and boxes are required" });
    }

    if (await isInwardLocationValidationEnabled()) {
      const locErr = await validateInwardLocationsAgainstBoxes(locations);
      if (locErr) return res.status(400).json({ success: false, message: locErr });
    }

    // 1. All boxes across locations → distinct packing numbers (Store In can mix multiple packings)
    const packingNumber = await resolveAggregatePackingForLocations(locations);

    if (!packingNumber) {
      return res.status(400).json({ success: false, message: "Packing number not found for these boxes" });
    }

    // 2. Primary Record Insert
    const row = await insertInventoryInward({ 
      packing_number: packingNumber, 
      remarks, 
      approved: true,
      approved_by: userId,
      approved_at: new Date(),
      created_by: userId 
    });

    // 3. Child Records Update (Box Table)
    const linkResults = await Promise.all(
      locations.map((loc) =>
        updateBoxesAfterInward(row.in_uid, loc.location_id, inwardBoxNoUids(loc.boxes), userId, { logEvent: false })
      )
    );
    logInwardLinkBatch({ in_uid: row.in_uid, userId, rowGroups: linkResults });

    // 4. Fetch Full Created Object (for response consistency)
    const data = await findInventoryInward({ in_uid: row.in_uid });

    await logActivity(req, { action: "create", entity: "inventory_inwards", entity_id: row.in_uid });

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE ──────────────────────────────
export const updateInventoryInward = async (req, res) => {
  try {
    const { in_uid, remarks, locations } = req.body;
    const userId = req.user.id;

    if (!in_uid) {
      return res.status(400).json({ success: false, message: "in_uid required" });
    }

    const existing = await findInventoryInward({ in_uid });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

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

    const fields = {
      ...(remarks !== undefined && { remarks }),
      approved: true,
      approved_by: userId,
      approved_at: existing.approved_at || new Date(),
      updated_by: userId,
      updated_at: new Date()
    };

    // Recompute header packing when full location/box payload is sent (multi-packing support)
    if (locations && locations.length > 0) {
      const agg = await resolveAggregatePackingForLocations(locations);
      if (agg) fields.packing_number = agg;
    }

    // 1. Update Master Record
    await updateInventoryInwards(fields, { in_uid });

    // 2. Update Child Records (Boxes) if locations provided
    if (locations && locations.length > 0) {
      if (await isInwardLocationValidationEnabled()) {
        const locErr = await validateInwardLocationsAgainstBoxes(locations);
        if (locErr) return res.status(400).json({ success: false, message: locErr });
      }
      // First, reset existing boxes for this in_uid (set in_uid and location_id to null)
      await resetBoxesForInward(in_uid, userId);

      // Then, update new boxes
      const linkResults = await Promise.all(
        locations.map((loc) =>
          updateBoxesAfterInward(in_uid, loc.location_id, inwardBoxNoUids(loc.boxes), userId, { logEvent: false })
        )
      );
      logInwardLinkBatch({ in_uid, userId, rowGroups: linkResults });
    }

    const data = await findInventoryInward({ in_uid });

    await logActivity(req, { 
      action: "update", 
      entity: "inventory_inwards", 
      entity_id: in_uid,
      details: { updated_fields: fields }
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// ─── BATCH SCAN BOXES (resolve + validate in one round-trip) ────
export const batchScanInwardBoxes = async (req, res) => {
  try {
    const { location_id, items } = req.body;
    const lid = parseInt(String(location_id), 10);

    if (!Number.isFinite(lid) || lid <= 0) {
      return res.status(400).json({ success: false, message: "location_id is required" });
    }

    const scanItems = Array.isArray(items) ? items : [];
    if (!scanItems.length) {
      return res.status(400).json({ success: false, message: "items array is required" });
    }
    if (scanItems.length > 50) {
      return res.status(400).json({ success: false, message: "Maximum 50 scans per request" });
    }

    const normalizedItems = scanItems.map((item, index) => ({
      id: item?.id != null ? String(item.id) : String(index),
      code: item?.code != null ? String(item.code).trim() : "",
    }));

    const codes = normalizedItems.map((item) => item.code).filter(Boolean);
    const [boxRows, anyRows] = await Promise.all([
      findInHandBoxesByScanCodes(codes),
      findBoxesByScanCodesAny(codes),
    ]);

    const resolved = normalizedItems.map((item) => ({
      ...item,
      row: item.code ? matchBoxRowByScanCode(boxRows, item.code) : null,
      anyRow: item.code ? matchBoxRowByScanCode(anyRows, item.code) : null,
    }));

    const boxNoUids = [
      ...new Set(
        resolved
          .map((entry) => (entry.row?.box_no_uid != null ? String(entry.row.box_no_uid).trim() : ""))
          .filter(Boolean)
      ),
    ];

    const validation = await validateBoxesAtLocationBatch(lid, boxNoUids);
    const validationMap = new Map((validation.results || []).map((row) => [String(row.box_no_uid).trim(), row]));

    const results = resolved.map(({ id, code, row, anyRow }) => {
      if (!code) {
        return {
          id,
          found: false,
          box_no_uid: null,
          qty: 0,
          packing_number: null,
          allowed: false,
          message: "Invalid box scan",
        };
      }
      if (!row?.box_no_uid) {
        return {
          id,
          found: false,
          box_no_uid: anyRow?.box_no_uid != null ? String(anyRow.box_no_uid).trim() : null,
          qty: 0,
          packing_number: null,
          allowed: false,
          message: inwardScanRejectMessage(anyRow),
        };
      }

      const uid = String(row.box_no_uid).trim();
      const val = validationMap.get(uid) || { allowed: true, message: null };
      const qty = Number(row.qty);
      const packing_number =
        row.packing_number != null && String(row.packing_number).trim() !== ""
          ? String(row.packing_number).trim()
          : null;

      return {
        id,
        found: true,
        box_no_uid: uid,
        qty: Number.isFinite(qty) ? qty : 0,
        packing_number,
        allowed: !!val.allowed,
        message: val.message || null,
      };
    });

    return res.json({
      success: true,
      validation_enabled: validation.validation_enabled,
      results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── VALIDATE BOX AT LOCATION (scan-time) ───────────────────────
export const validateInwardBoxAtLocation = async (req, res) => {
  console.time("API_Execution");
  try {
    const { location_id, box_no_uid } = req.body;
    const lid = parseInt(String(location_id), 10);
    const uid = box_no_uid != null ? String(box_no_uid).trim() : "";

    if (!Number.isFinite(lid) || lid <= 0 || !uid) {
      return res.status(400).json({
        success: false,
        message: "location_id and box_no_uid are required",
      });
    }

    const validation_enabled = await isInwardLocationValidationEnabled();
    if (!validation_enabled) {
      return res.json({ success: true, validation_enabled: false, allowed: true, message: null });
    }

    const result = await validateSingleBoxAtLocation(lid, uid);
    return res.json({ success: true, validation_enabled: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    console.timeEnd("API_Execution");
  }
};

// ─── DELETE (SOFT) ───────────────────────
export const deleteInventoryInward = async (req, res) => {
  try {
    const { in_uid } = req.body;

    if (!in_uid) {
      return res.status(400).json({ success: false, message: "in_uid required" });
    }

    const existing = await findInventoryInward({ in_uid });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deleteInventoryInwards(
      { in_uid },
      { deleted_by: req.user.id }
    );

    await logActivity(req, { action: "delete", entity: "inventory_inwards", entity_id: in_uid });

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET Views (Helper API for other modules) ──────────────────
export const getInventoryInwardsViews = async (req, res) => {
  try {
    const { id } = req.body;
    const { page, limit, sortBy, order, search } = extractListParams(req.body, { sortBy: "in_uid", order: "DESC" });

    if (id) {
      const data = await findInventoryInward({ in_uid: id });
      if (!data || data.is_deleted || !data.approved) return res.json({ success: true, data: null });
      return res.json({ success: true, data: { in_uid: data.in_uid, packing_number: data.packing_number, remarks: data.remarks } });
    }

    const result = await findInventoryInwards({
      filters: { approved: true },
      search: sanitizeSearch(search),
      sort: { by: sortBy || "in_uid", order: order || "DESC" },
      page: page || 1,
      limit: limit || 5000,
      fields: ["in_uid", "packing_number", "remarks"]
    });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};