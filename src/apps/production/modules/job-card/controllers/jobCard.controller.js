/**
 * Maintain Job Card — one job card per PRIME ITEM (key = docno).
 *   Pending Shortage → New → create (Pending) → Register → Approve (Authorized).
 *   Job Card No logic: ../jobCard.config.js
 */
import { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES } from "../../../../../config/db/dbTables.js";
import { applyApprovalUpdateFields, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { findAllJobCards, findJobCard, findPrimeProcess, insertJobCard, softDeleteJobCard, updateJobCard } from "../models/jobCard.model.js";
import { attachRmWireFromPrimeProcess, groupByPrimeItem, isProductionScopeRow, loadProductionShortages, slimJobCardPendingGroup, usedInJobCardSql } from "../../shortage/utils/primeItemShortage.js";

const ENTITY = "production_job_card";
const MAX_IDS = 1000;
const JOB_CARD_STATUSES = ["Open", "Closed", "Cancelled"];

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const toDocno = (v) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function parseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(toDocno).filter(Boolean))];
}

const idList = (ids) => ids.map((id) => `#${id}`).join(", ");

function itemWeightKg(itemMap, itemdcode) {
  const w = itemMap.get(canonicalCode(itemdcode))?.weight;
  const n = Number(w);
  return Number.isFinite(n) ? n : null;
}

/** View / Edit / Approve drawer — item weights + total (same as shortage prime group). */
function enrichJobCardDrawerRow(row, itemMap) {
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  let weight_missing = false;
  let total_weight_kg = 0;
  const items = (row.items || []).map((it) => {
    const item_weight = itemWeightKg(itemMap, it.itemdcode);
    const qty = Number(it.qty) || 0;
    let weight_kg = null;
    if (item_weight == null) weight_missing = true;
    else weight_kg = Math.round(item_weight * qty * 100) / 100;
    if (weight_kg != null) total_weight_kg += weight_kg;
    return {
      ...it,
      item_code: it.item_code || info(it.itemdcode).item_code || String(it.itemdcode),
      item_weight,
      weight_kg,
    };
  });
  return {
    ...row,
    items,
    total_weight_kg: weight_missing && total_weight_kg === 0 ? null : Math.round(total_weight_kg * 100) / 100,
    weight_missing,
  };
}

/** Card → screen row: prime item + item codes / description live from IMS. */
async function toCardRows(cards = []) {
  const { itemMap } = await getImsMapsSafe();
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  return cards.map((c) => ({
    ...c,
    doc_no: c.job_card_no,
    doc_dt: c.job_date,
    prime_item_code: info(c.prime_item_dcode).item_code || String(c.prime_item_dcode),
    prime_item_desc: info(c.prime_item_dcode).item_desc || null,
    items: (c.items || []).map((it) => ({ ...it, item_code: info(it.itemdcode).item_code || String(it.itemdcode) })),
    shortage_count: (c.shortage_ids || []).length,
    // audit columns (IMS list style)
    created_by_name: c.created_by || null,
    updated_by_name: c.updated_by || null,
    approved_by_name: c.approved_by || null,
  }));
}

/** Every id must be a Production shortage, prime-approved, and not already on a job card. */
function assertUsable(ids, rows, usedIds) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !isProductionScopeRow(byId.get(id)));
  if (missing.length) throw httpError(400, `Shortage entry not found: ${idList(missing)}.`);

  const notApproved = rows.filter((r) => r.is_approved !== true).map((r) => r.id);
  if (notApproved.length) {
    throw httpError(400, `Not approved: ${idList(notApproved)}. Approve them in Production → Shortage → Prime Item first.`);
  }

  const used = rows.filter((r) => usedIds.has(r.id)).map((r) => r.id);
  if (used.length) throw httpError(400, `Already used in a job card: ${idList(used)}.`);
}

/**
 * Picked process / machines / RM per stage → process_plan (checked against the prime process).
 *   pick = { stage_no, process_id, machine_ids: [], rm_item_dcodes: [] }
 *   One process per stage. Machines: many when the process has "Multiple Job Card" (multi_jc) ON, else one.
 *   RM: one or more of the process's RM (order = priority, as in the prime process).
 */
