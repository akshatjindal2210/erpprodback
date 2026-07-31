import { findIssueRequests, findIssueRequestJobCardRows, findIssueRequest, findIssueRequestCoils, findIssueRequestJobCards, findIssuedQtyByJobCards, insertIssueRequest, updateIssueRequest, softDeleteIssueRequest, lockIssueRequestForStoreOut as applyIssueRequestStoreOutLock, unlockIssueRequestForStoreOut as applyIssueRequestStoreOutUnlock } from "../models/issueRequest.model.js";
import { replaceIssueRequestJobCards } from "../models/issueRequestJobCard.model.js";
import { findProduction, findProductions } from "../../production/models/productionMaster.model.js";
import { findCoilByUid } from "../../coil/models/coil.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { assertIssueRequestCoilsAvailable, buildAvailableCoilsForIssue } from "../utils/stock/issueRequestCoilReserve.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";

const MODULE = "rm_issue_request";
const log = createRmstoreActivityLogger(MODULE);

async function resolveCoils(coilInputs, { allowedRmItemCodes = null } = {}) {
  const uids = coilInputs
    .map((c) => (typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()))
    .filter(Boolean);

  const allowed =
    allowedRmItemCodes == null
      ? null
      : new Set(
          [...allowedRmItemCodes]
            .map((c) => String(c || "").trim().toUpperCase())
            .filter(Boolean)
        );

  const resolved = [];
  const seen = new Set();
  for (const uid of uids) {
    const key = uid.toLowerCase();
    if (seen.has(key)) {
      throw Object.assign(new Error(`Coil ${uid} has been added more than once.`), { status: 400 });
    }
    seen.add(key);

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status !== "active") {
      throw Object.assign(new Error(`Coil ${uid} is not available. Its current status is ${status}.`), { status: 400 });
    }
    // Issue Request FG pool = store-in (location set) + unassigned / coil area (no location)
    if (allowed && allowed.size > 0) {
      const code = String(coil.item_code || "").trim().toUpperCase();
      if (!allowed.has(code)) {
        throw Object.assign(
          new Error(`Coil ${uid} has RM item ${coil.item_code}, which is not mapped for this issue request.`),
          { status: 400 }
        );
      }
    }
    resolved.push(coil);
  }
  return resolved;
}

function mapProductionFields(prod) {
  return {
    production_id: prod?.production_id ?? null,
    item_dcode: prod?.item_dcode ?? null,
    item_code: prod?.item_code ?? null,
    item_desc: prod?.item_desc ?? prod?.itemdesc ?? null,
    rm_item_dcode: prod?.rm_item_dcode ?? null,
    rm_item_code: prod?.rm_item_code ?? null,
    rm_item_desc: prod?.rm_item_desc ?? prod?.rm_itemdesc ?? null,
  };
}

function normalizeShift(value) {
  return String(value || "A").trim().toUpperCase() === "B" ? "B" : "A";
}

