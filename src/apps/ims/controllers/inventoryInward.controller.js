import { findInventoryInwards, findInventoryInward, insertInventoryInward, updateInventoryInwards, deleteInventoryInwards, resetBoxesForInward, findPackingAreaByPacking, findPackingAreaBoxes } from "../models/inventoryInward.model.js";

import { logActivity } from "../../core/utils/logActivity.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { getPackingNumberFromBox, updateBoxesAfterInward, getDistinctPackingNumbersFromBoxNoUids, findInHandBoxesByScanCodes, findBoxesByScanCodesAny, matchBoxRowByAnyScanCodes, inwardScanRejectMessage } from "../models/box.model.js";
import { expandStickerScanLookupCodes, primaryStickerScanCode } from "../utils/box/stickerScanParse.js";
import { enrichRowsWithIMS, getImsMapsSafe, canonicalCode } from "../utils/erp-api/imsLookup.js";
import { logInwardLinkBatch } from "../utils/box/logBoxTransaction.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { validateInwardLocationsAgainstBoxes, validateSingleBoxAtLocation, validateBoxesAtLocationBatch, isInwardLocationValidationEnabled } from "../utils/inventory-inward/inwardLocationValidation.js";
import { resolvePackingCustomerName } from "../utils/packing-entry/packingEntryCustomers.js";
import { withTransaction } from "../../../config/db.js";
import { snapshotMetadataFromBoxUids, snapshotInwardMetadata } from "../utils/erp-api/entryListMetadata.js";
import { parsePositiveIntId } from "../../core/utils/parseId.js";

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

    // Resolve aggregated item codes to alphanumeric values
    if (result.data?.length) {
      const { itemMap } = await getImsMapsSafe();
      result.data = result.data.map(row => {
        if (!row.item_codes) return row;
        const codes = row.item_codes.split(' | ').map(c => {
          const trimmed = c.trim();
          const mapped = itemMap.get(trimmed);
          return mapped?.item_code || trimmed;
        });
        return {
          ...row,
          item_codes: codes.join(' | ')
        };
      });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Fast enrich: local row first, IMS map only when names still missing. */
async function enrichPackingAreaListSimple(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  const needsIms = rows.some(
    (row) =>
      !row?.item_desc ||
      String(row.item_desc).trim() === "—" ||
      !row?.acc_name ||
      String(row.acc_name).trim() === "—" ||
      String(row.acc_name).trim() === "Unknown" ||
      (row?.item_code &&
        canonicalCode(row.item_code) === canonicalCode(row.item_dcode))
  );

  const { itemMap, ledgerMap } = needsIms
    ? await getImsMapsSafe()
    : { itemMap: new Map(), ledgerMap: new Map() };

  return rows.map((row) => {
    const itemDcode = row.item_dcode != null ? String(row.item_dcode).trim() : "";
    const itemKey = itemDcode ? canonicalCode(itemDcode) : null;
    const item = itemKey ? itemMap.get(itemKey) : null;
    const codeStr =
      row.acc_code != null && String(row.acc_code).trim() !== "" && String(row.acc_code).trim() !== "—"
        ? String(row.acc_code).trim()
        : "";

    const sqlItemCode =
      row.item_code && String(row.item_code).trim() && String(row.item_code).trim() !== "—"
        ? String(row.item_code).trim()
        : null;
    const sqlItemDesc =
      row.item_desc && String(row.item_desc).trim() && String(row.item_desc).trim() !== "—"
        ? String(row.item_desc).trim()
        : null;
    const sqlAccName =
      row.acc_name && String(row.acc_name).trim() && !["—", "Unknown"].includes(String(row.acc_name).trim())
        ? String(row.acc_name).trim()
        : null;

    const accName =
      sqlAccName ??
      (codeStr
        ? resolvePackingCustomerName(codeStr, { ledgerMap, itemDcode: itemDcode || null })
        : null) ??
      "Unknown";

    return {
      ...row,
      acc_code: codeStr || null,
      acc_name: accName,
      item_code: sqlItemCode ?? item?.item_code ?? itemDcode ?? "—",
      item_desc: sqlItemDesc ?? item?.item_desc ?? "—",
    };
  });
}

export const getPackingAreaList = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });

    const result = await findPackingAreaByPacking({
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      filters,
    });
    result.data = await enrichPackingAreaListSimple(result.data);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPackingAreaBoxesList = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters } = extractListParams(req.body, {
      sortBy: "packing_number",
      order: "DESC",
    });
    const packing_number =
      req.body?.packing_number != null ? String(req.body.packing_number).trim() : "";
    const item_dcode =
      req.body?.item_dcode != null ? String(req.body.item_dcode).trim() : "";
    const acc_code =
      req.body?.acc_code != null ? String(req.body.acc_code).trim() : "";

    const result = await findPackingAreaBoxes({
      search: sanitizeSearch(search),
      packing_number: packing_number || undefined,
      item_dcode: item_dcode || undefined,
      acc_code: acc_code || undefined,
      sort: { by: sortBy, order },
      page,
      limit,
      filters,
    });

    if (result.data?.length) {
      result.data = await enrichPackingAreaListSimple(result.data);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getInventoryInwardById = async (req, res) => {
  try {
    const in_uid = parsePositiveIntId(req.body?.in_uid);
    if (!in_uid) {
      return res.status(400).json({ success: false, message: "Valid in_uid required" });
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

    const boxUids = uniqueBoxNoUidsFromLocations(locations);
    const listMeta = await snapshotMetadataFromBoxUids(boxUids);

    // 2. Primary Record Insert
    const row = await insertInventoryInward({ 
      packing_number: packingNumber,
      item_codes: listMeta.item_codes,
      qtys: listMeta.qtys,
      total_qty: listMeta.total_qty,
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

    await logActivity(req, { action: "create", entity: "inventory_inwards", entity_id: row.in_uid, record: row });

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

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

    if (locations && locations.length > 0) {
      if (await isInwardLocationValidationEnabled()) {
        const locErr = await validateInwardLocationsAgainstBoxes(locations);
        if (locErr) return res.status(400).json({ success: false, message: locErr });
      }
      await resetBoxesForInward(in_uid, userId);
      const linkResults = await Promise.all(
        locations.map((loc) =>
          updateBoxesAfterInward(in_uid, loc.location_id, inwardBoxNoUids(loc.boxes), userId, { logEvent: false })
        )
      );
      logInwardLinkBatch({ in_uid, userId, rowGroups: linkResults });
    }

    const fields = {
      ...(remarks !== undefined && { remarks }),
      approved: true,
      approved_by: userId,
      approved_at: existing.approved_at || new Date(),
      updated_by: userId,
      updated_at: new Date(),
    };

    if (locations && locations.length > 0) {
      const agg = await resolveAggregatePackingForLocations(locations);
      if (agg) fields.packing_number = agg;
      const listMeta = await snapshotInwardMetadata(in_uid);
      fields.item_codes = listMeta.item_codes;
      fields.qtys = listMeta.qtys;
      fields.total_qty = listMeta.total_qty;
    }

    await updateInventoryInwards(fields, { in_uid });

    const data = await findInventoryInward({ in_uid });

    await logActivity(req, {
      action: "update",
      entity: "inventory_inwards",
      entity_id: in_uid,
      record: data,
      details: { updated_fields: fields },
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

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

    const normalizedItems = scanItems.map((item, index) => {
      const raw = item?.code != null ? String(item.code).trim() : "";
      const lookupCodes = expandStickerScanLookupCodes(raw);
      return {
        id: item?.id != null ? String(item.id) : String(index),
        code: primaryStickerScanCode(raw),
        lookupCodes,
      };
    });

    const codes = [
      ...new Set(normalizedItems.flatMap((item) => item.lookupCodes).filter(Boolean)),
    ];
    const [boxRows, anyRows] = await Promise.all([
      findInHandBoxesByScanCodes(codes),
      findBoxesByScanCodesAny(codes),
    ]);

    const resolved = normalizedItems.map((item) => ({
      ...item,
      row: item.lookupCodes.length ? matchBoxRowByAnyScanCodes(boxRows, item.lookupCodes) : null,
      anyRow: item.lookupCodes.length ? matchBoxRowByAnyScanCodes(anyRows, item.lookupCodes) : null,
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

    await withTransaction(async (client) => {
      // 1. Reset boxes (unlink from location and inward)
      await resetBoxesForInward(in_uid, req.user.id, { client });

      // 2. Soft-delete the inward record
      await deleteInventoryInwards(
        { in_uid },
        { client, deleted_by: req.user.id }
      );
    });

    await logActivity(req, { action: "delete", entity: "inventory_inwards", entity_id: in_uid, record: existing });

    res.json({ success: true, message: "Deleted successfully. Boxes have been moved back to packing area." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

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
