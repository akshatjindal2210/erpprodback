import { findShortages, findShortage, insertShortage, updateShortages, deleteShortages } from "../models/shortage.model.js";
import { normalizeShortageMonth, SHORTAGE_BULK_IMPORT_TYPES, SHORTAGE_LIST_TYPES, SHORTAGE_TYPES } from "../shortage.config.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, normalizeApprovedInput, auditUserName, applyApprovalUpdateFields } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { enrichRowsWithIMS, getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { getItemsMonthlyPackingUsedBatch } from "../../../../ims/lib/utils/inventory/monthlyPackingLimit.js";
import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { PRODUCTION_GROUP_NAME } from "../../../lib/config/groupFilter.js";

const CFG = getCrudModuleConfig("shortage");
const BULK_INSERT_CHUNK = 400;
const MASTER_TYPE_QTY_KEYS = ["qty_ppc", "qty_additional"];

const ENTITY = "production_shortage";

/* ─────────────────────────────  helpers  ───────────────────────────── */

function monthYmKey(monthYmd) {
  const s = normalizeShortageMonth(monthYmd, null);
  return s.slice(0, 7);
}

function normText(v) {
  return String(v ?? "").trim();
}

function sameText(a, b) {
  return normText(a) === normText(b);
}

function sameNum(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) && !Number.isFinite(nb)) return true;
  return na === nb;
}

function sameMonth(a, b) {
  return normalizeShortageMonth(a, null).slice(0, 7) === normalizeShortageMonth(b, null).slice(0, 7);
}

async function enrichShortageRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const { itemMap } = await getImsMapsSafe();
  const enriched = await enrichRowsWithIMS(rows, {
    itemCodeField: "itemdcode",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
    maps: { itemMap },
  });
  // Saved shortage grpname wins over IMS item master (user may override group on form).
  return enriched.map((row, i) => {
    const saved = rows[i]?.grpname;
    return saved != null && String(saved).trim() !== "" ? { ...row, grpname: String(saved).trim() } : row;
  });
}

async function resolveShortageGroupName({ itemdcode, itemcode, fallback = null } = {}) {
  const key = canonicalCode(itemdcode ?? itemcode);
  if (!key) return fallback ?? null;
  const { itemMap } = await getImsMapsSafe();
  return itemMap.get(key)?.grpname ?? fallback ?? null;
}

function forcedGrpnameFromReq() {
  return PRODUCTION_GROUP_NAME;
}

function applyListTypeScope(filters = {}) {
  const next = { ...(filters || {}) };
  const type = String(next.type ?? "").trim();
  if (type && type.toLowerCase() !== "all" && SHORTAGE_LIST_TYPES.includes(type)) return next;
  delete next.type;
  next.types = [...SHORTAGE_LIST_TYPES];
  return next;
}

function applyForcedGrpnameFilters(req, filters = {}) {
  const forced = forcedGrpnameFromReq(req);
  let next = applyListTypeScope(filters);
  if (forced) next = { ...next, grpname: forced };
  return next;
}

function pushMasterTypeFilter(where, values, filters = {}) {
  const type = filters.type != null && String(filters.type).trim() !== "" && String(filters.type).toLowerCase() !== "all"
    ? String(filters.type).trim()
    : null;
  if (type && SHORTAGE_LIST_TYPES.includes(type)) {
    values.push(type);
    where.push(`s.type = $${values.length}`);
    return;
  }
  values.push(SHORTAGE_LIST_TYPES);
  where.push(`s.type = ANY($${values.length}::text[])`);
}

function recordMatchesForcedGrpname(req, record) {
  const forced = forcedGrpnameFromReq(req);
  if (!forced) return true;
  return String(record?.grpname || "").trim().toLowerCase() === forced.toLowerCase();
}

