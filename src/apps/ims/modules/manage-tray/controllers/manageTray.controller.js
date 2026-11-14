import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { findTray } from "../../tray/models/trayMaster.model.js";
import { findInHandBoxesByScanCodes, findBoxesByScanCodesAny, matchBoxRowByAnyScanCodes } from "../../box/models/box.model.js";
import { expandStickerScanLookupCodes } from "../../box/utils/stickers/stickerScanParse.js";
import { enrichRowsWithIMS } from "../../../lib/utils/erp-api/lookup/imsLookup.js";
import { packingKey, findManageTrays, findManageTray, findManageTraySnapshot, findManageTrayRegisterById, findManageTrayLinks, findManageTrayLinkConflicts, replaceManageTrayLinks, appendManageTrayLinks, clearManageTrayWork, receiveTray, reassignBoxTray, assignBoxTray, getManageTrayReportSummary, findManageTrayPoolLedger, insertManageTrayLinkSubmitRegister, insertManageTrayOpSubmitRegister, deleteManageTrayRegisterEntry, updateManageTrayRegisterEntry, enrichRegisterLinksWithTrayIds } from "../models/manageTray.model.js";
import { normalizeTrayScanCode } from "../../tray/utils/trayScanParse.js";

const ENTITY = "manage_tray";
const FILTER_FIELDS = ["id", "packing_number", "item_dcode", "approved", "from_date", "to_date", "type"];

/** IMS Manage Tray = FG only. PRD trays belong to Production app. */
function imsManageTrayTypeError(tray) {
  const t = String(tray?.type ?? "").trim().toUpperCase();
  if (t === "FG") return null;
  if (t === "PRD") return "This is a PRD tray. Use it in the Production app.";
  return "Only FG trays can be used in Manage Tray.";
}

function stickerRejectMessage(row, expectedPacking) {
  if (!row || row.is_deleted) return "Sticker not found for this packing.";
  if (packingKey(row.packing_number) !== packingKey(expectedPacking)) {
    return "This sticker belongs to a different packing.";
  }
  if (row.qc_hold_id != null && String(row.qc_hold_id).trim() !== "") {
    return "This sticker is on QC hold.";
  }
  if (row.sa_entry_type === "stock_out") {
    return "This sticker was already processed in Stock Adjustment.";
  }
  if (row.out_uid != null && String(row.out_uid).trim() !== "") {
    return "This sticker was already processed in Store Out.";
  }
  return "This sticker cannot be linked to a tray.";
}

function reassignSourceBoxReject(box) {
  if (!box) return "This tray has no sticker linked.";
  if (box.qc_hold_id != null && String(box.qc_hold_id).trim() !== "") {
    return "Sticker on this tray is on QC hold.";
  }
  if (box.sa_entry_type === "stock_out") {
    return "Sticker on this tray was processed in Stock Adjustment.";
  }
  if (box.out_uid != null && String(box.out_uid).trim() !== "") {
    return "Tray is at customer / Store Out. Receive the tray first.";
  }
  return null;
}

async function loadReassignSourceTray(raw) {
  const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
  const tray = await findTray(trayFilter, {
    fields: ["t.id", "t.code", "t.type", "t.status", "t.approved", "t.pool_status"],
  });
  if (!tray) return { error: "Tray not found." };
  const typeErr = imsManageTrayTypeError(tray);
  if (typeErr) return { error: typeErr };
  if (String(tray.status || "").trim().toLowerCase() !== "active") {
    return { error: "This tray is not active." };
  }
  if (tray.approved !== true) {
    return { error: "This tray is not authorized." };
  }

  const pool = String(tray.pool_status || "vacant").trim().toLowerCase();
  if (pool === "with_customer") {
    return { error: "This tray is at customer end. Receive it before reassign." };
  }

  const [boxRow] = await dbQuery(
    `SELECT b.box_no_uid, b.box_uid, b.packing_number, b.qty, b.out_uid, b.sa_entry_type, b.qc_hold_id, b.is_deleted
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     WHERE t.id = $1
     LIMIT 1`,
    [tray.id]
  );
  const block = reassignSourceBoxReject(boxRow);
  if (block) return { error: block };

  const pn = packingKey(boxRow.packing_number);
  const [dp] = await dbQuery(
    `SELECT acc_code, acc_name
     FROM ${T.DAILYPROD}
     WHERE TRIM(doc_no::text) = $1
     ORDER BY doc_dt DESC NULLS LAST
     LIMIT 1`,
    [pn]
  );

  return {
    data: {
      tray_id: tray.id,
      tray_code: String(tray.code).trim(),
      box_no_uid: String(boxRow.box_no_uid).trim(),
      box_uid: boxRow.box_uid ?? null,
      packing_number: pn,
      qty: Number(boxRow.qty) || 0,
      acc_code: dp?.acc_code ?? null,
      acc_name: dp?.acc_name ?? null,
      pool_status: pool,
    },
  };
}

function normalizeLinks(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      box_no_uid: String(row?.box_no_uid ?? "").trim(),
      box_uid: row?.box_uid ?? null,
      tray_id: parseInt(String(row?.tray_id ?? ""), 10) || null,
      tray_code: String(row?.tray_code ?? "").trim(),
      packing_number: packingKey(row?.packing_number),
      qty: row?.qty ?? null,
      from_tray_code: row?.from_tray_code ?? row?.from_tray ?? null,
      acc_code: row?.acc_code ?? row?.acc ?? null,
      acc_name: row?.acc_name ?? row?.cust ?? null,
      out_uid: row?.out_uid ?? row?.out ?? null,
    }))
    .filter((row) => row.box_no_uid && row.tray_code);
}