function buildProcessPlan(stages, picks) {
  if (!stages) throw httpError(400, "No prime process saved for this prime item in Engineering → Prime Process Master.");
  const pickByStage = new Map((Array.isArray(picks) ? picks : []).map((p) => [Number(p.stage_no), p]));

  return stages.map((stage) => {
    const pick = pickByStage.get(Number(stage.stage_no)) || {};
    const process = stage.processes.find((p) => p.process_id === Number(pick.process_id));
    if (!process) throw httpError(400, `Stage ${stage.stage_no}: select a process.`);

    const machineIds = (Array.isArray(pick.machine_ids) ? pick.machine_ids : []).map(Number);
    const machines = process.machines.filter((m) => machineIds.includes(m.machine_id));
    if (process.machines.length && !machines.length) throw httpError(400, `Stage ${stage.stage_no}: select a machine.`);
    if (!process.multi_jc && machines.length > 1) throw httpError(400, `Stage ${stage.stage_no}: ${process.process_name} takes one machine.`);

    const rmIds = (Array.isArray(pick.rm_item_dcodes) ? pick.rm_item_dcodes : []).map(Number);
    const rmItems = process.rm_items.filter((r) => rmIds.includes(r.rm_item_dcode));
    if (process.rm_items.length && !rmItems.length) throw httpError(400, `Stage ${stage.stage_no}: select RM.`);

    return {
      stage_no: stage.stage_no,
      process_id: process.process_id,
      process_name: process.process_name,
      machines: machines.map((m) => ({ machine_id: m.machine_id, machine_name: m.name })),
      rm_items: rmItems.map((r) => ({ rm_item_dcode: r.rm_item_dcode, rm_item_code: r.rm_item_code })),
    };
  });
}

/**
 * POST /job-card/register — all job cards (one row per card).
 * body.approved: true = authorized only | false = pending only | omit = all.
 */
export const getJobCardRegister = async (req, res) => {
  try {
    const raw = req.body?.approved;
    const approved = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    const data = await toCardRows(await findAllJobCards({ approved }));
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load job card register." });
  }
};

/** POST /job-card/pending — unapproved job cards. */
export const getJobCardPending = async (req, res) => {
  try {
    const data = await toCardRows(await findAllJobCards({ approved: false }));
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending job cards." });
  }
};

/** POST /job-card/get — body { docno }. */
export const getJobCardById = async (req, res) => {
  try {
    const docno = toDocno(req.body?.docno);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });
    const row = await findJobCard(docno);
    if (!row) return res.status(404).json({ success: false, message: "Job card not found." });
    const { itemMap } = await getImsMapsSafe();
    const [base] = await toCardRows([row]);
    const data = enrichJobCardDrawerRow(base, itemMap);
    const rmGroup = { prime_key: row.prime_item_dcode };
    await attachRmWireFromPrimeProcess([rmGroup], { wireList: false });
    data.rm = rmGroup.rm;
    data.process_tooling = rmGroup.process_tooling;
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load job card." });
  }
};

/**
 * POST /job-card/create — body { prime_key, shortage_ids: [], process_plan: [{ stage_no, process_id, machine_ids, rm_item_dcodes }], remarks? }
 * ONE job card for the prime item: qty = total, items = item-wise qty, shortage_ids = entries used. Starts Pending.
 */
