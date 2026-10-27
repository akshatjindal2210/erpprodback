/**
 * Maintain Job Card — one job card per PRIME ITEM (key = docno).
 * Pending Shortage → New → create (Pending) → Register → Approve (Authorized).
 */
import { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES } from "../../../../../config/db/dbTables.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { assignErpNumbersToJobCard, checkPrimeAndFinish, findJobCard, findJobCardByShortageIds, findPrimeProcess, findProcessLogByJobCard, hardDeleteJobCard, insertProcessLogRows, updateJobCard } from "../models/jobCard.model.js";
import { calcJobCardProductionTime, estimateProductionForItem } from "../jobCardProductionTime.js";
import { findPlans, PROCESS_TYPE } from "../../../../engineering/modules/item-process/models/itemProcess.model.js";
import { attachOpenJobCardNo, attachRmWireFromPrimeProcess, attachRmWireFromProduction, groupByPrimeItem, loadProductionShortages, shortageOnAuthorizedJobCardSql, slimJobCardPendingGroup } from "../../shortage/utils/primeItemShortage.js";
import { attachTooling } from "../../shortage/models/primeTooling.model.js";
import { formatPJobCardNo, JOB_CARD_TYPE_DEFAULT } from "../jobCard.config.js";
import { ERP_ACC_CODE, JC_SERIES_CODE, nextJobcardno, resolveFyidForJobCard, syncJobCardErpAdd, syncJobCardErpDelete, syncJobCardErpUpdate } from "../jobCardErp.js";
import { diffProcessPlan, parseProcessPlan, statusMapFromPicks, withPlanStatuses } from "../processPlanStatus.js";
import { assertMaintainJobcardToolingIfRequired, assertUsable, buildProcessPlan, enrichJobCardDrawerRow, httpError, idList, isSuperAdminUser, loadRegisterList, logRowsFromDiff, parseApprovedFilter, parseIdList, parseJobcardnoOverride, remarkMapFromBody, toCardRows, toDocno } from "./jobCard.controller.helpers.js";
import { buildUpdateResponseMessage, prepareJobCardUpdate } from "./jobCard.updateFields.js";

const ENTITY = "production_job_card";
const MAX_IDS = 1000;
const ERP_SAVE_FAIL = "ERP sync failed. Job card was not saved.";

/*
  Job card + ERP:
    Live  — ERP block ON  → pehle ERP (mjcnew), fail = DB rollback. Phir DB save.
    Test  — ERP block comment → sirf DB (prod_job_card), ERP call nahi.
  Comment kahan: create/update mein "ERP mjcnew" block; delete mein syncJobCardErpDelete wali 3 lines.
*/

export const getJobCardRegister = async (req, res) => {
  try {
    const data = await loadRegisterList(parseApprovedFilter(req.body?.approved));
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load job card register." });
  }
};

export const getJobCardPending = async (req, res) => {
  try {
    const data = await loadRegisterList(false);
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending job cards." });
  }
};

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
    data.process_log = await findProcessLogByJobCard(docno);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load job card." });
  }
};