export const getManageTrays = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC",
    });
    const result = await findManageTrays({
      filters: sanitizeFilters(filters, FILTER_FIELDS),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      permission: req.permission || {},
    });
    return res.json({ success: true, ...result, data: result.data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export async function getManageTrayDetail(req, res) {
  try {
    const rid = parseInt(String(req.body?.register_id ?? ""), 10);

    if (Number.isFinite(rid) && rid > 0) {
      const snap = await findManageTrayRegisterById(rid, { includeDeleted: true });
      if (!snap) return res.status(404).json({ success: false, message: "Register record not found." });
      const pn = packingKey(snap.packing_number);
      const live = pn ? await findManageTray({ packing_number: pn }) : null;
      const links = await enrichRegisterLinksWithTrayIds(snap.links);
      return res.json({
        success: true,
        data: { ...snap, used_count: Number(live?.used_count) || 0, links, snapshot: true },
      });
    }

    const pn = packingKey(req.body?.packing_number ?? req.body?.id);
    if (!pn) return res.status(400).json({ success: false, message: "Register id or packing number is required." });
    const snap = await findManageTraySnapshot(pn);
    if (snap) {
      const live = await findManageTray({ packing_number: pn });
      return res.json({
        success: true,
        data: { ...snap, used_count: Number(live?.used_count) || 0, links: snap.links },
      });
    }
    const data = await findManageTray({ packing_number: pn });
    if (!data) return res.status(404).json({ success: false, message: "Packing not found." });
    const links = await findManageTrayLinks(pn);
    return res.json({ success: true, data: { ...data, links } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function withDispatchCustomerNames(rows = []) {
  if (!rows.length) return rows;
  const tagged = rows.map((r) => ({ ...r, _cust: r.dispatch_acc_code ?? r.acc_code }));
  const enriched = await enrichRowsWithIMS(tagged, { accCodeField: "_cust", accNameOut: "dispatch_acc_name" });
  return enriched.map(({ _cust, dispatch_acc_name, ...r }) => ({
    ...r,
    acc_name: r.pool_status === "with_customer" ? (dispatch_acc_name || null) : null,
  }));
}

export const getManageTrayReportKpis = async (req, res) => {
  try {
    const data = await getManageTrayReportSummary();
    const customers = await enrichRowsWithIMS(data.customers || [], { accCodeField: "acc_code", accNameOut: "acc_name" });
    return res.json({
      success: true,
      data: {
        ...data,
        customers: customers
          .map((c) => ({ ...c, acc_name: String(c.acc_name || "").trim() }))
          .filter((c) => c.acc_name),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getManageTrayReportLedger = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "type",
      order: "ASC",
    });
    const pool_status = req.body?.filters?.pool_status || req.body?.pool_status || "all";
    const acc_code = req.body?.filters?.acc_code ?? req.body?.acc_code ?? null;
    const unassigned = Boolean(req.body?.filters?.unassigned ?? req.body?.unassigned);
    const result = await findManageTrayPoolLedger({
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      pool_status,
      acc_code,
      unassigned,
    });
    const data = await withDispatchCustomerNames(result.data || []);
    return res.json({ success: true, ...result, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export async function scanManageTraySticker(req, res) {
  try {
    const pn = packingKey(req.body?.id ?? req.body?.packing_number);
    const raw = req.body?.code != null ? String(req.body.code).trim() : "";
    if (!pn || !raw) return res.status(400).json({ success: false, message: "Packing number and scan code are required." });

    const header = await findManageTray({ packing_number: pn });
    if (!header) return res.status(404).json({ success: false, message: "Packing not found." });

    const expectedPacking = packingKey(header.packing_number);
    const lookupCodes = expandStickerScanLookupCodes(raw);
    const inHandRows = await findInHandBoxesByScanCodes(lookupCodes);
    const packingInHand = inHandRows.filter((r) => packingKey(r.packing_number) === expectedPacking);
    const row = matchBoxRowByAnyScanCodes(packingInHand, lookupCodes);
    if (!row?.box_no_uid) {
      const anyRows = await findBoxesByScanCodesAny(lookupCodes);
      const packingAny = anyRows.filter((r) => packingKey(r.packing_number) === expectedPacking);
      const anyPackingRow = matchBoxRowByAnyScanCodes(packingAny, lookupCodes);
      if (anyPackingRow) {
        return res.status(400).json({ success: false, message: stickerRejectMessage(anyPackingRow, expectedPacking) });
      }
      const anyRow = matchBoxRowByAnyScanCodes(anyRows, lookupCodes);
      if (anyRow) {
        return res.status(400).json({ success: false, message: stickerRejectMessage(anyRow, expectedPacking) });
      }
      return res.status(400).json({ success: false, message: "Sticker not found for this packing." });
    }

    const existingLinks = await findManageTrayLinks(pn);
    const uid = String(row.box_no_uid).trim();
    const linkedHere = existingLinks.some((l) => String(l.box_no_uid).trim() === uid);

    if (row.tray_id != null && String(row.tray_id).trim() !== "" && !linkedHere) {
      return res.status(400).json({ success: false, message: "This sticker is already linked to a tray." });
    }

    const [conflict] = await findManageTrayLinkConflicts({ packingNumber: pn, boxNoUids: [uid] });
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: `This sticker is already linked in packing ${conflict.packing_number}.`,
      });
    }

    return res.json({
      success: true,
      data: {
        box_no_uid: uid,
        box_uid: row.box_uid ?? null,
        packing_number: expectedPacking,
        qty: Number(row.qty) || 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function scanManageTrayTray(req, res) {
  try {
    const pn = packingKey(req.body?.id ?? req.body?.packing_number);
    const raw = normalizeTrayScanCode(req.body?.code);
    if (!pn || !raw) return res.status(400).json({ success: false, message: "Packing number and scan code are required." });

    const header = await findManageTray({ packing_number: pn });
    if (!header) return res.status(404).json({ success: false, message: "Packing not found." });

    const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
    const tray = await findTray(trayFilter, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved", "t.pool_status"] });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    const typeErr = imsManageTrayTypeError(tray);
    if (typeErr) return res.status(400).json({ success: false, message: typeErr });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }
    if (tray.approved !== true) {
      return res.status(400).json({ success: false, message: "This tray is not authorized." });
    }

    const code = String(tray.code).trim();
    const currentPn = packingKey(header.packing_number);
    const [trayInUse] = await dbQuery(
      `SELECT b.packing_number
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1 AND TRIM(b.packing_number::text) <> $2
       LIMIT 1`,
      [tray.id, currentPn]
    );
    if (trayInUse) {
      return res.status(400).json({
        success: false,
        message: `This tray is already linked in packing ${trayInUse.packing_number}.`,
      });
    }

    const [conflict] = await findManageTrayLinkConflicts({ packingNumber: pn, trayCodes: [code] });
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: `This tray is already linked in packing ${conflict.packing_number}.`,
      });
    }

    return res.json({
      success: true,
      data: {
        tray_id: tray.id,
        tray_code: code,
        tray_type: tray.type ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function loadReceiveTrayContext(raw) {
  const code = normalizeTrayScanCode(raw);
  if (!code) return { error: "Tray code is required." };
  const trayFilter = /^\d+$/.test(code) ? { id: parseInt(code, 10) } : { code };
  const tray = await findTray(trayFilter, {
    fields: ["t.id", "t.code", "t.type", "t.pool_status", "t.status", "t.approved", "t.batch_id", "t.serial_number"],
  });
  if (!tray) return { error: "Tray not found." };
  const typeErr = imsManageTrayTypeError(tray);
  if (typeErr) return { error: typeErr };
  if (String(tray.status || "").trim().toLowerCase() !== "active") {
    return { error: "This tray is not active." };
  }

  const pool = String(tray.pool_status || "vacant").trim().toLowerCase() || "vacant";
  if (pool === "vacant") return { error: "This tray is already vacant." };
  if (pool !== "with_customer") {
    const where = pool === "in_use" ? "packing area" : pool === "storage" ? "store in" : pool;
    return { error: `Only a tray sent to a customer can be received. This tray is in ${where}.` };
  }

  const linked = await dbQuery(
    `SELECT
       b.packing_number, b.box_no_uid, b.qty, b.out_uid, t.updated_at AS created_at,
       fn.acc_code
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     LEFT JOIN ${T.OUT_ENTRY} oe ON oe.out_uid = b.out_uid AND COALESCE(oe.is_deleted, false) = false
     LEFT JOIN ${T.FORWARDING_NOTE_MASTER} fn ON fn.fuid = oe.fuid AND COALESCE(fn.is_deleted, false) = false
     WHERE t.id = $1
     ORDER BY t.updated_at DESC NULLS LAST`,
    [tray.id]
  );
  const last = linked[0] || null;
  const poolLabel =
    pool === "in_use" ? "PACKING AREA" : pool === "with_customer" ? "CUSTOMER END" : pool === "storage" ? "STORE IN" : pool.toUpperCase();

  let acc_code = last?.acc_code ?? null;
  let acc_name = null;
  if (acc_code != null && String(acc_code).trim() !== "") {
    const [named] = await enrichRowsWithIMS([{ acc_code }], {
      accCodeField: "acc_code",
      accNameOut: "acc_name",
    });
    acc_name = named?.acc_name ? String(named.acc_name).trim() : null;
  }

  const data = {
    tray_id: tray.id,
    tray_code: tray.code,
    tray_type: tray.type ?? null,
    batch_id: tray.batch_id ?? null,
    serial_number: tray.serial_number ?? null,
    pool_status: pool,
    pool_label: poolLabel,
    packing_number: last?.packing_number ?? null,
    box_no_uid: last?.box_no_uid ?? null,
    box_count: linked.length,
    qty: last?.qty ?? null,
    assigned_at: last?.created_at ?? null,
    out_uid: last?.out_uid ?? null,
    acc_code,
    acc_name,
  };
  return { tray, data };
}

async function submitReceiveBatch(req, res, { codes, remark }) {
  const userName = auditUserName(req);
  const saved = [];
  for (const raw of codes) {
    const ctx = await loadReceiveTrayContext(raw);
    if (ctx.error) throw new Error(ctx.error);
    const { tray, data } = ctx;
    await receiveTray({ trayId: tray.id, createdBy: userName });
    const sticker = data.box_no_uid ? String(data.box_no_uid).trim() : String(tray.code).trim();
    saved.push({
      box_no_uid: sticker,
      tray_code: String(tray.code).trim(),
      packing_number: packingKey(data.packing_number),
      qty: data.qty != null ? Number(data.qty) : null,
      // Snapshot at receive time — history must not depend on live out/FN joins later.
      acc_code: data.acc_code ?? null,
      acc_name: data.acc_name ?? null,
      out_uid: data.out_uid ?? null,
    });
  }
  const reg = await insertManageTrayOpSubmitRegister(
    { entry_type: "receive", links: saved, remark: remark || null },
    userName
  );
  if (!reg?.id) throw new Error("Could not save the register entry.");
  await logActivity(req, {
    action: "receive",
    entity: ENTITY,
    entity_id: reg?.id ? String(reg.id) : String(saved[0]?.tray_code ?? ""),
    details: { Type: "receive", register_id: reg?.id ?? null, entry_type: "receive", count: saved.length, ...(remark ? { remark } : {}) },
  });
  return res.json({
    success: true,
    message: `Received ${saved.length} tray${saved.length === 1 ? "" : "s"}.${reg?.id ? ` Register #${reg.id}.` : ""}`,
    data: {
      ...reg,
      register_id: reg?.id ?? null,
      entry_type: "receive",
      type: "receive",
      link_count: saved.length,
      box_count: saved.length,
    },
  });
}

export async function receiveManageTray(req, res) {
  try {
    const preview = req.body?.preview === true || req.body?.preview === "true";
    const remark = String(req.body?.remark ?? "").trim();
    const rawList = req.body?.trays ?? req.body?.links;
    if (!preview && Array.isArray(rawList) && rawList.length > 0) {
      const codes = rawList
        .map((x) => (typeof x === "string" ? x : x?.tray_code ?? x?.code))
        .map((c) => normalizeTrayScanCode(c))
        .filter(Boolean);
      if (!codes.length) return res.status(400).json({ success: false, message: "At least one tray is required." });
      return await submitReceiveBatch(req, res, { codes, remark });
    }

    const raw = normalizeTrayScanCode(req.body?.code);
    if (!raw) return res.status(400).json({ success: false, message: "Tray code is required." });
    const ctx = await loadReceiveTrayContext(raw);
    if (ctx.error) return res.status(400).json({ success: false, message: ctx.error });
    const { tray, data } = ctx;

    if (preview) {
      return res.json({ success: true, data, message: `Tray ${tray.code} is ready to receive.` });
    }

    return await submitReceiveBatch(req, res, { codes: [raw], remark });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/** Reassign step 1: scan source tray (sticker resolved server-side). */
export async function scanReassignFromTray(req, res) {
  try {
    const raw = normalizeTrayScanCode(req.body?.code);
    if (!raw) return res.status(400).json({ success: false, message: "Source tray code is required." });
    const result = await loadReassignSourceTray(raw);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/** @deprecated UI uses scanReassignFromTray — kept for older clients. */
export async function scanReassignSticker(req, res) {
  try {
    const raw = req.body?.code != null ? String(req.body.code).trim() : "";
    if (!raw) return res.status(400).json({ success: false, message: "Sticker code is required." });

    const lookupCodes = expandStickerScanLookupCodes(raw);
    const inHandRows = await findInHandBoxesByScanCodes(lookupCodes);
    const row = matchBoxRowByAnyScanCodes(inHandRows, lookupCodes);
    if (!row?.box_no_uid) {
      const anyRows = await findBoxesByScanCodesAny(lookupCodes);
      const anyRow = matchBoxRowByAnyScanCodes(anyRows, lookupCodes);
      if (anyRow) return res.status(400).json({ success: false, message: stickerRejectMessage(anyRow, packingKey(anyRow.packing_number)) });
      return res.status(400).json({ success: false, message: "Sticker not found." });
    }
    if (row.tray_id == null || String(row.tray_id).trim() === "") {
      return res.status(400).json({ success: false, message: "This sticker is not linked to a tray." });
    }

    return res.json({
      success: true,
      data: {
        box_no_uid: String(row.box_no_uid).trim(),
        box_uid: row.box_uid ?? null,
        packing_number: packingKey(row.packing_number),
        qty: Number(row.qty) || 0,
        tray_id: Number(row.tray_id),
        tray_code: String(row.tray_code || "").trim() || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function scanReassignTray(req, res) {
  try {
    const raw = normalizeTrayScanCode(req.body?.code);
    const fromTrayId = parseInt(String(req.body?.from_tray_id ?? ""), 10);
    const boxNoUid = String(req.body?.box_no_uid ?? "").trim();
    if (!raw) return res.status(400).json({ success: false, message: "Tray code is required." });

    const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
    const tray = await findTray(trayFilter, {
      fields: ["t.id", "t.code", "t.type", "t.status", "t.approved", "t.pool_status"],
    });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    const typeErr = imsManageTrayTypeError(tray);
    if (typeErr) return res.status(400).json({ success: false, message: typeErr });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }
    if (tray.approved !== true) {
      return res.status(400).json({ success: false, message: "This tray is not authorized." });
    }
    const destPool = String(tray.pool_status || "vacant").trim().toLowerCase();
    if (destPool === "with_customer") {
      return res.status(400).json({ success: false, message: "Target tray is at customer end. Receive it first." });
    }
    if (Number.isFinite(fromTrayId) && fromTrayId > 0 && Number(tray.id) === fromTrayId) {
      return res.status(400).json({ success: false, message: "Pick a different target tray." });
    }

    const [inUse] = await dbQuery(
      `SELECT b.packing_number, b.box_no_uid
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1
       LIMIT 1`,
      [tray.id]
    );
    if (inUse && String(inUse.box_no_uid || "").trim() !== boxNoUid) {
      return res.status(400).json({
        success: false,
        message: `This tray is already linked in packing ${inUse.packing_number}.`,
      });
    }

    return res.json({
      success: true,
      data: {
        tray_id: tray.id,
        tray_code: String(tray.code).trim(),
        tray_type: tray.type ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function saveReassignTray(req, res) {
  try {
    const boxNoUid = String(req.body?.box_no_uid ?? "").trim();
    const trayId = parseInt(String(req.body?.tray_id ?? ""), 10);
    const trayCode = String(req.body?.tray_code ?? "").trim();
    if (!boxNoUid || !Number.isFinite(trayId) || trayId <= 0) {
      return res.status(400).json({ success: false, message: "Sticker and new tray are required." });
    }

    const tray = await findTray({ id: trayId }, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved"] });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    const typeErr = imsManageTrayTypeError(tray);
    if (typeErr) return res.status(400).json({ success: false, message: typeErr });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }
    if (tray.approved !== true) {
      return res.status(400).json({ success: false, message: "This tray is not authorized." });
    }

    const [inUse] = await dbQuery(
      `SELECT b.packing_number, b.box_no_uid
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1 LIMIT 1`,
      [trayId]
    );
    if (inUse && String(inUse.box_no_uid || "").trim() !== boxNoUid) {
      return res.status(400).json({
        success: false,
        message: `This tray is already linked in packing ${inUse.packing_number}.`,
      });
    }

    const userName = auditUserName(req);
    const row = await reassignBoxTray({
      boxNoUid,
      trayId,
      createdBy: userName,
    });
    const packing = packingKey(row.packing_number);
    const reg = await insertManageTrayOpSubmitRegister(
      {
        entry_type: "reassign",
        links: [
          {
            box_no_uid: row.box_no_uid,
            tray_id: trayId,
            tray_code: trayCode,
            from_tray_code: row.from_tray_code,
            qty: row.qty,
            packing_number: packing,
          },
        ],
      },
      userName
    );
    await logActivity(req, {
      action: "reassign",
      entity: ENTITY,
      entity_id: reg?.id ? String(reg.id) : boxNoUid,
      details: {
        Type: "reassign",
        register_id: reg?.id ?? null,
        entry_type: "reassign",
        packing_number: packing,
        box_no_uid: row.box_no_uid,
        from_tray_code: row.from_tray_code,
        to_tray_code: trayCode,
      },
    });

    return res.json({
      success: true,
      message: `Sticker moved to ${trayCode || trayId}.${reg?.id ? ` Register #${reg.id}.` : ""}`,
      data: {
        ...row,
        tray_code: trayCode || null,
        register_id: reg?.id ?? null,
        entry_type: "reassign",
        link_count: 1,
        box_count: 1,
        approved: false,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function saveReassignTrayBatch(req, res) {
  try {
    const links = normalizeOpBatchLinks(req.body?.links);
    if (!links.length) {
      return res.status(400).json({ success: false, message: "At least one sticker and tray is required." });
    }
    const userName = auditUserName(req);
    const saved = [];

    for (const item of links) {
      const tray = await findTray({ id: item.tray_id }, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved"] });
      if (!tray) throw new Error("Tray not found.");
      const typeErr = imsManageTrayTypeError(tray);
      if (typeErr) throw new Error(typeErr);
      if (String(tray.status || "").trim().toLowerCase() !== "active") throw new Error("This tray is not active.");
      if (tray.approved !== true) throw new Error("This tray is not authorized.");
      const [inUse] = await dbQuery(
        `SELECT b.packing_number, b.box_no_uid
         FROM ${T.TRAY_MASTER} t
         JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
         WHERE t.id = $1 LIMIT 1`,
        [item.tray_id]
      );
      if (inUse && String(inUse.box_no_uid || "").trim() !== item.box_no_uid) {
        throw new Error(`This tray is already linked in packing ${inUse.packing_number}.`);
      }
      const row = await reassignBoxTray({ boxNoUid: item.box_no_uid, trayId: item.tray_id, createdBy: userName });
      saved.push({
        box_no_uid: row.box_no_uid,
        tray_id: item.tray_id,
        tray_code: item.tray_code || tray.code,
        from_tray_code: row.from_tray_code ?? item.from_tray_code,
        qty: row.qty,
        packing_number: packingKey(row.packing_number),
      });
    }

    const reg = await insertManageTrayOpSubmitRegister({ entry_type: "reassign", links: saved }, userName);

    await logActivity(req, {
      action: "reassign",
      entity: ENTITY,
      entity_id: reg?.id ? String(reg.id) : packingKey(saved[0]?.packing_number),
      details: {
        Type: "reassign",
        register_id: reg?.id ?? null,
        entry_type: "reassign",
        batch_count: saved.length,
        packing_number: reg?.packing_number ?? null,
      },
    });

    return res.json({
      success: true,
      message: `Reassigned ${saved.length}.${reg?.id ? ` Register #${reg.id}.` : ""}`,
      data: {
        ...reg,
        register_id: reg?.id ?? null,
        entry_type: "reassign",
        link_count: saved.length,
        box_count: saved.length,
        approved: false,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function scanAssignSticker(req, res) {
  try {
    const raw = req.body?.code != null ? String(req.body.code).trim() : "";
    if (!raw) return res.status(400).json({ success: false, message: "Sticker code is required." });

    const lookupCodes = expandStickerScanLookupCodes(raw);
    const inHandRows = await findInHandBoxesByScanCodes(lookupCodes);
    const row = matchBoxRowByAnyScanCodes(inHandRows, lookupCodes);
    if (!row?.box_no_uid) {
      const anyRows = await findBoxesByScanCodesAny(lookupCodes);
      const anyRow = matchBoxRowByAnyScanCodes(anyRows, lookupCodes);
      if (anyRow) return res.status(400).json({ success: false, message: stickerRejectMessage(anyRow, packingKey(anyRow.packing_number)) });
      return res.status(400).json({ success: false, message: "Sticker not found." });
    }

    const pn = packingKey(row.packing_number);
    if (!pn) return res.status(400).json({ success: false, message: "Packing not found for this sticker." });

    const header = await findManageTray({ packing_number: pn });
    if (!header) return res.status(404).json({ success: false, message: "Packing not found." });
    if (Number(header.used_count) > 0) {
      return res.status(400).json({ success: false, message: "This packing is already in use. You cannot edit it." });
    }

    const uid = String(row.box_no_uid).trim();
    if (row.tray_id != null && String(row.tray_id).trim() !== "") {
      return res.status(400).json({ success: false, message: "This sticker is already linked to a tray. Use Reassign." });
    }

    const [conflict] = await findManageTrayLinkConflicts({ packingNumber: pn, boxNoUids: [uid] });
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: `This sticker is already linked in packing ${conflict.packing_number}.`,
      });
    }

    return res.json({
      success: true,
      data: {
        box_no_uid: uid,
        box_uid: row.box_uid ?? null,
        packing_number: pn,
        qty: Number(row.qty) || 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function saveAssignTray(req, res) {
  try {
    const boxNoUid = String(req.body?.box_no_uid ?? "").trim();
    const trayId = parseInt(String(req.body?.tray_id ?? ""), 10);
    const trayCode = String(req.body?.tray_code ?? "").trim();
    const pn = packingKey(req.body?.packing_number ?? req.body?.id);
    if (!boxNoUid || !Number.isFinite(trayId) || trayId <= 0) {
      return res.status(400).json({ success: false, message: "Sticker and tray are required." });
    }

    const header = await findManageTray({ packing_number: pn });
    if (pn && !header) return res.status(404).json({ success: false, message: "Packing not found." });
    if (header && Number(header.used_count) > 0) {
      return res.status(400).json({ success: false, message: "This packing is already in use. You cannot edit it." });
    }

    const tray = await findTray({ id: trayId }, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved"] });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    const typeErr = imsManageTrayTypeError(tray);
    if (typeErr) return res.status(400).json({ success: false, message: typeErr });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }
    if (tray.approved !== true) {
      return res.status(400).json({ success: false, message: "This tray is not authorized." });
    }

    const [inUse] = await dbQuery(
      `SELECT b.packing_number, b.box_no_uid
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1 LIMIT 1`,
      [trayId]
    );
    if (inUse && String(inUse.box_no_uid || "").trim() !== boxNoUid) {
      return res.status(400).json({
        success: false,
        message: `This tray is already linked in packing ${inUse.packing_number}.`,
      });
    }

    const userName = auditUserName(req);
    const row = await assignBoxTray({ boxNoUid, trayId, createdBy: userName });
    const packing = packingKey(row.packing_number) || pn;
    const registerHeader =
      (packing && (await findManageTray({ packing_number: packing }))) || header || { packing_number: packing };
    const savedLinks = [
      { box_no_uid: row.box_no_uid, tray_id: trayId, tray_code: trayCode, qty: row.qty, packing_number: packing },
    ];
    const reg = await insertManageTrayLinkSubmitRegister(registerHeader, savedLinks, userName);
    await logActivity(req, {
      action: "assign",
      entity: ENTITY,
      entity_id: reg?.id ? String(reg.id) : boxNoUid,
      details: {
        Type: "assign",
        register_id: reg?.id ?? null,
        entry_type: "assign",
        packing_number: packing,
        box_no_uid: row.box_no_uid,
        to_tray_code: trayCode,
      },
    });

    return res.json({
      success: true,
      message: `Assigned to ${trayCode || trayId}.${reg?.id ? ` Register #${reg.id}.` : ""}`,
      data: {
        ...row,
        ...reg,
        tray_code: trayCode || null,
        register_id: reg?.id ?? null,
        entry_type: "assign",
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function normalizeOpBatchLinks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      box_no_uid: String(item?.box_no_uid ?? "").trim(),
      tray_id: parseInt(String(item?.tray_id ?? ""), 10),
      tray_code: String(item?.tray_code ?? "").trim(),
      packing_number: packingKey(item?.packing_number),
      from_tray_code: item?.from_tray_code ? String(item.from_tray_code).trim() : null,
    }))
    .filter((item) => item.box_no_uid && Number.isFinite(item.tray_id) && item.tray_id > 0);
}

async function assertAssignTrayLink(req, { box_no_uid: boxNoUid, tray_id: trayId, tray_code: trayCode, packing_number: pn }) {
  const header = pn ? await findManageTray({ packing_number: pn }) : null;
  if (pn && !header) throw new Error("Packing not found.");
  if (header && Number(header.used_count) > 0) {
    throw new Error("This packing is already in use. You cannot edit it.");
  }
  const tray = await findTray({ id: trayId }, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved"] });
  if (!tray) throw new Error("Tray not found.");
  const typeErr = imsManageTrayTypeError(tray);
  if (typeErr) throw new Error(typeErr);
  if (String(tray.status || "").trim().toLowerCase() !== "active") throw new Error("This tray is not active.");
  if (tray.approved !== true) throw new Error("This tray is not authorized.");
  const [inUse] = await dbQuery(
    `SELECT b.packing_number, b.box_no_uid
     FROM ${T.TRAY_MASTER} t
     JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
     WHERE t.id = $1 LIMIT 1`,
    [trayId]
  );
  if (inUse && String(inUse.box_no_uid || "").trim() !== boxNoUid) {
    throw new Error(`This tray is already linked in packing ${inUse.packing_number}.`);
  }
  return { trayCode: trayCode || tray.code, header };
}

export async function saveAssignTrayBatch(req, res) {
  try {
    const links = normalizeOpBatchLinks(req.body?.links);
    if (!links.length) {
      return res.status(400).json({ success: false, message: "At least one sticker and tray is required." });
    }
    const userName = auditUserName(req);
    const saved = [];

    for (const item of links) {
      await assertAssignTrayLink(req, item);
      const row = await assignBoxTray({ boxNoUid: item.box_no_uid, trayId: item.tray_id, createdBy: userName });
      saved.push({
        box_no_uid: row.box_no_uid,
        tray_id: item.tray_id,
        tray_code: item.tray_code,
        qty: row.qty,
        packing_number: packingKey(row.packing_number) || item.packing_number,
      });
    }

    const primaryPn = packingKey(saved[0]?.packing_number);
    const header = primaryPn ? await findManageTray({ packing_number: primaryPn }) : null;
    const reg = await insertManageTrayLinkSubmitRegister(header || { packing_number: primaryPn }, saved, userName);

    await logActivity(req, {
      action: "assign",
      entity: ENTITY,
      entity_id: reg?.id ? String(reg.id) : primaryPn,
      details: {
        Type: "assign",
        register_id: reg?.id ?? null,
        entry_type: "assign",
        batch_count: saved.length,
        packing_number: reg?.packing_number ?? null,
      },
    });

    return res.json({
      success: true,
      message: `Assigned ${saved.length}.${reg?.id ? ` Register #${reg.id}.` : ""}`,
      data: {
        ...reg,
        register_id: reg?.id ?? null,
        entry_type: "assign",
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function saveManageTrayLinks(req, res) {
  try {
    const registerId = parseInt(String(req.body?.register_id ?? ""), 10);
    if (Number.isFinite(registerId) && registerId > 0) {
      const snap = await findManageTrayRegisterById(registerId);
      if (!snap) return res.status(404).json({ success: false, message: "Register entry not found." });
      if (snap.is_deleted) {
        return res.status(400).json({ success: false, message: "This entry cannot be edited." });
      }
      const links = normalizeLinks(req.body?.links);
      if (!links.length) {
        return res.status(400).json({ success: false, message: "At least one sticker and tray is required." });
      }
      if (links.some((l) => !l.tray_id)) {
        return res.status(400).json({ success: false, message: "Each line needs a tray (rescan if missing)." });
      }
      const userName = auditUserName(req);
      const updated = await updateManageTrayRegisterEntry(registerId, { links }, userName);
      if (!updated) return res.status(404).json({ success: false, message: "Update failed." });
      await logActivity(req, {
        action: "update",
        entity: ENTITY,
        entity_id: String(registerId),
        record: updated,
        details: { register_id: registerId, link_count: links.length, entry_type: updated.type },
      });
      return res.json({
        success: true,
        message: `Register #${registerId} updated.`,
        data: updated,
      });
    }

    const pn = packingKey(req.body?.id ?? req.body?.packing_number);
    if (!pn) return res.status(400).json({ success: false, message: "Packing number is required." });

    const existing = await findManageTray({ packing_number: pn });
    if (!existing) return res.status(404).json({ success: false, message: "Packing not found." });

    const links = normalizeLinks(req.body?.links);
    const boxNos = new Set();
    const trayCodes = new Set();
    for (const row of links) {
      if (boxNos.has(row.box_no_uid)) {
        return res.status(400).json({ success: false, message: `Sticker ${row.box_no_uid} is linked more than once.` });
      }
      if (row.tray_code && trayCodes.has(row.tray_code)) {
        return res.status(400).json({ success: false, message: `Tray ${row.tray_code} is already linked to another sticker.` });
      }
      boxNos.add(row.box_no_uid);
      if (row.tray_code) trayCodes.add(row.tray_code);
    }
    if (Number(existing.used_count) > 0) {
      return res.status(400).json({ success: false, message: "This packing is already in use. You cannot edit it." });
    }

    const required = Number(existing.box_count) || 0;

    if (!links.length) {
      return res.status(400).json({ success: false, message: "Scan at least one sticker and tray before saving." });
    }

    const conflicts = await findManageTrayLinkConflicts({
      packingNumber: pn,
      boxNoUids: links.map((l) => l.box_no_uid),
      trayCodes: links.map((l) => l.tray_code),
    });
    if (conflicts.length) {
      const hit = conflicts[0];
      return res.status(400).json({
        success: false,
        message: hit?.box_no_uid
          ? `Sticker ${hit.box_no_uid} is already linked in packing ${hit.packing_number}.`
          : `Tray ${hit.tray_code} is already linked in packing ${hit.packing_number}.`,
      });
    }

    const userName = auditUserName(req);
    const replaceAll = req.body?.replace_all === true;
    const savedLinks = replaceAll
      ? await replaceManageTrayLinks({ packingNumber: pn, links, createdBy: userName })
      : await appendManageTrayLinks({ packingNumber: pn, links, createdBy: userName });
    const row = await findManageTray({ packing_number: pn });
    const reg = row ? await insertManageTrayLinkSubmitRegister(row, savedLinks, userName) : null;

    await logActivity(req, {
      action: "submit",
      entity: ENTITY,
      entity_id: reg?.id ? String(reg.id) : pn,
      record: row,
      details: {
        register_id: reg?.id ?? null,
        entry_type: "assign",
        packing_number: pn,
        link_count: savedLinks.length,
        box_count: required,
        registered: Boolean(reg?.approved),
      },
    });

    const totalLinked = Number(row?.link_count) || 0;
    const complete = required > 0 && totalLinked >= required;
    return res.json({
      success: true,
      message: complete
        ? `Saved register #${reg?.id ?? "—"} — all stickers assigned (${totalLinked}/${required}).`
        : `Saved register #${reg?.id ?? "—"} — ${savedLinks.length} in this submit (${totalLinked}/${required || "?"} on packing).`,
      data: {
        ...row,
        id: reg?.id ?? row?.id,
        register_id: reg?.id ?? null,
        entry_type: reg?.entry_type ?? "assign",
        packing_number: pn,
        links: savedLinks,
        link_count: reg?.link_count ?? savedLinks.length,
        box_count: reg?.box_count ?? required,
        packing_link_count: totalLinked,
        approved: reg?.approved ?? complete,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export const deleteManageTrayRecord = async (req, res) => {
  try {
    const userName = auditUserName(req);
    const registerId = parseInt(String(req.body?.register_id ?? ""), 10);
    const clearLinks = req.body?.clear_links === true || req.body?.clear_links === "true";

    if (Number.isFinite(registerId) && registerId > 0) {
      const snap = await findManageTrayRegisterById(registerId);
      if (!snap) return res.status(404).json({ success: false, message: "Register entry not found." });
      if (snap.is_deleted) {
        return res.status(400).json({ success: false, message: "This register entry is already voided." });
      }
      const removed = await deleteManageTrayRegisterEntry(registerId, userName);
      if (!removed) return res.status(404).json({ success: false, message: "Register entry not found." });

      const entryType = snap.type ?? snap.entry_type;
      const restored = Number(removed.restored) || 0;
      await logActivity(req, {
        action: "delete",
        entity: ENTITY,
        entity_id: String(registerId),
        record: snap,
        details: {
          register_id: registerId,
          entry_type: entryType,
          packing_number: snap.packing_number,
          scope: "register_entry_void",
          restored_tray_links: restored,
        },
      });

      const isReceive = String(entryType || "").toLowerCase() === "receive";
      const message = isReceive
        ? restored > 0
          ? `Register #${registerId} removed. ${restored} tray link(s) restored to customer end.`
          : `Register #${registerId} removed. No tray links could be restored (already moved or vacant).`
        : `Register #${registerId} removed from the list. Trays and customer status are unchanged.`;

      return res.json({
        success: true,
        message,
        data: { register_id: registerId, is_deleted: true, restored },
      });
    }

    if (!clearLinks) {
      return res.status(400).json({
        success: false,
        message: "Pass register_id to remove a register entry, or clear_links with packing_number for pending.",
      });
    }

    const pn = packingKey(req.body?.packing_number ?? req.body?.id ?? req.params?.id);
    if (!pn) return res.status(400).json({ success: false, message: "Packing number is required." });

    const existing = await findManageTray({ packing_number: pn });
    if (!existing) return res.status(404).json({ success: false, message: "Packing not found." });

    if (Number(existing.used_count) > 0) {
      return res.status(400).json({ success: false, message: "This packing is already in use. You cannot delete it." });
    }

    const linkCount = Number(existing.link_count) || 0;
    if (linkCount <= 0) {
      return res.status(400).json({ success: false, message: "There are no links to clear." });
    }

    await clearManageTrayWork({ packingNumber: pn, updatedBy: userName });
    const row = await findManageTray({ packing_number: pn });

    await logActivity(req, {
      action: "delete",
      entity: ENTITY,
      entity_id: pn,
      record: row,
      details: { cleared_links: linkCount, scope: "packing_links" },
    });

    return res.json({ success: true, message: "Links cleared.", data: row });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
