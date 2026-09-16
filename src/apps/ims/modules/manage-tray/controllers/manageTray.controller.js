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
import { packingKey, findManageTrays, findManageTray, findManageTraySnapshot, findManageTrayLinks, findManageTrayLinkConflicts, replaceManageTrayLinks, clearManageTrayWork, receiveTray, reassignBoxTray, getManageTrayReportSummary, findManageTrayPoolLedger, saveManageTrayRegister, deleteManageTrayRegister } from "../models/manageTray.model.js";

const ENTITY = "manage_tray";
const FILTER_FIELDS = ["id", "packing_number", "item_dcode", "approved", "from_date", "to_date"];

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

function normalizeLinks(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      box_no_uid: String(row?.box_no_uid ?? "").trim(),
      box_uid: row?.box_uid ?? null,
      tray_id: row?.tray_id ?? null,
      tray_code: String(row?.tray_code ?? "").trim(),
      qty: row?.qty ?? null,
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
    const pn = packingKey(req.body?.id ?? req.body?.packing_number);
    if (!pn) return res.status(400).json({ success: false, message: "Packing number is required." });
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
    const [inHandRows, anyRows] = await Promise.all([
      findInHandBoxesByScanCodes(lookupCodes),
      findBoxesByScanCodesAny(lookupCodes),
    ]);
    const packingInHand = inHandRows.filter((r) => packingKey(r.packing_number) === expectedPacking);
    const row = matchBoxRowByAnyScanCodes(packingInHand, lookupCodes);
    if (!row?.box_no_uid) {
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
    const raw = req.body?.code != null ? String(req.body.code).trim().toUpperCase() : "";
    if (!pn || !raw) return res.status(400).json({ success: false, message: "Packing number and scan code are required." });

    const header = await findManageTray({ packing_number: pn });
    if (!header) return res.status(404).json({ success: false, message: "Packing not found." });

    const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
    const tray = await findTray(trayFilter, { fields: ["t.id", "t.code", "t.type", "t.status", "t.approved", "t.pool_status"] });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
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

export async function receiveManageTray(req, res) {
  try {
    const raw = req.body?.code != null ? String(req.body.code).trim().toUpperCase() : "";
    if (!raw) return res.status(400).json({ success: false, message: "Tray code is required." });

    const preview = req.body?.preview === true || req.body?.preview === "true";
    const remark = String(req.body?.remark ?? "").trim();
    const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
    const tray = await findTray(trayFilter, {
      fields: ["t.id", "t.code", "t.type", "t.pool_status", "t.status", "t.approved", "t.batch_id", "t.serial_number"],
    });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }

    const pool = String(tray.pool_status || "vacant").trim().toLowerCase() || "vacant";
    if (pool === "vacant") {
      return res.status(400).json({ success: false, message: "This tray is already vacant." });
    }
    if (pool !== "with_customer") {
      const where = pool === "in_use" ? "packing area" : pool === "storage" ? "store in" : pool;
      return res.status(400).json({ success: false, message: `Only a tray sent to a customer can be received. This tray is in ${where}.` });
    }

    const linked = await dbQuery(
      `SELECT b.packing_number, b.box_no_uid, b.qty, t.updated_at AS created_at
       FROM ${T.TRAY_MASTER} t
       JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false
       WHERE t.id = $1
       ORDER BY t.updated_at DESC NULLS LAST`,
      [tray.id]
    );
    const last = linked[0] || null;
    const poolLabel = pool === "in_use" ? "PACKING AREA" : pool === "with_customer" ? "CUSTOMER END" : pool === "storage" ? "STORE IN" : pool.toUpperCase();

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
    };

    if (preview) {
      return res.json({ success: true, data, message: `Tray ${tray.code} is ready to receive.` });
    }
    if (!remark) return res.status(400).json({ success: false, message: "A remark is required." });

    const result = await receiveTray({ trayId: tray.id, createdBy: auditUserName(req) });
    await logActivity(req, {
      action: "receive",
      entity: ENTITY,
      entity_id: tray.code,
      details: { remark, cleared: result.cleared },
    });

    return res.json({
      success: true,
      message: `Tray ${tray.code} received.`,
      data: { ...data, pool_status: "vacant", pool_label: "VACANT", remark },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function scanReassignSticker(req, res) {
  try {
    const raw = req.body?.code != null ? String(req.body.code).trim() : "";
    if (!raw) return res.status(400).json({ success: false, message: "Sticker code is required." });

    const lookupCodes = expandStickerScanLookupCodes(raw);
    const [inHandRows, anyRows] = await Promise.all([
      findInHandBoxesByScanCodes(lookupCodes),
      findBoxesByScanCodesAny(lookupCodes),
    ]);
    const row = matchBoxRowByAnyScanCodes(inHandRows, lookupCodes);
    if (!row?.box_no_uid) {
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
    const raw = req.body?.code != null ? String(req.body.code).trim().toUpperCase() : "";
    const fromTrayId = parseInt(String(req.body?.from_tray_id ?? ""), 10);
    const boxNoUid = String(req.body?.box_no_uid ?? "").trim();
    if (!raw) return res.status(400).json({ success: false, message: "Tray code is required." });

    const trayFilter = /^\d+$/.test(raw) ? { id: parseInt(raw, 10) } : { code: raw };
    const tray = await findTray(trayFilter, {
      fields: ["t.id", "t.code", "t.type", "t.status", "t.approved", "t.pool_status"],
    });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
    if (String(tray.status || "").trim().toLowerCase() !== "active") {
      return res.status(400).json({ success: false, message: "This tray is not active." });
    }
    if (tray.approved !== true) {
      return res.status(400).json({ success: false, message: "This tray is not authorized." });
    }
    if (Number.isFinite(fromTrayId) && fromTrayId > 0 && Number(tray.id) === fromTrayId) {
      return res.status(400).json({ success: false, message: "This sticker is already on this tray." });
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

    const tray = await findTray({ id: trayId }, { fields: ["t.id", "t.code", "t.status", "t.approved"] });
    if (!tray) return res.status(400).json({ success: false, message: "Tray not found." });
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

    const row = await reassignBoxTray({
      boxNoUid,
      trayId,
      createdBy: auditUserName(req),
    });
    await logActivity(req, {
      action: "reassign",
      entity: ENTITY,
      entity_id: boxNoUid,
      details: { tray_id: trayId, tray_code: trayCode, packing_number: row.packing_number },
    });

    return res.json({
      success: true,
      message: `Sticker moved to ${trayCode || trayId}.`,
      data: { ...row, tray_code: trayCode || null },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function saveManageTrayLinks(req, res) {
  try {
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

    const submit = req.body?.submit === true || req.body?.submit === "true" || req.body?.submit === 1;
    const required = Number(existing.box_count) || 0;

    if (submit && required > 0 && links.length !== required) {
      return res.status(400).json({
        success: false,
        message: `Link all ${required} stickers before submitting (${links.length}/${required}).`,
      });
    }
    if (submit && !links.length) {
      return res.status(400).json({ success: false, message: "Scan at least one sticker and tray before submitting." });
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
    const savedLinks = await replaceManageTrayLinks({ packingNumber: pn, links, createdBy: userName });
    const row = await findManageTray({ packing_number: pn });
    if (submit && row) await saveManageTrayRegister({ ...row, link_count: savedLinks.length, box_count: required || row.box_count }, userName);
    else await deleteManageTrayRegister(pn, userName);

    await logActivity(req, {
      action: submit ? "submit" : "update",
      entity: ENTITY,
      entity_id: pn,
      record: row,
      details: { link_count: savedLinks.length, submit },
    });

    return res.json({
      success: true,
      message: submit ? "Links saved." : `Draft saved (${savedLinks.length}/${required || "?"}).`,
      data: { ...row, links: savedLinks, moved_to_pending: !submit },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export const moveManageTrayToPending = async (req, res) => {
  try {
    const pn = packingKey(req.body?.packing_number ?? req.body?.id);
    if (!pn) return res.status(400).json({ success: false, message: "Packing number is required." });
    const existing = await findManageTray({ packing_number: pn });
    if (existing && Number(existing.used_count) > 0) {
      return res.status(400).json({ success: false, message: "This packing is already in use. You cannot edit it." });
    }
    await deleteManageTrayRegister(pn, auditUserName(req));
    return res.json({ success: true, message: "Moved to Pending.", data: { packing_number: pn } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteManageTrayRecord = async (req, res) => {
  try {
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

    const userName = auditUserName(req);
    await clearManageTrayWork({ packingNumber: pn, updatedBy: userName });
    await deleteManageTrayRegister(pn, userName);
    const row = await findManageTray({ packing_number: pn });

    await logActivity(req, {
      action: "delete",
      entity: ENTITY,
      entity_id: pn,
      record: row,
      details: { cleared_links: linkCount },
    });

    return res.json({ success: true, message: "Links cleared.", data: row });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