export const createJobCard = async (req, res) => {
  try {
    const primeKey = toDocno(req.body?.prime_key);
    const ids = parseIdList(req.body?.shortage_ids);
    if (!primeKey || !ids.length) {
      return res.status(400).json({ success: false, message: "prime_key and shortage_ids are required." });
    }
    if (ids.length > MAX_IDS) {
      return res.status(400).json({ success: false, message: `Too many entries (max ${MAX_IDS}).` });
    }

    const user = auditUserName(req) || "system";
    const builtPlan = buildProcessPlan(await findPrimeProcess(primeKey), req.body?.process_plan);
    const existing = await findJobCardByShortageIds(ids);
    const processPlan = withPlanStatuses(
      builtPlan,
      existing?.process_plan || [],
      statusMapFromPicks(req.body?.process_plan)
    );
    const remarkByProcess = remarkMapFromBody(req.body?.process_remarks);
    const approval =
      processPlan.length > 0
        ? { approved: true, approved_by: user, approved_at: new Date() }
        : { approved: false, approved_by: null, approved_at: null };

    if (!existing) {
      return res.status(400).json({ success: false, message: "Accept the prime item in Pending Shortage first." });
    }

    if (processPlan.length > 0) {
      await assertMaintainJobcardToolingIfRequired(existing);
    }

    const cardResult = await withTransaction(async (client) => {
      // --- DB: shortage check (read) ---
      const { rows } = await client.query(
        `SELECT s.id, s.itemdcode, s.grpname, s.type, s.qty, s.is_accepted, s.is_deleted, s.docno
         FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) ORDER BY s.id FOR UPDATE`,
        [ids]
      );
      const usedRes = await client.query(
        `SELECT s.id FROM ${IMS_TABLES.SHORTAGE} s WHERE s.id = ANY($1::int[]) AND ${shortageOnAuthorizedJobCardSql("s")}`,
        [ids]
      );
      const usedIds = new Set(usedRes.rows.map((r) => r.id));
      for (const r of rows) {
        if (Number(r.docno) === existing.docno) usedIds.delete(Number(r.id));
      }
      assertUsable(ids, rows, usedIds);

      const { itemMap } = await getImsMapsSafe();
      const primeOf = (d) => Number(itemMap.get(canonicalCode(d))?.primitemdcode) || Number(d);
      const otherPrime = rows.filter((r) => primeOf(r.itemdcode) !== primeKey).map((r) => r.id);
      if (otherPrime.length) throw httpError(400, `Not of this prime item: ${idList(otherPrime)}.`);

      const engineeringError = await checkPrimeAndFinish(primeKey, rows.map((r) => r.itemdcode));
      if (engineeringError) throw httpError(400, engineeringError);

      const remarks = String(req.body?.remarks ?? "").trim() || null;
      const status = processPlan?.length ? "Planning" : "Pending";
      const shortageTotal = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const planqtyOverride = req.body?.planqty;
      const planqty =
        planqtyOverride != null && planqtyOverride !== "" ? Number(planqtyOverride) : shortageTotal;
      if (!Number.isFinite(planqty) || planqty < 0) throw httpError(400, "planqty must be a valid number.");

      const hadPlan = parseProcessPlan(existing.process_plan).length > 0;
      const hasPlan = processPlan.length > 0;
      const prevQty = Number(existing.planqty);

      // --- DB: local job card no (prod_job_card) — ERP API nahi ---
      let cardRow = existing;
      if (existing.jobcardno == null && hasPlan) {
        const jobcarddt =
          String(req.body?.jobcarddt ?? req.body?.job_date ?? "").trim().slice(0, 10) ||
          new Date().toISOString().slice(0, 10);
        const fyid = await resolveFyidForJobCard(jobcarddt, req.body?.fyid);
        const assigned = await assignErpNumbersToJobCard(
          existing.docno,
          { jobcarddt, fyid, jobcardnoOverride: parseJobcardnoOverride(req) },
          client
        );
        if (assigned) cardRow = assigned;
      }

      const erpPayload = {
        ...cardRow,
        process_plan: processPlan,
        planqty,
        status,
        remarks,
        itemdcode: existing.itemdcode,
      };

      let erpSynced = false;
      const accCode = req.body?.acc_code ?? ERP_ACC_CODE;

      // --- ERP mjcnew (TEST: poora if/else comment = ERP nahi, sirf neeche DB save) ---
      // if (hasPlan && !hadPlan) {
      //   const ok = await syncJobCardErpAdd(erpPayload, { acc_code: accCode });
      //   if (!ok) throw httpError(502, ERP_SAVE_FAIL);
      //   erpSynced = true;
      // } else if (hadPlan && Number.isFinite(planqty) && planqty !== prevQty) {
      //   const ok = await syncJobCardErpUpdate(erpPayload);
      //   if (!ok) throw httpError(502, ERP_SAVE_FAIL);
      //   erpSynced = true;
      // }

      // --- DB: plan + qty save (prod_job_card) ---
      const saved = await updateJobCard(
        existing.docno,
        {
          process_plan: processPlan,
          status,
          remarks,
          planqty,
          updated_by: user,
          updated_at: new Date(),
          ...approval,
        },
        client
      );

      const diffs = diffProcessPlan(existing.process_plan || [], processPlan);
      await insertProcessLogRows(saved.docno, logRowsFromDiff(diffs, user, remarkByProcess), client);
      return { saved, erpSynced };
    });

    const { saved: card, erpSynced } = cardResult;
    await logActivity(req, { action: "update", entity: ENTITY, entity_id: card.docno, appType: "production", record: card });
    const [data] = await toCardRows([card]);
    const primeStages = await findPrimeProcess(primeKey);
    if (primeStages?.length) {
      data.production_time = calcJobCardProductionTime({ qty: data.qty, stages: primeStages, process_plan: processPlan });
    }
    const message = card.pjobcardno
      ? `Job card ${card.pjobcardno} saved.`
      : "Job card saved.";
    return res.json({ success: true, message, data, erpSynced });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to create job card." });
  }
};

