import { createCrud } from "../../../lib/crud/genericCrud.js";
import { shortageCrudConfig, normalizeShortageMonth, SHORTAGE_BULK_IMPORT_TYPES } from "./../shortage.config.js";
import { enrichRowsWithIMS, getImsMapsSafe, canonicalCode } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { applyApprovalWorkflow, normalizeApprovedInput, auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { canCreatePackingDeviation } from "../../../lib/utils/imsSpecialPermissions.js";
import { getItemsMonthlyPackingUsedBatch } from "../../../lib/utils/inventory/monthlyPackingLimit.js";
import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

const BULK_INSERT_CHUNK = 400;

function monthYmKey(monthYmd) {
  const s = normalizeShortageMonth(monthYmd, null);
  return s.slice(0, 7);
}

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

async function enrichShortageRows(rows = []) {
  const { itemMap } = await getImsMapsSafe();
  return enrichRowsWithIMS(rows, {
    itemCodeField: "itemdcode",
    itemCodeOut: "item_code",
    itemDescOut: "item_desc",
    maps: { itemMap },
  });
}

function markApproved(data, req) {
  data.approved = true;
  data.approved_by = auditUserName(req) || "system";
  data.approved_at = new Date();
}

function markPending(data) {
  data.approved = false;
  data.approved_by = null;
  data.approved_at = null;
}

/**
 * Frontend CRUD → pending unless authorize user sets approved=true.
 * Bulk / packing auto-create → autoApprove: true (approved by default).
 */
function applyShortageApproval(data, { mode, req, existing, autoApprove }) {
  data.month = normalizeShortageMonth(
    data.month ?? req?.body?.month ?? req?.body?.shortage_month,
    null
  );

  if (autoApprove) {
    markApproved(data, req);
    return data;
  }

  const incoming = normalizeApprovedInput(req?.body?.approved);

  if (mode === "create") {
    if (incoming === true) {
      applyApprovalWorkflow({ req, fields: data, incomingApproved: true, auditAsName: true });
    } else {
      markPending(data);
    }
    return data;
  }

  const businessKeys = ["itemdcode", "itemcode", "type", "qty", "month", "remarks"];
  const hasBusinessChanges = businessKeys.some((k) => {
    if (data[k] === undefined) return false;
    if (k === "month") {
      return normalizeShortageMonth(data.month, null) !== normalizeShortageMonth(existing?.month, null);
    }
    return String(data[k] ?? "") !== String(existing?.[k] ?? "");
  });

  applyApprovalWorkflow({
    req,
    fields: data,
    incomingApproved: incoming,
    hasBusinessChanges,
    auditAsName: true,
  });
  return data;
}

export const shortageCrud = createCrud(shortageCrudConfig, {
  enrichRows: enrichShortageRows,
  beforeSave: applyShortageApproval,
});

export const {
  list: getShortages,
  get: getShortageById,
  create: createShortage,
  update: updateShortage,
  remove: deleteShortage,
} = shortageCrud;

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

  return {
    month,
    type: importType,
    rows,
  };
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
            `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::date, NULL, true, $${p++}, $${p++}, false, $${p++}, NOW())`
          );
          params.push(row.itemdcode, row.itemcode, type, row.qty, month, user, approvedAt, user);
        }
        await client.query(
          `
          INSERT INTO ${T.SHORTAGE}
            (itemdcode, itemcode, type, qty, month, remarks, approved, approved_by, approved_at, is_deleted, created_by, created_at)
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
 * Calendar YYYY-MM values covered by from/to (inclusive), capped to 24 months.
 * Falls back to current month when both are empty.
 */
function yearMonthsFromDateFilter(fromDate, toDate) {
  const fromRaw = String(fromDate ?? "").trim().slice(0, 10);
  const toRaw = String(toDate ?? "").trim().slice(0, 10);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const currentYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  let startYm = /^\d{4}-\d{2}-\d{2}/.test(fromRaw) ? fromRaw.slice(0, 7) : "";
  let endYm = /^\d{4}-\d{2}-\d{2}/.test(toRaw) ? toRaw.slice(0, 7) : "";
  if (!startYm && !endYm) return [currentYm];
  if (!startYm) startYm = endYm;
  if (!endYm) endYm = startYm;
  if (startYm > endYm) {
    const t = startYm;
    startYm = endYm;
    endYm = t;
  }

  const out = [];
  let [y, m] = startYm.split("-").map(Number);
  const [ey, em] = endYm.split("-").map(Number);
  while (out.length < 24 && (y < ey || (y === ey && m <= em))) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out.length ? out : [currentYm];
}

/**
 * POST /shortage/master-list
 * One row per unique itemdcode within the same filters as item-wise list.
 * Columns: total shortage qty, produced so far (packing stickers), remaining balance.
 */
export const getShortageMasterList = async (req, res) => {
  try {
    const filters = req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};
    const type = filters.type != null && String(filters.type).trim() !== "" && String(filters.type).toLowerCase() !== "all"
      ? String(filters.type).trim()
      : null;
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

    if (type) {
      values.push(type);
      where.push(`s.type = $${values.length}`);
    }
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

    const rows = await dbQuery(
      `SELECT
         s.itemdcode,
         MAX(NULLIF(TRIM(s.itemcode), '')) AS itemcode,
         COUNT(*)::int AS entry_count,
         COALESCE(SUM(COALESCE(s.qty, 0)), 0)::float AS total_shortage_qty,
         COALESCE(SUM(CASE WHEN s.approved = true THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS approved_qty,
         COALESCE(SUM(CASE WHEN s.approved IS DISTINCT FROM true THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::float AS pending_qty,
         MIN(s.month)::date AS month_from,
         MAX(s.month)::date AS month_to,
         ARRAY_AGG(DISTINCT s.type) AS types,
         ARRAY_AGG(DISTINCT to_char(s.month, 'YYYY-MM')) AS year_months
       FROM ${T.SHORTAGE} s
       WHERE ${where.join(" AND ")}
       GROUP BY s.itemdcode
       ORDER BY s.itemdcode ASC`,
      values
    );

    const list = rows || [];
    const yearMonths = yearMonthsFromDateFilter(fromDate, toDate);
    const producedMap = await getItemsMonthlyPackingUsedBatch(
      list.map((r) => r.itemdcode),
      yearMonths
    );

    const enrichedBase = await enrichShortageRows(
      list.map((r) => {
        const types = Array.isArray(r.types) ? [...new Set(r.types.filter(Boolean))].sort() : [];
        const yms = Array.isArray(r.year_months)
          ? [...new Set(r.year_months.filter(Boolean))].sort()
          : yearMonths;
        return {
          id: `master-${r.itemdcode}`,
          itemdcode: r.itemdcode,
          itemcode: r.itemcode || String(r.itemdcode),
          entry_count: Number(r.entry_count) || 0,
          total_shortage_qty: Number(r.total_shortage_qty) || 0,
          approved_qty: Number(r.approved_qty) || 0,
          pending_qty: Number(r.pending_qty) || 0,
          month_from: r.month_from,
          month_to: r.month_to,
          types,
          year_months: yms,
          produced_qty: Number(producedMap.get(String(r.itemdcode).trim()) || 0),
        };
      })
    );

    const data = enrichedBase.map((row) => {
      const total = Number(row.total_shortage_qty) || 0;
      const produced = Number(row.produced_qty) || 0;
      return {
        ...row,
        remaining_balance: total - produced,
      };
    });

    return res.json({
      success: true,
      data,
      total: data.length,
      meta: { year_months: yearMonths },
    });
  } catch (err) {
    console.error("getShortageMasterList Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to load master shortage report." });
  }
};

/** Internal helper — packing sticker override (auto-approved Deviation). */
export async function createShortageRecordInternal(record, req) {
  return shortageCrud.insertOne(record, req, { skipLog: true, autoApprove: true });
}

/** Roll back auto-created shortage if sticker generation fails after insert. */
export async function revertShortageRecordInternal(id, req) {
  if (id == null) return;
  await shortageCrud.deleteOne(id, req, { skipLog: true });
}

/**
 * POST /shortage/packing-deviation
 * Packing Entry → Create Deviation (special permission). Auto-approved.
 */
export const createPackingDeviation = async (req, res) => {
  try {
    if (!canCreatePackingDeviation(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Packing Deviation special permission is required.",
      });
    }

    const body = req.body || {};
    const itemdcode = parseInt(String(body.itemdcode ?? ""), 10);
    const qty = parseInt(String(body.qty ?? ""), 10);
    const remarks = String(body.remarks ?? "").trim();
    const itemcode = body.itemcode != null ? String(body.itemcode).trim() : "";

    if (!Number.isFinite(itemdcode) || itemdcode <= 0) {
      return res.status(400).json({ success: false, message: "Valid itemdcode is required." });
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ success: false, message: "Quantity must be at least 1." });
    }
    if (!remarks) {
      return res.status(400).json({ success: false, message: "Remarks are required." });
    }

    const outcome = await createShortageRecordInternal(
      {
        itemdcode,
        itemcode: itemcode || String(itemdcode),
        type: "Deviation",
        qty,
        month: normalizeShortageMonth(body.month ?? body.shortage_month ?? body.doc_dt, null),
        remarks,
      },
      req
    );

    if (!outcome.success) {
      return res.status(400).json({
        success: false,
        message: outcome.message || "Could not create packing deviation.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Deviation shortage saved and approved.",
      data: outcome.data,
    });
  } catch (err) {
    console.error("createPackingDeviation Error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
};