function applyForcedGrpnameToBulkRows(rows = [], forced) {
  const needle = String(forced || "").trim();
  if (!needle) return rows;
  const lower = needle.toLowerCase();
  for (const row of rows) {
    const g = String(row?.grpname || "").trim().toLowerCase();
    if (g !== lower) {
      row.valid = false;
      row.error = `Item is not in group ${needle}`;
    } else {
      row.grpname = needle;
    }
  }
  return rows;
}

/* ─────────────────────  payload validation & normalization  ───────────────────── */

/**
 * Extracts and validates business fields from request body for CREATE.
 * Returns { ok, errors[], data{} } where data has the safe, typed values.
 */
function parseCreatePayload(body = {}) {
  const errors = [];
  const data = {};

  const itemdcode = body.itemdcode !== undefined && body.itemdcode !== null && body.itemdcode !== ""
    ? parseInt(String(body.itemdcode), 10)
    : null;
  if (!Number.isFinite(itemdcode) || itemdcode <= 0) {
    errors.push("itemdcode is required");
  } else {
    data.itemdcode = itemdcode;
  }

  const rawType = body.type != null ? String(body.type).trim() : "";
  if (!rawType) {
    errors.push("type is required");
  } else if (!SHORTAGE_TYPES.includes(rawType)) {
    errors.push(`type must be one of: ${SHORTAGE_TYPES.join(", ")}`);
  } else {
    data.type = rawType;
  }

  const qty = body.qty !== undefined && body.qty !== null && body.qty !== ""
    ? parseInt(String(body.qty), 10)
    : null;
  if (!Number.isFinite(qty)) {
    errors.push("qty must be a valid number");
  } else if (qty < 1) {
    errors.push("qty must be at least 1");
  } else {
    data.qty = qty;
  }

  if (body.itemcode !== undefined && body.itemcode !== null && body.itemcode !== "") {
    data.itemcode = String(body.itemcode).trim();
  }

  if (body.remarks !== undefined && body.remarks !== null && body.remarks !== "") {
    data.remarks = String(body.remarks).trim();
  }

  // Month is optional on create — applyShortageApproval falls back to today.
  if (body.month !== undefined && body.month !== null && body.month !== "") {
    data.month = body.month;
  }

  if (body.grpname !== undefined && body.grpname !== null && String(body.grpname).trim() !== "") {
    data.grpname = String(body.grpname).trim();
  }

  return { ok: errors.length === 0, errors, data };
}

/**
 * Extracts and validates business fields from request body for UPDATE.
 * Only includes fields explicitly present in body (undefined => skipped, matches old behavior).
 */
function parseUpdatePayload(body = {}) {
  const errors = [];
  const data = {};

  if (body.itemdcode !== undefined) {
    if (body.itemdcode === null || body.itemdcode === "") {
      errors.push("itemdcode is required");
    } else {
      const itemdcode = parseInt(String(body.itemdcode), 10);
      if (!Number.isFinite(itemdcode) || itemdcode <= 0) {
        errors.push("itemdcode must be a valid number");
      } else {
        data.itemdcode = itemdcode;
      }
    }
  }

  if (body.type !== undefined) {
    const rawType = body.type != null ? String(body.type).trim() : "";
    if (!rawType) {
      errors.push("type is required");
    } else if (!SHORTAGE_TYPES.includes(rawType)) {
      errors.push(`type must be one of: ${SHORTAGE_TYPES.join(", ")}`);
    } else {
      data.type = rawType;
    }
  }

  if (body.qty !== undefined) {
    if (body.qty === null || body.qty === "") {
      errors.push("qty is required");
    } else {
      const qty = parseInt(String(body.qty), 10);
      if (!Number.isFinite(qty)) {
        errors.push("qty must be a valid number");
      } else if (qty < 1) {
        errors.push("qty must be at least 1");
      } else {
        data.qty = qty;
      }
    }
  }

  if (body.itemcode !== undefined) {
    // Blank string is allowed here (approve-drawer edge case handled in applyShortageApproval).
    data.itemcode = body.itemcode == null ? "" : String(body.itemcode).trim();
  }

  if (body.remarks !== undefined) {
    data.remarks = body.remarks == null || body.remarks === "" ? null : String(body.remarks).trim();
  }

  if (body.month !== undefined) {
    data.month = body.month;
  }

  if (body.grpname !== undefined) {
    data.grpname = body.grpname == null || String(body.grpname).trim() === "" ? null : String(body.grpname).trim();
  }

  return { ok: errors.length === 0, errors, data };
}

