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
import { JOB_CARD_STATUSES, JOB_CARD_TYPE_KEY, checkPrimeAndFinish, findAllJobCards, findJobCard, findJobCardByShortageIds, findPrimeProcess, insertJobCard, loadQtyItemsByShortageIds, softDeleteJobCard, updateJobCard } from "../models/jobCard.model.js";
import { calcJobCardProductionTime, estimateProductionForItem } from "../jobCardProductionTime.js";
import { findPlans, PROCESS_TYPE } from "../../../../engineering/modules/item-process/models/itemProcess.model.js";
import { attachRmWireFromPrimeProcess, attachRmWireFromProduction, groupByPrimeItem, isProductionScopeRow, loadProductionShortages, plannedInJobCardSql, slimJobCardPendingGroup, usedInJobCardSql } from "../../shortage/utils/primeItemShortage.js";
import { attachTooling } from "../../shortage/models/primeTooling.model.js";
import { issueQtyKg } from "../jobCard.config.js";

const ENTITY = "production_job_card";
const MAX_IDS = 1000;

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

function itemGweight(itemMap, itemdcode) {
  const w = itemMap.get(canonicalCode(itemdcode))?.gweight;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** View / Edit / Approve — Required Qty (KG) = (prime gweight × total qty) + extra %. */
function enrichJobCardDrawerRow(row, itemMap) {
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  const primeGweight = itemGweight(itemMap, row.itemdcode);
  let totalQty = 0;
  const items = (row.items || []).map((it) => {
    const gweight = itemGweight(itemMap, it.itemdcode);
    const qty = Number(it.qty) || 0;
    totalQty += qty;
    return {
      ...it,
      item_code: it.item_code || info(it.itemdcode).item_code || String(it.itemdcode),
      item_weight: gweight,
      gweight,
      weight_kg: issueQtyKg(gweight, qty),
    };
  });
  const total_weight_kg = issueQtyKg(primeGweight, totalQty);
  return {
    ...row,
    items,
    gweight: primeGweight,
    total_weight_kg,
    weight_missing: total_weight_kg == null,
  };
}

/** Card → screen row: prime from IMS; qty/items/shortage_approved/remark from ims_shortage via shortage_ids. */
async function toCardRows(cards = []) {
  const { itemMap } = await getImsMapsSafe();
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  const joined = await loadQtyItemsByShortageIds(cards);
  return cards.map((c) => {
    const { items = [], qty = 0, shortage_approved = false, shortage_remark = null } = joined.get(c.docno) || {};
    const itemdcode = Number(c.itemdcode);
    return {
      ...c,
      pjobcardno: c.pjobcardno,
      pldt: c.pldt,
      itemdcode,
      // UI aliases
      job_card_no: c.pjobcardno,
      doc_no: c.pjobcardno,
      job_date: c.pldt,
      doc_dt: c.pldt,
      prime_item_dcode: itemdcode,
      prime_item_code: info(itemdcode).item_code || String(itemdcode),
      prime_item_desc: info(itemdcode).item_desc || null,
      qty,
      items: items.map((it) => ({ ...it, item_code: info(it.itemdcode).item_code || String(it.itemdcode) })),
      type: Number(c.type) || 0,
      type_key: JOB_CARD_TYPE_KEY[Number(c.type)] || "jc",
      shortage_approved,
      shortage_remark,
      shortage_count: (c.shortage_ids || []).length,
      created_by_name: c.created_by || null,
      updated_by_name: c.updated_by || null,
      approved_by_name: c.approved_by || null,
      tooling_by_name: c.tooling_by || null,
    };
  });
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
    if (process.machines.length && !machines.length) {
      throw httpError(400, machineIds.length
        ? `Stage ${stage.stage_no}: machine is not mapped to ${process.process_name}.`
        : `Stage ${stage.stage_no}: select a machine.`);
    }
    if (!process.multi_jc && machines.length > 1) throw httpError(400, `Stage ${stage.stage_no}: ${process.process_name} takes one machine.`);

    const rmIds = (Array.isArray(pick.rm_item_dcodes) ? pick.rm_item_dcodes : []).map(Number);
    const rmItems = process.rm_items.filter((r) => rmIds.includes(r.rm_item_dcode));
    if (process.rm_items.length && !rmItems.length) throw httpError(400, `Stage ${stage.stage_no}: select RM.`);

    return {
      stage_no: stage.stage_no,
      process_id: process.process_id,
      process_name: process.process_name,
      machines: machines.map((m) => ({ machine_id: m.machine_id, machine_name: m.macname || m.name })),
      rm_items: rmItems.map((r) => ({ rm_item_dcode: r.rm_item_dcode, rm_item_code: r.rm_item_code })),
    };
  });
}

