import { createCrud } from "../../../lib/crud/genericCrud.js";
import { shortageCrudConfig, normalizeShortageMonth } from "./../shortage.config.js";
import { enrichRowsWithIMS, getImsMapsSafe, canonicalCode } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { applyApprovalWorkflow, normalizeApprovedInput, auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { canCreatePackingDeviation } from "../../../lib/utils/imsSpecialPermissions.js";
import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

const BULK_INSERT_CHUNK = 400;

function monthYmKey(monthYmd) {
  const s = normalizeShortageMonth(monthYmd, null);
  return s.slice(0, 7);
}

/** Existing PPC rows for itemdcode + calendar month (import skip). */
async function findExistingPpcImportKeys(pairs = []) {
  if (!pairs.length) return new Set();
  const dcodes = [...new Set(pairs.map((p) => p.itemdcode).filter((n) => Number.isFinite(n)))];
  const yms = [...new Set(pairs.map((p) => p.ym).filter(Boolean))];
  if (!dcodes.length || !yms.length) return new Set();

  const rows = await dbQuery(
    `
    SELECT itemdcode, to_char(month, 'YYYY-MM') AS ym
    FROM ${T.SHORTAGE}
    WHERE is_deleted = false
      AND type = 'PPC'
      AND itemdcode = ANY($1::int[])
      AND to_char(month, 'YYYY-MM') = ANY($2::text[])
    `,
    [dcodes, yms]
  );
  return new Set((rows || []).map((r) => `${r.itemdcode}|${r.ym}`));
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
 * Normalize + group file rows by itemdcode (sum qty). Type always PPC.
 * Marks invalid IMS items and same item+month already in DB.
 */
async function buildPpcBulkPreviewRows(rawRows, monthRaw) {
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
    if (!Number.isFinite(itemdcode) || itemdcode <= 0) continue;
    if (!Number.isFinite(qty) || qty < 1) continue;

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
      valid: found,
      error: found ? null : "Item not found in IMS",
    });
  }

  const rows = Array.from(grouped.values()).sort((a, b) => a.itemdcode - b.itemdcode);
  const ym = monthYmKey(month);
  const existing = await findExistingPpcImportKeys(
    rows.map((r) => ({ itemdcode: r.itemdcode, ym }))
  );

  for (const row of rows) {
    const existKey = `${row.itemdcode}|${ym}`;
    if (existing.has(existKey)) {
      row.valid = false;
      row.already_exists = true;
      row.error = "Already in DB for this month";
    }
  }

  return {
    month,
    rows,
  };
}

/**
 * POST /shortage/bulk-preview — Super Admin. Group + IMS desc + already_exists flags.
 * Body: { month, data|records|rows: [...] }
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
    const { month, rows } = await buildPpcBulkPreviewRows(raw, monthRaw);
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need item_dcode (or item_code) and qty ≥ 1.",
      });
    }
    return res.json({
      success: true,
      data: rows,
      total: rows.length,
      meta: { month, type: "PPC" },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Preview failed." });
  }
};

/**
 * POST /shortage/bulk — Super Admin only.
 * Groups by item, type=PPC, skips invalid / same item+month already in DB.
 * Body: { month: "YYYY-MM", data|records|rows: [{ item_dcode|itemdcode, item_code?, qty }, ...] }
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

    const { month, rows } = await buildPpcBulkPreviewRows(raw, monthRaw);
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need item_dcode (or item_code) and qty ≥ 1.",
      });
    }

    const toInsert = rows.filter((r) => r.valid !== false && !r.already_exists);
    const skipped = rows.length - toInsert.length;

    if (!toInsert.length) {
      return res.status(200).json({
        success: true,
        message: `Nothing to import. ${skipped} skipped (not in IMS or already same item + month).`,
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
            `($${p++}, $${p++}, 'PPC', $${p++}, $${p++}::date, NULL, true, $${p++}, $${p++}, false, $${p++}, NOW())`
          );
          params.push(row.itemdcode, row.itemcode, row.qty, month, user, approvedAt, user);
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
          ? `${count} saved (PPC). ${skipped} skipped.`
          : `${count} PPC shortage saved.`,
      count,
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Import failed." });
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