async function resolveShortageGrpname(data, existing, reqBody = {}) {
  const fromBody = reqBody.grpname != null ? String(reqBody.grpname).trim() : "";
  if (fromBody) return fromBody;
  const fromData = data.grpname != null ? String(data.grpname).trim() : "";
  if (fromData) return fromData;
  return resolveShortageGroupName({
    itemdcode: data.itemdcode ?? existing?.itemdcode,
    itemcode: data.itemcode ?? existing?.itemcode,
    fallback: existing?.grpname ?? null,
  });
}

/**
 * Frontend CRUD → pending unless authorize user sets approved=true.
 * Bulk / packing auto-create → autoApprove: true (approved by default).
 */
async function applyShortageApproval(data, { mode, req, existing, autoApprove = false }) {
  data.month = normalizeShortageMonth(
    data.month ?? req?.body?.month ?? req?.body?.shortage_month,
    null
  );

  if (autoApprove) {
    data.approved = true;
    data.approved_by = auditUserName(req) || "system";
    data.approved_at = new Date();
    return data;
  }

  const incoming = normalizeApprovedInput(req?.body?.approved);

  if (mode === "create") {
    data.grpname = await resolveShortageGrpname(data, null, req?.body);
    if (incoming === true) {
      applyApprovalWorkflow({ req, fields: data, incomingApproved: true, auditAsName: true });
    } else {
      data.approved = false;
      data.approved_by = null;
      data.approved_at = null;
    }
    return data;
  }

  // UPDATE branch
  // Protect against transient blank itemcode from frontend picker in approve drawer.
  if (data.itemcode !== undefined && normText(data.itemcode) === "" && existing?.itemcode != null) {
    data.itemcode = existing.itemcode;
  }

  data.grpname = await resolveShortageGrpname(data, existing, req?.body);

  const hasBusinessChanges =
    (data.itemdcode !== undefined && !sameNum(data.itemdcode, existing?.itemdcode)) ||
    (data.itemcode !== undefined && !sameText(data.itemcode, existing?.itemcode)) ||
    (data.grpname !== undefined && !sameText(data.grpname, existing?.grpname)) ||
    (data.type !== undefined && !sameText(data.type, existing?.type)) ||
    (data.qty !== undefined && !sameNum(data.qty, existing?.qty)) ||
    (data.month !== undefined && !sameMonth(data.month, existing?.month)) ||
    (data.remarks !== undefined && !sameText(data.remarks, existing?.remarks));

  applyApprovalUpdateFields({
    req,
    fields: data,
    incomingApproved: incoming,
    hasBusinessChanges,
    alreadyApproved: existing?.approved === true,
    auditAsName: true,
  });

  return data;
}

/* ─────────────────────  CRUD HTTP handlers  ───────────────────── */