export const updateJobCardById = async (req, res) => {
  try {
    const docno = toDocno(req.body?.docno);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findJobCard(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Job card not found." });

    const prepared = await prepareJobCardUpdate(req, existing);
    if (prepared.error) {
      return res.status(prepared.error.status).json({ success: false, message: prepared.error.message });
    }
    const { fields, hasBusinessChanges, softOpsChange, planqtyChanged, processDiffs, remarkByProcess, userName } = prepared;

    if (!Object.keys(fields).length && !processDiffs.length) {
      const [data] = await toCardRows([existing]);
      return res.json({ success: true, message: "No changes.", data });
    }

    const hadPlan = parseProcessPlan(existing.process_plan).length > 0;
    let erpSynced = false;

    const updated = await withTransaction(async (client) => {
      const draft = Object.keys(fields).length ? { ...existing, ...fields } : existing;
      const hasPlanNow = parseProcessPlan(draft.process_plan).length > 0;
      const accCode = req.body?.acc_code ?? ERP_ACC_CODE;

      // --- ERP mjcnew (TEST: poora if/else comment = ERP nahi, sirf neeche DB save) ---
      if (hasPlanNow && !hadPlan) {
        const ok = await syncJobCardErpAdd(draft, { acc_code: accCode });
        if (!ok) throw httpError(502, ERP_SAVE_FAIL);
        erpSynced = true;
      } else if (planqtyChanged) {
        const ok = await syncJobCardErpUpdate(draft);
        if (!ok) throw httpError(502, ERP_SAVE_FAIL);
        erpSynced = true;
      }

      // --- DB: prod_job_card + process log ---
      const row = Object.keys(fields).length ? await updateJobCard(docno, fields, client) : existing;
      if (processDiffs.length) {
        await insertProcessLogRows(docno, logRowsFromDiff(processDiffs, userName, remarkByProcess), client);
      }
      return row;
    });

    const [data] = await toCardRows([updated]);
    await logActivity(req, { action: "update", entity: ENTITY, entity_id: docno, appType: "production", record: data });

    const message = buildUpdateResponseMessage({ softOpsChange, hasBusinessChanges, fields, processDiffs });
    return res.json({ success: true, message, data, erpSynced });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to update job card." });
  }
};

export const approveJobCardById = async (req, res) => {
  req.body = { ...(req.body || {}), approved: true };
  return updateJobCardById(req, res);
};

export const deleteJobCardById = async (req, res) => {
  try {
    const docno = toDocno(req.body?.docno);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findJobCard(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Job card not found." });

    const onErp = Number(existing.jobcardno) > 0 && Number(existing.fyid) > 0;
    let erpSynced = false;

    // --- ERP mjcnew delete (TEST: niche 3 lines comment = ERP nahi, sirf neeche DB delete) ---
    // if (onErp) {
    //   if (!(Number(existing.itemdcode) > 0)) {
    //     throw httpError(400, "Job card is on ERP but itemdcode is missing — cannot delete on ERP.");
    //   }
    //   erpSynced = await syncJobCardErpDelete(existing);
    //   if (!erpSynced) {
    //     throw httpError(502, "ERP delete failed. Job card was not deleted in the app.");
    //   }
    // }

    // --- DB: prod_job_card hard delete ---
    const deleted = await withTransaction(async (client) => hardDeleteJobCard(docno, client));
    if (!deleted) return res.status(404).json({ success: false, message: "Job card not found." });

    await logActivity(req, { action: "delete", entity: ENTITY, entity_id: docno, appType: "production", record: deleted });
    return res.json({
      success: true,
      message: `Job card ${deleted.pjobcardno || docno} deleted.`,
      erpSynced: onErp ? erpSynced : false,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to delete job card." });
  }
};

export const getSuggestedErpJobcardno = async (req, res) => {
  try {
    if (!isSuperAdminUser(req)) {
      return res.status(403).json({ success: false, message: "Super Admin only." });
    }
    const jobcarddt =
      String(req.body?.jobcarddt ?? req.body?.job_date ?? "").trim().slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    const fyid = await resolveFyidForJobCard(jobcarddt, req.body?.fyid);
    const jcseriescode = JC_SERIES_CODE;
    const jobcardno = await nextJobcardno(jcseriescode, fyid);
    const pjobcardno = formatPJobCardNo(JOB_CARD_TYPE_DEFAULT, jobcardno);
    return res.json({ success: true, data: { jobcardno, pjobcardno, jcseriescode, fyid, jobcarddt } });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to suggest ERP job card number.",
    });
  }
};

export const getPendingShortageForJobCard = async (req, res) => {
  try {
    // Keep accepted groups visible after JC save — Pending tab Edit/Delete (Register authorize filter removed).
    const rows = await loadProductionShortages(["(s.is_accepted IS NULL OR s.is_accepted = true)"]);
    const grouped = groupByPrimeItem(rows);
    const data = grouped.map(slimJobCardPendingGroup);
    await attachOpenJobCardNo(data);
    await attachRmWireFromPrimeProcess(data, { wireList: false });
    await attachRmWireFromProduction(data, { wireList: true, setRmFlag: false });
    await attachTooling(data, { withRemark: false });
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load pending shortage." });
  }
};

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