/** Trim float artifacts from summed / subtracted quantities. */
function round(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

async function resolveProductionForItem({ itemdcode, item_code } = {}) {
  const dcode = Number(itemdcode);
  if (Number.isFinite(dcode) && dcode > 0) {
    const approved = await findProductions({
      filters: { item_dcode: dcode, approved: true },
      page: 1,
      limit: 1,
    });
    if (approved.data?.[0]) return approved.data[0];

    const any = await findProductions({
      filters: { item_dcode: dcode },
      page: 1,
      limit: 1,
    });
    if (any.data?.[0]) {
      throw Object.assign(
        new Error(`The production mapping for item ${item_code || dcode} is not approved.`),
        { status: 400 }
      );
    }
  }

  const code = String(item_code || "").trim();
  if (code) {
    const { data } = await findProductions({
      filters: { approved: true },
      search: code,
      page: 1,
      limit: 50,
    });
    const match = (data || []).find(
      (p) => String(p.item_code || "").trim().toUpperCase() === code.toUpperCase()
    );
    if (match) return match;
  }

  return null;
}

/**
 * Normalize job_cards payload and resolve coils + production mapping per JC.
 * @returns {{ jobCards, flatCoils, requestedQty, headerProdFields, allowedRmCodes }}
 */
async function buildJobCardsPayload(rawCards) {
  if (!Array.isArray(rawCards) || !rawCards.length) {
    throw Object.assign(new Error("Add at least one job card."), { status: 400 });
  }

  const jobCards = [];
  const flatCoils = [];
  const seenJc = new Set();
  const seenCoil = new Set();
  const allowedRmCodes = new Set();
  let requestedQty = 0;
  let headerProdFields = null;

  for (const raw of rawCards) {
    const pjobcardno = String(raw?.pjobcardno || "").trim();
    if (!pjobcardno) {
      throw Object.assign(new Error("A job card number is required on every row."), { status: 400 });
    }
    const jcKey = pjobcardno.toUpperCase();
    if (seenJc.has(jcKey)) {
      throw Object.assign(new Error(`Job card ${pjobcardno} has been added more than once.`), { status: 400 });
    }
    seenJc.add(jcKey);

    const issue_qty = Number(raw?.issue_qty ?? raw?.requested_qty);
    if (!Number.isFinite(issue_qty) || issue_qty <= 0) {
      throw Object.assign(new Error(`Issue quantity must be greater than 0 for job card ${pjobcardno}.`), { status: 400 });
    }

    const itemdcode = raw?.itemdcode ?? raw?.item_dcode;
    let prod;
    try {
      prod = await resolveProductionForItem({
        itemdcode,
        item_code: raw?.item_code,
      });
    } catch (e) {
      throw e;
    }
    if (!prod) {
      throw Object.assign(
        new Error(`No approved production to RM mapping exists for item ${raw?.item_code || itemdcode} on job card ${pjobcardno}.`),
        { status: 400 }
      );
    }
    const prodFields = mapProductionFields(prod);
    if (prodFields.rm_item_code) allowedRmCodes.add(String(prodFields.rm_item_code).trim());
    if (!headerProdFields) headerProdFields = prodFields;

    const coilInputs = Array.isArray(raw?.coils) ? raw.coils : [];
    if (!coilInputs.length) {
      throw Object.assign(new Error(`Select coils in FIFO order for job card ${pjobcardno}.`), { status: 400 });
    }

    let resolved;
    try {
      resolved = await resolveCoils(coilInputs, {
        allowedRmItemCodes: prodFields.rm_item_code ? [prodFields.rm_item_code] : null,
      });
    } catch (e) {
      throw e;
    }

    for (const c of resolved) {
      const key = String(c.coil_no_uid).toLowerCase();
      if (seenCoil.has(key)) {
        throw Object.assign(new Error(`Coil ${c.coil_no_uid} is used on more than one job card.`), { status: 400 });
      }
      seenCoil.add(key);
      flatCoils.push({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        pjobcardno,
      });
    }

    requestedQty += issue_qty;
    jobCards.push({
      pjobcardno,
      pldt: raw?.pldt ?? null,
      item_code: raw?.item_code || prodFields.item_code || null,
      itemdcode: Number(itemdcode) || prodFields.item_dcode || null,
      itemdesc: raw?.itemdesc || raw?.item_desc || prodFields.item_desc || null,
      planqty: Number(raw?.planqty ?? raw?.plan_qty ?? 0) || 0,
      macname: raw?.macname || null,
      issue_qty,
      production_id: prodFields.production_id,
      rm_item_dcode: prodFields.rm_item_dcode,
      rm_item_code: prodFields.rm_item_code,
      rm_item_desc: prodFields.rm_item_desc,
      coils: resolved.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
      })),
    });
  }

  return {
    jobCards,
    flatCoils,
    requestedQty,
    headerProdFields: headerProdFields || {},
    allowedRmCodes,
  };
}