/** Plan identity (ids only, order kept) — JSONB reorders keys, so never compare JSON text. */
const planKey = (plan = []) =>
  JSON.stringify(
    (plan || []).map((s) => [
      Number(s.stage_no),
      Number(s.process_id),
      (s.machines || []).map((m) => Number(m.machine_id)).sort((a, b) => a - b),
      (s.rm_items || []).map((r) => Number(r.rm_item_dcode)),
    ])
  );

/** Authorize (approved) only after process plan is saved on the job card. */
function assertApproveRequiresProcessPlan(plan) {
  const steps = Array.isArray(plan) ? plan : [];
  if (!steps.length) {
    throw httpError(400, "Save process plan first — job card can be authorized only after process plan is set.");
  }
}

/** Tooling module decision lives on the card (tooling_approved): only Yes allows authorize. */
function assertApproveRequiresTooling(card) {
  if (card?.tooling_approved === true) return;
  if (card?.tooling_approved === false) {
    throw httpError(400, "Tooling is No for this job card — set Tooling to Yes in Production → Tooling before authorizing.");
  }
  throw httpError(400, "Tooling is pending — approve tooling in Production → Tooling before authorizing the job card.");
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
    const rmGroup = { prime_key: row.itemdcode };
    await attachRmWireFromPrimeProcess([rmGroup], { wireList: false });
    data.rm = rmGroup.rm;
    data.process_tooling = rmGroup.process_tooling;
    data.production_time = await estimateProductionForItem(row.itemdcode, data.qty, row.process_plan);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load job card." });
  }
};

/**
 * POST /job-card/create — body { prime_key, shortage_ids: [], process_plan: [{ stage_no, process_id, machine_ids, rm_item_dcodes }], remarks? }
 * ONE job card for the prime item: qty = total, items = item-wise qty, shortage_ids = entries used.
 * Always starts Pending (tooling approves after entry) → authorize on Register.
 */