export const getShortages = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "id",
      order: "DESC",
    });

    const result = await findShortages({
      filters: applyForcedGrpnameFilters(req, sanitizeFilters(filters, CFG.filterFields)),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      fields: CFG.listFields,
    });

    const enrichedRows = await enrichShortageRows(result.data || []);
    res.json({ success: true, ...result, data: enrichedRows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getShortageById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await findShortage({ id });
    if (!data || !recordMatchesForcedGrpname(req, data)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const [enriched] = await enrichShortageRows([data]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createShortage = async (req, res) => {
  try {
    const parsed = parseCreatePayload(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, message: parsed.errors.join("; ") });
    }

    const forced = forcedGrpnameFromReq(req);
    const data = { ...parsed.data, created_by: auditUserName(req) };
    if (forced) data.grpname = forced;
    const prepared = await applyShortageApproval(data, { mode: "create", req, existing: null });
    if (forced) prepared.grpname = forced;

    const row = await insertShortage(prepared);

    await logActivity(req, {
      action: "create",
      entity: ENTITY,
      entity_id: row.id,
      record: row,
    });

    const [enriched] = await enrichShortageRows([row]);
    res.status(201).json({ success: true, data: enriched });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
};

export const updateShortage = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findShortage({ id });
    if (!existing || !recordMatchesForcedGrpname(req, existing)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const parsed = parseUpdatePayload(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, message: parsed.errors.join("; ") });
    }

    const forced = forcedGrpnameFromReq(req);
    if (forced) parsed.data.grpname = forced;
    const prepared = await applyShortageApproval(parsed.data, { mode: "update", req, existing });
    if (forced) prepared.grpname = forced;

    const row = await updateShortages(prepared, { id });
    if (!row) return res.status(404).json({ success: false, message: "Not found" });

    await logActivity(req, {
      action: "update",
      entity: ENTITY,
      entity_id: id,
      details: { fields: Object.keys(prepared) },
    });

    const [enriched] = await enrichShortageRows([row]);
    res.json({ success: true, data: enriched });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
};

export const deleteShortage = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findShortage({ id });
    if (!existing || !recordMatchesForcedGrpname(req, existing)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    await deleteShortages({ id }, { deleted_by: auditUserName(req) });

    await logActivity(req, {
      action: "delete",
      entity: ENTITY,
      entity_id: id,
      record: existing,
    });

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────  Internal helpers (packing sticker override)  ───────────────── */

/** Insert helper used by packing deviation flow — no activity log, auto-approved. */
export async function createShortageRecordInternal(record, req) {
  try {
    const parsed = parseCreatePayload(record);
    if (!parsed.ok) {
      return { success: false, message: parsed.errors.join("; ") };
    }

    const data = { ...parsed.data, created_by: auditUserName(req) };
    const prepared = await applyShortageApproval(data, { mode: "create", req, existing: null, autoApprove: true });

    const row = await insertShortage(prepared);
    const [enriched] = await enrichShortageRows([row]);
    return { success: true, data: enriched };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Roll back auto-created shortage if sticker generation fails after insert. */
export async function revertShortageRecordInternal(id, req) {
  if (id == null) return;
  await deleteShortages({ id }, { deleted_by: auditUserName(req) });
}

/* ─────────────────────────  Bulk import  ───────────────────────── */

/** Existing import rows for itemdcode + calendar month + type (import skip). */
async function findExistingImportKeys(type, pairs = []) {
  if (!pairs.length) return new Set();
  const importType = String(type || "").trim();
  if (!SHORTAGE_BULK_IMPORT_TYPES.includes(importType)) return new Set();
  const dcodes = [...new Set(pairs.map((p) => p.itemdcode).filter((n) => Number.isFinite(n)))];
  const yms = [...new Set(pairs.map((p) => p.ym).filter(Boolean))];
  if (!dcodes.length || !yms.length) return new Set();

  const rows = await dbQuery(
    `
    SELECT itemdcode, to_char(month, 'YYYY-MM') AS ym
    FROM ${T.SHORTAGE}
    WHERE is_deleted = false
      AND type = $3
      AND itemdcode = ANY($1::int[])
      AND to_char(month, 'YYYY-MM') = ANY($2::text[])
    `,
    [dcodes, yms, importType]
  );
  return new Set((rows || []).map((r) => `${r.itemdcode}|${r.ym}`));
}

function normalizeBulkImportType(raw) {
  const type = String(raw ?? "PPC").trim();
  return SHORTAGE_BULK_IMPORT_TYPES.includes(type) ? type : null;
}

function pickBulkRows(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.records)) return body.records;
  if (Array.isArray(body?.rows)) return body.rows;
  return null;
}

function readRowField(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [String(k).toLowerCase().replace(/[\s_]/g, ""), v])
  );
  for (const key of keys) {
    const norm = String(key).toLowerCase().replace(/[\s_]/g, "");
    if (lower[norm] != null && String(lower[norm]).trim() !== "") return String(lower[norm]).trim();
  }
  return "";
}