export const getIssueRequests = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "issue_uid",
      order: "DESC",
    });
    const result = await findIssueRequests({
      filters: sanitizeFilters(filters || {}, ["approved", "from_date", "to_date", "out_entry_locked", "out_entry_complete"]),
      search: sanitizeSearch(search),
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Job-card-wise list — one row per job card (like forwarding note item-wise). */
export const getIssueRequestJobCardRows = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "issue_uid",
      order: "DESC",
    });
    const result = await findIssueRequestJobCardRows({
      filters: sanitizeFilters(filters || {}, ["approved", "from_date", "to_date", "out_entry_locked", "out_entry_complete"]),
      search: sanitizeSearch(search),
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getIssueRequestById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const data = await findIssueRequest(id);
    if (!data) return res.status(404).json({ success: false, message: "Issue request not found." });
    const coils = await findIssueRequestCoils(id);
    const job_cards = await findIssueRequestJobCards(id);
    return res.json({ success: true, data: { ...data, coils, job_cards } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Already-issued totals per job card, so the form can show plan vs issued vs pending.
 * body: { job_cards: ["JC-1", ...] | [{ pjobcardno, planqty }], exclude_issue_uid }
 */
export const getJobCardIssueSummary = async (req, res) => {
  try {
    const raw = req.body?.job_cards ?? req.body?.pjobcardno;
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const requested = list
      .map((v) => (v && typeof v === "object" ? v : { pjobcardno: v }))
      .map((v) => ({
        pjobcardno: String(v?.pjobcardno ?? "").trim(),
        planqty: Number(v?.planqty ?? v?.plan_qty ?? 0) || 0,
      }))
      .filter((v) => v.pjobcardno)
      .slice(0, 200);

    if (!requested.length) {
      return res.status(400).json({ success: false, message: "At least one job card number is required." });
    }

    const excludeIssueUid = parsePositiveIntId(req.body?.exclude_issue_uid ?? req.body?.issue_uid);
    const rows = await findIssuedQtyByJobCards(
      requested.map((v) => v.pjobcardno),
      { excludeIssueUid }
    );
    const byKey = new Map(rows.map((r) => [String(r.pjobcardno || ""), r]));

    const data = requested.map(({ pjobcardno, planqty }) => {
      const hit = byKey.get(pjobcardno.toUpperCase());
      const issued_qty = round(hit?.issued_qty);
      const approved_qty = round(hit?.approved_qty);
      return {
        pjobcardno,
        plan_qty: planqty,
        issued_qty,
        approved_qty,
        unapproved_qty: round(issued_qty - approved_qty),
        pending_qty: planqty > 0 ? round(planqty - issued_qty) : 0,
        request_count: Number(hit?.request_count || 0),
        last_issue_uid: hit?.last_issue_uid ?? null,
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** FIFO coil pool minus reservations from other issue requests (IMS FN style). */
export const getAvailableCoils = async (req, res) => {
  try {
    const rm_item_code = req.body?.rm_item_code != null ? String(req.body.rm_item_code).trim() : "";
    const rm_item_dcode = parsePositiveIntId(req.body?.rm_item_dcode);
    const excludeIssueUid = parsePositiveIntId(req.body?.exclude_issue_uid ?? req.body?.issue_uid);

    if (!rm_item_code && !rm_item_dcode) {
      return res.status(400).json({ success: false, message: "RM item code or item_dcode is required." });
    }

    const result = await buildAvailableCoilsForIssue({
      rm_item_code: rm_item_code || null,
      rm_item_dcode: rm_item_dcode || null,
      excludeIssueUid,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Create Issue Request.
 * body: { shift, job_cards: [{ pjobcardno, itemdcode, planqty, issue_qty, coils: [...] }], remarks, approved }
 * Legacy: { production_id, requested_qty, coils } still accepted as single-row.
 */
export const createIssueRequest = async (req, res) => {
  try {
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    const shift = normalizeShift(req.body?.shift);
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const user = auditUserName(req);

    let built;
    if (Array.isArray(req.body?.job_cards) && req.body.job_cards.length) {
      try {
        built = await buildJobCardsPayload(req.body.job_cards);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    } else {
      // Legacy single production_id path
      const production_id = parsePositiveIntId(req.body?.production_id);
      const requested_qty = Number(req.body?.requested_qty);
      const coilInputs = Array.isArray(req.body?.coils) ? req.body.coils : [];
      if (!production_id) {
        return res.status(400).json({ success: false, message: "Add at least one job card." });
      }
      if (!Number.isFinite(requested_qty) || requested_qty <= 0) {
        return res.status(400).json({ success: false, message: "Requested quantity must be greater than 0." });
      }
      if (!coilInputs.length) {
        return res.status(400).json({ success: false, message: "At least one coil is required." });
      }
      const prod = await findProduction({ production_id });
      if (!prod?.approved) {
        return res.status(400).json({ success: false, message: "Production mapping not found or not approved." });
      }
      const prodFields = mapProductionFields(prod);
      let resolved;
      try {
        resolved = await resolveCoils(coilInputs, {
          allowedRmItemCodes: prodFields.rm_item_code ? [prodFields.rm_item_code] : null,
        });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      built = {
        jobCards: [
          {
            pjobcardno: req.body?.pjobcardno || `PROD-${production_id}`,
            item_code: prodFields.item_code,
            itemdcode: prodFields.item_dcode,
            itemdesc: prodFields.item_desc,
            planqty: requested_qty,
            issue_qty: requested_qty,
            production_id: prodFields.production_id,
            rm_item_dcode: prodFields.rm_item_dcode,
            rm_item_code: prodFields.rm_item_code,
            rm_item_desc: prodFields.rm_item_desc,
            coils: resolved.map((c) => ({
              coil_no_uid: c.coil_no_uid,
              qty: c.qty,
            })),
          },
        ],
        flatCoils: resolved.map((c) => ({
          coil_no_uid: c.coil_no_uid,
          qty: c.qty,
        })),
        requestedQty: requested_qty,
      };
    }

    try {
      await assertIssueRequestCoilsAvailable(built.jobCards);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const row = await insertIssueRequest({
      requested_qty: built.requestedQty,
      coil_count: built.flatCoils.length,
      shift,
      remarks,
      created_by: user,
    });

    await replaceIssueRequestJobCards({
      issue_uid: row.issue_uid,
      jobCards: built.jobCards,
      userName: user,
    });

    if (normalizedApproved === true) {
      const fields = {};
      applyApprovalWorkflow({
        req, fields, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      await updateIssueRequest(row.issue_uid, fields);
    }

    const data = await findIssueRequest(row.issue_uid);
    const coils = await findIssueRequestCoils(row.issue_uid);
    const job_cards = await findIssueRequestJobCards(row.issue_uid);
    log(req, "create", String(row.issue_uid), {
      issue_uid: row.issue_uid,
      job_card_count: job_cards?.length ?? 0,
      coil_count: coils?.length ?? 0,
      approved: data?.approved === true,
    }, data);
    return res.status(201).json({
      success: true,
      data: { ...data, coils, job_cards },
      message: "Issue request created successfully.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400 || err?.statusCode === 409) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Update Issue Request (edit / approve).
 */
export const updateIssueRequestCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });

    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({
        success: false,
        message: "This issue request is locked for store out.",
      });
    }

    const user = auditUserName(req);
    const shift =
      req.body?.shift !== undefined ? normalizeShift(req.body.shift) : normalizeShift(existing.shift);

    let requested_qty = Number(existing.requested_qty);
    let coil_count = Number(existing.coil_count) || 0;
    let jobCards = await findIssueRequestJobCards(id);
    let coils = await findIssueRequestCoils(id);
    let jobCardsChanged = false;

    if (Array.isArray(req.body?.job_cards)) {
      let built;
      try {
        built = await buildJobCardsPayload(req.body.job_cards);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      try {
        await assertIssueRequestCoilsAvailable(built.jobCards, { excludeIssueUid: id });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      requested_qty = built.requestedQty;
      coil_count = built.flatCoils.length;
      jobCards = built.jobCards;
      coils = built.flatCoils;
      jobCardsChanged = true;
    } else if (Array.isArray(req.body?.coils)) {
      if (!req.body.coils.length) {
        return res.status(400).json({ success: false, message: "At least one coil is required." });
      }
      const jcRows = await findIssueRequestJobCards(id);
      const headerRm = jcRows[0] || {};
      let resolved;
      try {
        resolved = await resolveCoils(req.body.coils, {
          allowedRmItemCodes: headerRm.rm_item_code ? [headerRm.rm_item_code] : null,
        });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      try {
        await assertIssueRequestCoilsAvailable(
          [
            {
              pjobcardno: jcRows[0]?.pjobcardno || `IR-${id}`,
              issue_qty: requested_qty,
              rm_item_code: headerRm.rm_item_code,
              rm_item_dcode: headerRm.rm_item_dcode,
              coils: resolved.map((c) => ({
                coil_no_uid: c.coil_no_uid,
                qty: c.qty,
              })),
            },
          ],
          { excludeIssueUid: id }
        );
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      coil_count = resolved.length;
      coils = resolved.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        pjobcardno: jcRows[0]?.pjobcardno || null,
      }));
      jobCardsChanged = true;
      jobCards = [
        {
          ...(jcRows[0] || {}),
          issue_qty: requested_qty,
          coils: resolved.map((c) => ({ coil_no_uid: c.coil_no_uid, qty: c.qty })),
        },
      ];
      if (req.body?.requested_qty != null) {
        requested_qty = Number(req.body.requested_qty);
        if (!Number.isFinite(requested_qty) || requested_qty <= 0) {
          return res.status(400).json({ success: false, message: "Requested quantity must be greater than 0." });
        }
      }
    }

    const remarks =
      req.body?.remarks !== undefined
        ? req.body.remarks != null
          ? String(req.body.remarks).trim()
          : null
        : existing.remarks;

    const normalizedApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;

    const hasBusinessChanges =
      jobCardsChanged ||
      shift !== normalizeShift(existing.shift) ||
      Number(requested_qty) !== Number(existing.requested_qty) ||
      (req.body?.remarks !== undefined && String(remarks || "") !== String(existing.remarks || ""));

    const updateFields = {
      requested_qty,
      coil_count,
      shift,
      remarks,
    };
    if (hasBusinessChanges) {
      updateFields.updated_by = user;
      updateFields.updated_at = new Date();
    }

    if (normalizedApproved !== undefined || hasBusinessChanges) {
      applyApprovalWorkflow({
        req,
        fields: updateFields,
        incomingApproved: normalizedApproved === true ? true : normalizedApproved === false ? false : undefined,
        hasBusinessChanges: hasBusinessChanges && normalizedApproved !== true,
        auditAsName: true,
      });
    }

    await updateIssueRequest(id, updateFields);
    if (jobCardsChanged) {
      await replaceIssueRequestJobCards({
        issue_uid: id,
        jobCards,
        userName: user,
      });
    }

    const data = await findIssueRequest(id);
    const coilRows = coils?.length ? coils : await findIssueRequestCoils(id);
    const jcRows = jobCardsChanged ? jobCards : await findIssueRequestJobCards(id);
    log(req, data?.approved ? "approve" : "update", String(id), {
      issue_uid: id,
      job_card_count: jcRows?.length ?? 0,
      coil_count: coilRows?.length ?? 0,
      approved: data?.approved === true,
    }, data);
    return res.json({
      success: true,
      data: { ...data, coils: coilRows, job_cards: jcRows },
      message: data?.approved ? "Issue request authorized successfully." : "Issue request updated successfully.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400 || err?.statusCode === 409) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteIssueRequest = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({
        success: false,
        message: "This issue request is locked for store out.",
      });
    }
    await softDeleteIssueRequest(id, auditUserName(req));
    return res.json({ success: true, message: "Issue request deleted successfully." });
  } catch (err) {
    if (err?.statusCode === 409) {
      return res.status(409).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const lockIssueRequestForStoreOut = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({ success: false, message: "This issue request is already locked." });
    }
    const locked = await applyIssueRequestStoreOutLock({ issue_uid: id, userName: auditUserName(req) });
    if (!locked) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({
      success: true,
      message: "Issue request locked successfully.",
      data: locked,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const unlockIssueRequestForStoreOut = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    const unlocked = await applyIssueRequestStoreOutUnlock({ issue_uid: id });
    if (!unlocked) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({
      success: true,
      message: "Issue request unlocked successfully.",
      data: unlocked,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