export const createJobCard = async (req, res) => {
  try {
    const primeKey = toDocno(req.body?.prime_key);
    const ids = parseIdList(req.body?.shortage_ids);
    if (!primeKey || !ids.length) return res.status(400).json({ success: false, message: "prime_key and shortage_ids are required." });
    if (ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `Too many entries (max ${MAX_IDS}).` });

    const user = auditUserName(req) || "system";

    const processPlan = buildProcessPlan(await findPrimeProcess(primeKey), req.body?.process_plan);

    // New always Pending: tooling is approved after the entry exists, then authorize on Register
    const approval = { approved: false, approved_by: null, approved_at: null };

    const existing = await findJobCardByShortageIds(primeKey, ids);

    const card = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.itemdcode, s.grpname, s.type, s.qty, s.is_approved, s.is_deleted
         FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) ORDER BY s.id FOR UPDATE`,
        [ids]
      );
      // Ids already on this draft/open card are allowed; other fully-approved cards still block.
      const usedRes = await client.query(
        `SELECT s.id FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) AND ${usedInJobCardSql("s")}`,
        [ids]
      );
      const usedIds = new Set(usedRes.rows.map((r) => r.id));
      if (existing) {
        for (const id of existing.shortage_ids || []) usedIds.delete(Number(id));
      }
      assertUsable(ids, rows, usedIds);

      const { itemMap } = await getImsMapsSafe();
      const primeOf = (d) => Number(itemMap.get(canonicalCode(d))?.primitemdcode) || Number(d);
      const otherPrime = rows.filter((r) => primeOf(r.itemdcode) !== primeKey).map((r) => r.id);
      if (otherPrime.length) throw httpError(400, `Not of this prime item: ${idList(otherPrime)}.`);

      const engineeringError = await checkPrimeAndFinish(primeKey, rows.map((r) => r.itemdcode));
      if (engineeringError) throw httpError(400, engineeringError);

      const remarks = String(req.body?.remarks ?? "").trim() || null;
      const shortageIds = rows.map((r) => r.id);
      // Process plan saved → Planning (was Pending until New)
      const status = processPlan?.length ? "Planning" : "Pending";

      if (existing) {
        return updateJobCard(existing.docno, {
          shortage_ids: shortageIds,
          process_plan: processPlan,
          status,
          remarks,
          updated_by: user,
          updated_at: new Date(),
          ...approval,
        });
      }

      return insertJobCard(client, {
        itemdcode: primeKey,
        shortage_ids: shortageIds,
        process_plan: processPlan,
        status,
        remarks,
        created_by: user,
        ...approval,
      });
    });

    await logActivity(req, { action: existing ? "update" : "create", entity: ENTITY, entity_id: card.docno, appType: "production", record: card });
    const [data] = await toCardRows([card]);
    const primeStages = await findPrimeProcess(primeKey);
    if (primeStages?.length) {
      data.production_time = calcJobCardProductionTime({ qty: data.qty, stages: primeStages, process_plan: processPlan });
    }
    const message = card.approved
      ? `Job card ${card.pjobcardno} saved and authorized.`
      : `Job card ${card.pjobcardno} saved. Approve on Register to authorize.`;
    return res.status(existing ? 200 : 201).json({ success: true, message, data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to create job card." });
  }
};

/**
 * POST /job-card/update — body { docno, status?, remarks?, pldt|job_date?, process_plan?, approved? }.
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
    // Status / calendar schedule (pldt + shift) must not clear authorization.
    let softOpsChange = false;

    const status = req.body.status != null ? String(req.body.status).trim() : "";
    if (status && status !== existing.status) {
      if (!JOB_CARD_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${JOB_CARD_STATUSES.join(", ")}.` });
      }
      fields.status = status;
      softOpsChange = true;
    }

    if (req.body.remarks !== undefined) {
      const remarks = req.body.remarks == null ? null : String(req.body.remarks) || null; // "" = null (drawer sends "" for none)
      if (remarks !== (existing.remarks ?? null)) {
        fields.remarks = remarks;
        hasBusinessChanges = true;
        softOpsChange = false;
      }
    }

    const jobDate = String(req.body.pldt ?? req.body.job_date ?? "").trim().slice(0, 10);
    if (jobDate && jobDate !== String(existing.pldt ?? "").slice(0, 10)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(jobDate) || Number.isNaN(Date.parse(jobDate))) {
        return res.status(400).json({ success: false, message: "pldt must be a valid date (YYYY-MM-DD)." });
      }
      fields.pldt = jobDate;
      softOpsChange = true;
    }

    if (req.body.schedule_shift !== undefined) {
      const shift = Number(req.body.schedule_shift);
      if (![1, 2, 3].includes(shift)) {
        return res.status(400).json({ success: false, message: "schedule_shift must be 1, 2, or 3." });
      }
      if (shift !== Number(existing.schedule_shift || 1)) {
        fields.schedule_shift = shift;
        softOpsChange = true;
      }
    }

    if (req.body.process_plan !== undefined) {
      const plan = buildProcessPlan(await findPrimeProcess(existing.itemdcode), req.body.process_plan);
      // Edit drawer always sends the plan — only a real change counts (else an authorized card drops to Pending)
      if (planKey(plan) !== planKey(existing.process_plan)) {
        fields.process_plan = plan;
        const noMachines = (p) => planKey((p || []).map((s) => ({ ...s, machines: [] })));
        if (req.body.machine_move === true && noMachines(plan) === noMachines(existing.process_plan)) {
          // Board drag: only machines changed (same processes / RM) → scheduling move, keeps authorization
          softOpsChange = true;
        } else {
          if (plan.length && existing.status === "Pending") fields.status = "Planning";
          hasBusinessChanges = true;
          softOpsChange = false;
        }
      }
    }

    const incomingApproved = normalizeApprovedInput(req.body.approved);
    // Edit drawer (sends approved): status / date edits count as changes too (IMS). Board / Calendar send no approved → stay soft.
    if (incomingApproved !== undefined && softOpsChange) hasBusinessChanges = true;
    const planAfter = fields.process_plan !== undefined ? fields.process_plan : existing.process_plan;
    if (incomingApproved === true) {
      assertApproveRequiresProcessPlan(planAfter);
      assertApproveRequiresTooling(existing);
      // Authorize keeps job-card status (Planning / Running / …). Only bump Pending → Planning when a plan exists.
      const nextStatus = fields.status || existing.status || "Pending";
      if (nextStatus === "Pending" && Array.isArray(planAfter) && planAfter.length) {
        fields.status = "Planning";
      }
    }

    // Status / schedule alone must not clear authorization. Approve / business edits still go through approval workflow.
    if (softOpsChange && !hasBusinessChanges && incomingApproved !== true && incomingApproved !== false) {
      fields.updated_by = auditUserName(req);
      fields.updated_at = new Date();
    } else {
      applyApprovalUpdateFields({ req, fields, incomingApproved, hasBusinessChanges, alreadyApproved: existing.approved === true, auditAsName: true });
    }

    if (!Object.keys(fields).length) {
      const [data] = await toCardRows([existing]);
      return res.json({ success: true, message: "No changes.", data });
    }

    const [data] = await toCardRows([await updateJobCard(docno, fields)]);
    await logActivity(req, { action: incomingApproved === true ? "approve" : "update", entity: ENTITY, entity_id: docno, appType: "production", record: data });

    const message =
      incomingApproved === true
        ? "Job card approved."
        : softOpsChange && !hasBusinessChanges
          ? fields.status && !fields.pldt && fields.schedule_shift == null
            ? `Job card status → ${fields.status}.`
            : "Job card schedule updated."
          : existing.approved === true && data?.approved !== true
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
    return res.json({ success: true, message: `Job card ${deleted.pjobcardno} deleted.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to delete job card." });
  }
};

/**
 * POST /job-card/pending-shortage — pending + approved shortage not yet planned on a job card.
 *   pending  → gray row (Approve)
 *   approved → normal row (New) until process plan is saved
 */
export const getPendingShortageForJobCard = async (req, res) => {
  try {
    const rows = await loadProductionShortages([
      "(s.is_approved IS NULL OR s.is_approved = true)",
      `NOT ${plannedInJobCardSql("s")}`,
    ]);

    const data = groupByPrimeItem(rows).map(slimJobCardPendingGroup);

    await attachRmWireFromPrimeProcess(data, { wireList: false });
    await attachRmWireFromProduction(data, { wireList: true, setRmFlag: false });
    await attachTooling(data, { withRemark: false });

    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending shortage." });
  }
};

/** POST /job-card/estimate-production — body { item_dcode, qty, process_plan[] }. Est. time + rm_available_kg. */
export const estimateJobCardProduction = async (req, res) => {
  try {
    const itemDcode = toDocno(req.body?.item_dcode);
    if (!itemDcode) return res.status(400).json({ success: false, message: "item_dcode is required." });
    const qty = Math.max(0, Number(req.body?.qty) || 0);
    const plan = Array.isArray(req.body?.process_plan) ? req.body.process_plan : [];
    const data = await estimateProductionForItem(itemDcode, qty, plan);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to estimate production time." });
  }
};

/** POST /job-card/prime-process — body { item_dcode, item_dcodes? }. item_dcodes (New Job Card) → Prime + Finish gate first. */
export const getPrimeProcess = async (req, res) => {
  try {
    const itemDcode = toDocno(req.body?.item_dcode);
    if (!itemDcode) return res.status(400).json({ success: false, message: "item_dcode is required." });
    const itemDcodes = parseIdList(req.body?.item_dcodes);
    if (itemDcodes.length) {
      const engineeringError = await checkPrimeAndFinish(itemDcode, itemDcodes);
      if (engineeringError) return res.status(400).json({ success: false, message: engineeringError });
    }
    const stages = await findPrimeProcess(itemDcode);
    if (!stages?.length) {
      const [pending] = await findPlans({ type: PROCESS_TYPE.PRIME, item_dcode: itemDcode });
      if (pending && !pending.is_approved) {
        return res.status(400).json({
          success: false,
          message: "Prime process is pending approval. Approve it in Engineering → Prime Process Master first.",
        });
      }
    }
    return res.json({ success: true, data: { item_dcode: itemDcode, stages } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load prime process." });
  }
};