export const createJobCard = async (req, res) => {
  try {
    const primeKey = toDocno(req.body?.prime_key);
    const ids = parseIdList(req.body?.shortage_ids);
    if (!primeKey || !ids.length) return res.status(400).json({ success: false, message: "prime_key and shortage_ids are required." });
    if (ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `Too many entries (max ${MAX_IDS}).` });

    const user = auditUserName(req) || "system";
    const processPlan = buildProcessPlan(await findPrimeProcess(primeKey), req.body?.process_plan);

    const card = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.itemdcode, s.grpname, s.type, s.qty, s.is_approved, s.is_deleted
         FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) ORDER BY s.id FOR UPDATE`,
        [ids]
      );
      const usedRes = await client.query(`SELECT s.id FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) AND ${usedInJobCardSql("s")}`, [ids]);
      assertUsable(ids, rows, new Set(usedRes.rows.map((r) => r.id)));

      // item-wise qty: same item's entries added together
      const qtyByItem = new Map();
      for (const r of rows) qtyByItem.set(Number(r.itemdcode), (qtyByItem.get(Number(r.itemdcode)) || 0) + (Number(r.qty) || 0));
      const items = [...qtyByItem].map(([itemdcode, qty]) => ({ itemdcode, qty }));

      return insertJobCard(client, {
        prime_item_dcode: primeKey,
        qty: items.reduce((sum, it) => sum + it.qty, 0),
        items,
        shortage_ids: rows.map((r) => r.id),
        process_plan: processPlan,
        remarks: String(req.body?.remarks ?? "").trim() || null,
        created_by: user,
      });
    });

    await logActivity(req, { action: "create", entity: ENTITY, entity_id: card.docno, appType: "production", record: card });
    const [data] = await toCardRows([card]);
    return res.status(201).json({ success: true, message: `Job card ${card.job_card_no} created. Approve on Register to authorize.`, data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to create job card." });
  }
};

/**
 * POST /job-card/update — body { docno, status?, remarks?, job_date?, process_plan?, approved? }.
 * Business edits on an authorized card clear approval (back to Pending), IMS style.
 */
export const updateJobCardById = async (req, res) => {
  try {
    const docno = toDocno(req.body?.docno);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findJobCard(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Job card not found." });

    const fields = {};
    let hasBusinessChanges = false;

    const status = req.body.status != null ? String(req.body.status).trim() : "";
    if (status && status !== existing.status) {
      if (!JOB_CARD_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${JOB_CARD_STATUSES.join(", ")}.` });
      }
      fields.status = status;
      hasBusinessChanges = true;
    }

    if (req.body.remarks !== undefined) {
      const remarks = req.body.remarks == null ? null : String(req.body.remarks);
      if (remarks !== (existing.remarks ?? null)) {
        fields.remarks = remarks;
        hasBusinessChanges = true;
      }
    }

    const jobDate = req.body.job_date ? String(req.body.job_date).trim().slice(0, 10) : "";
    if (jobDate && jobDate !== String(existing.job_date ?? "").slice(0, 10)) {
      fields.job_date = jobDate;
      hasBusinessChanges = true;
    }

    if (req.body.process_plan !== undefined) {
      fields.process_plan = buildProcessPlan(await findPrimeProcess(existing.prime_item_dcode), req.body.process_plan);
      hasBusinessChanges = true;
    }

    const incomingApproved = normalizeApprovedInput(req.body.approved);
    applyApprovalUpdateFields({ req, fields, incomingApproved, hasBusinessChanges, alreadyApproved: existing.approved === true, auditAsName: true });

    if (!Object.keys(fields).length) {
      const [data] = await toCardRows([existing]);
      return res.json({ success: true, message: "No changes.", data });
    }

    const [data] = await toCardRows([await updateJobCard(docno, fields)]);
    await logActivity(req, { action: incomingApproved === true ? "approve" : "update", entity: ENTITY, entity_id: docno, appType: "production", record: data });

    const message =
      incomingApproved === true
        ? "Job card approved."
        : hasBusinessChanges && existing.approved === true
          ? "Job card updated — moved back to Pending for re-approval."
          : "Job card updated.";
    return res.json({ success: true, message, data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to update job card." });
  }
};

/** POST /job-card/approve — body { docno }. Pending → Authorized. */
export const approveJobCardById = async (req, res) => {
  req.body = { ...(req.body || {}), approved: true };
  return updateJobCardById(req, res);
};

/** POST /job-card/delete — body { docno }. Soft delete; its shortage entries become available again. */
export const deleteJobCardById = async (req, res) => {
  try {
    const docno = toDocno(req.body?.docno);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const deleted = await softDeleteJobCard(docno, auditUserName(req) || "system");
    if (!deleted) return res.status(404).json({ success: false, message: "Job card not found." });

    await logActivity(req, { action: "delete", entity: ENTITY, entity_id: docno, appType: "production", record: deleted });
    return res.json({ success: true, message: `Job card ${deleted.job_card_no} deleted.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to delete job card." });
  }
};

/**
 * POST /job-card/pending-shortage — approved + pending shortage (never rejected), not yet used in a job card.
 */
export const getPendingShortageForJobCard = async (req, res) => {
  try {
    const rows = await loadProductionShortages([
      "(s.is_approved IS NULL OR s.is_approved = true)",
      `NOT ${usedInJobCardSql("s")}`,
    ]);

    const data = groupByPrimeItem(rows).map(slimJobCardPendingGroup);

    await attachRmWireFromPrimeProcess(data, { wireList: false });

    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending shortage." });
  }
};

/** POST /job-card/prime-process — body { item_dcode }. */
export const getPrimeProcess = async (req, res) => {
  try {
    const itemDcode = toDocno(req.body?.item_dcode);
    if (!itemDcode) return res.status(400).json({ success: false, message: "item_dcode is required." });
    const stages = await findPrimeProcess(itemDcode);
    return res.json({ success: true, data: { item_dcode: itemDcode, stages } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load prime process." });
  }
};