function buildItemCodeLookup(itemMap) {
  const byCode = new Map();
  for (const [dcode, item] of itemMap.entries()) {
    const code = canonicalCode(item?.item_code);
    if (!code) continue;
    const key = code.toUpperCase();
    if (!byCode.has(key)) byCode.set(key, dcode);
  }
  return byCode;
}

/**
 * Normalize + group file rows by itemdcode (sum qty).
 * Marks invalid IMS items and same item+month+type already in DB.
 */
async function buildBulkPreviewRows(rawRows, monthRaw, importTypeRaw) {
  const importType = normalizeBulkImportType(importTypeRaw);
  if (!importType) {
    throw new Error(`Import type must be ${SHORTAGE_BULK_IMPORT_TYPES.join(" or ")}.`);
  }
  const month = normalizeShortageMonth(monthRaw, null);
  const { itemMap } = await getImsMapsSafe();
  const byItemCode = buildItemCodeLookup(itemMap);
  const grouped = new Map();

  for (const raw of rawRows || []) {
    if (!raw || typeof raw !== "object") continue;

    let itemdcodeStr = canonicalCode(
      readRowField(raw, ["itemdcode", "item_dcode", "ItemDcode", "Itemdcode"])
    );
    const itemcodeIn = readRowField(raw, ["itemcode", "item_code", "Item_Code", "ItemCode"]);
    const qtyRaw = readRowField(raw, ["qty", "Qty", "quantity", "Quantity"]);
    const qty = parseInt(String(qtyRaw).replace(/,/g, ""), 10);

    if (!itemdcodeStr && itemcodeIn) {
      const codeKey = String(canonicalCode(itemcodeIn) || "").toUpperCase();
      const hit = codeKey ? byItemCode.get(codeKey) : null;
      if (hit) itemdcodeStr = hit;
    }

    const itemdcode = itemdcodeStr != null ? parseInt(String(itemdcodeStr), 10) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(itemdcode) || itemdcode <= 0) continue;

    const key = String(itemdcode);
    const prev = grouped.get(key);
    if (prev) {
      prev.qty += qty;
      continue;
    }

    const ims = itemMap.get(canonicalCode(itemdcode)) || null;
    const found = Boolean(ims);
    grouped.set(key, {
      key,
      itemdcode,
      itemcode: ims?.item_code || itemcodeIn || String(itemdcode),
      grpname: ims?.grpname || null,
      item_code: ims?.item_code || itemcodeIn || null,
      item_desc: ims?.item_desc || null,
      qty,
      month,
      type: importType,
      valid: found,
      error: found ? null : "Item not found in IMS",
    });
  }

  const rows = Array.from(grouped.values()).sort((a, b) => a.itemdcode - b.itemdcode);
  const ym = monthYmKey(month);
  const existing = await findExistingImportKeys(
    importType,
    rows.map((r) => ({ itemdcode: r.itemdcode, ym }))
  );

  for (const row of rows) {
    const existKey = `${row.itemdcode}|${ym}`;
    if (existing.has(existKey)) {
      row.valid = false;
      row.already_exists = true;
      row.error = `Already in DB for this month (${importType})`;
    }
  }

  return { month, type: importType, rows };
}

/**
 * POST /shortage/bulk-preview — Super Admin. Group + IMS desc + already_exists flags.
 * Body: { month, type: "PPC"|"WIP", data|records|rows: [...] }
 */
export const previewBulkShortages = async (req, res) => {
  try {
    const raw = pickBulkRows(req.body);
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Upload rows are required." });
    }
    const monthRaw = req.body?.month ?? req.body?.shortage_month;
    if (!monthRaw || !String(monthRaw).trim()) {
      return res.status(400).json({ success: false, message: "Month is required." });
    }
    const importType = normalizeBulkImportType(req.body?.type ?? req.body?.import_type);
    if (!importType) {
      return res.status(400).json({
        success: false,
        message: `Import type is required (${SHORTAGE_BULK_IMPORT_TYPES.join(" or ")}).`,
      });
    }
    const { month, type, rows } = await buildBulkPreviewRows(raw, monthRaw, importType);
    applyForcedGrpnameToBulkRows(rows, forcedGrpnameFromReq(req));
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need item and qty > 0.",
      });
    }
    return res.json({
      success: true,
      data: rows,
      total: rows.length,
      meta: { month, type },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Preview failed." });
  }
};

/**
 * POST /shortage/bulk — Super Admin only.
 * Groups by item, skips invalid / same item+month+type already in DB.
 * Body: { month: "YYYY-MM", type: "PPC"|"WIP", data|records|rows: [...] }
 */
export const bulkCreateShortages = async (req, res) => {
  try {
    const raw = pickBulkRows(req.body);
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Upload rows are required." });
    }
    const monthRaw = req.body?.month ?? req.body?.shortage_month;
    if (!monthRaw || !String(monthRaw).trim()) {
      return res.status(400).json({ success: false, message: "Month is required." });
    }
    const importType = normalizeBulkImportType(req.body?.type ?? req.body?.import_type);
    if (!importType) {
      return res.status(400).json({
        success: false,
        message: `Import type is required (${SHORTAGE_BULK_IMPORT_TYPES.join(" or ")}).`,
      });
    }

    const { month, type, rows } = await buildBulkPreviewRows(raw, monthRaw, importType);
    applyForcedGrpnameToBulkRows(rows, forcedGrpnameFromReq(req));
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need item and qty > 0.",
      });
    }

    const toInsert = rows.filter((r) => r.valid !== false && !r.already_exists);
    const skipped = rows.length - toInsert.length;

    if (!toInsert.length) {
      return res.status(200).json({
        success: true,
        message: `Nothing to import. ${skipped} skipped (not in IMS or already same item + month + type).`,
        count: 0,
        skipped,
      });
    }

    const user = auditUserName(req) || "system";
    const approvedAt = new Date();
    let count = 0;

    await withTransaction(async (client) => {
      for (let i = 0; i < toInsert.length; i += BULK_INSERT_CHUNK) {
        const chunk = toInsert.slice(i, i + BULK_INSERT_CHUNK);
        const values = [];
        const params = [];
        let p = 1;
        for (const row of chunk) {
          values.push(
            `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::date, NULL, true, $${p++}, $${p++}, false, $${p++}, NOW())`
          );
          params.push(row.itemdcode, row.itemcode, row.grpname || null, type, row.qty, month, user, approvedAt, user);
        }
        await client.query(
          `
          INSERT INTO ${T.SHORTAGE}
            (itemdcode, itemcode, grpname, type, qty, month, remarks, approved, approved_by, approved_at, is_deleted, created_by, created_at)
          VALUES ${values.join(", ")}
          `,
          params
        );
        count += chunk.length;
      }
    });

    return res.status(201).json({
      success: true,
      message:
        skipped > 0
          ? `${count} saved (${type}). ${skipped} skipped.`
          : `${count} ${type} shortage saved.`,
      count,
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Import failed." });
  }
};

/**
 * POST /shortage/master-list
 * One row per itemdcode + calendar month (YYYY-MM). Type qty sums only that month.
 * When filters.approved is omitted, all statuses are included; UI master tab sends approved=true only.
 */
export const getShortageMasterList = async (req, res) => {
  try {
    const filters = applyForcedGrpnameFilters(
      req,
      req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {}
    );
    const approved =
      filters.approved === true || filters.approved === "true" || filters.approved === 1 || filters.approved === "1"
        ? true
        : filters.approved === false || filters.approved === "false" || filters.approved === 0 || filters.approved === "0"
          ? false
          : null;
    const fromDate = String(filters.from_date ?? "").trim();
    const toDate = String(filters.to_date ?? "").trim();
    const itemdcodeFilter = filters.itemdcode != null && String(filters.itemdcode).trim() !== ""
      ? parseInt(String(filters.itemdcode), 10)
      : null;

    const values = [];
    const where = [`s.is_deleted = false`];

    pushMasterTypeFilter(where, values, filters);
    if (approved === true) {
      where.push(`s.approved = true`);
    } else if (approved === false) {
      where.push(`(s.approved = false OR s.approved IS NULL)`);
    }
    if (fromDate) {
      values.push(fromDate.slice(0, 10));
      where.push(`s.month::date >= $${values.length}::date`);
    }
    if (toDate) {
      values.push(toDate.slice(0, 10));
      where.push(`s.month::date <= $${values.length}::date`);
    }
    if (Number.isFinite(itemdcodeFilter) && itemdcodeFilter > 0) {
      values.push(itemdcodeFilter);
      where.push(`s.itemdcode = $${values.length}`);
    }
    const grpname = String(filters.grpname ?? "").trim();
    if (grpname) {
      values.push(grpname);
      where.push(`LOWER(TRIM(COALESCE(s.grpname, ''))) = LOWER($${values.length})`);
    }

    const rows = await dbQuery(
      `SELECT
         s.itemdcode,
         to_char(s.month, 'YYYY-MM') AS year_month,
         MAX(NULLIF(TRIM(s.itemcode), '')) AS itemcode,
         MAX(NULLIF(TRIM(s.grpname), '')) AS grpname,
         COUNT(*)::int AS entry_count,
         COALESCE(SUM(COALESCE(s.qty, 0)), 0)::float AS total_shortage_qty,
         COALESCE(SUM(CASE WHEN s.type = 'PPC' THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS qty_ppc,
         COALESCE(SUM(CASE WHEN s.type = 'WIP' THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS qty_wip,
         COALESCE(SUM(CASE WHEN s.type = 'Deviation' THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS qty_deviation,
         COALESCE(SUM(CASE WHEN s.type = 'Additional' THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS qty_additional
       FROM ${T.SHORTAGE} s
       WHERE ${where.join(" AND ")}
       GROUP BY s.itemdcode, to_char(s.month, 'YYYY-MM')
       ORDER BY s.itemdcode ASC, year_month ASC`,
      values
    );

    const list = rows || [];
    const yearMonths = [...new Set(list.map((r) => r.year_month).filter(Boolean))];
    const producedMap = await getItemsMonthlyPackingUsedBatch(
      list.map((r) => r.itemdcode),
      yearMonths,
      { byMonth: true }
    );

    const data = (await enrichShortageRows(
      list.map((r) => {
        const ym = String(r.year_month || "").trim();
        const code = String(r.itemdcode).trim();
        const total = Number(r.total_shortage_qty) || 0;
        const produced = Number(producedMap.get(`${code}|${ym}`) || 0);
        return {
          id: `master-${r.itemdcode}-${ym}`,
          itemdcode: r.itemdcode,
          itemcode: r.itemcode || String(r.itemdcode),
          grpname: r.grpname || null,
          year_month: ym,
          entry_count: Number(r.entry_count) || 0,
          total_shortage_qty: total,
          type_qty: SHORTAGE_LIST_TYPES.map((typeName, i) => ({
            type: typeName,
            qty: Number(r[MASTER_TYPE_QTY_KEYS[i]]) || 0,
          })).filter((x) => x.qty > 0),
          produced_qty: produced,
          remaining_balance: total - produced,
        };
      })
    ));

    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error("getShortageMasterList Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to load master shortage report." });
  }
};
