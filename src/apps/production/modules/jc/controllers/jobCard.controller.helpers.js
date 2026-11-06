/**
 * Maintain Job Card — helpers (map / validate / build plan / prepare update).
 */
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { calcJobCardProductionTime } from "../jobCardProductionTime.js";
import { JOB_CARD_STATUSES, findAllJobCards, findPrimeProcess, loadQtyItemsByShortageIds } from "../models/jobCard.model.js";
import { loadProcessPlanMapsByJobCards } from "../../plan/models/plan.model.js";
import { statusMapFromPicks, stripPlanStatuses } from "../processPlanStatus.js";
import { isProductionScopeRow } from "../../shortage/utils/primeItemShortage.js";
import { issueQtyKg, JOB_CARD_TYPE_KEY } from "../jobCard.config.js";

export function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export const toDocno = (v) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(toDocno).filter(Boolean))];
}

export const idList = (ids) => ids.map((id) => `#${id}`).join(", ");

export function isSuperAdminUser(req) {
  return String(req.user?.type || "").toLowerCase().trim() === "super_admin";
}

export function parseJobcardnoOverride(req) {
  const raw = req.body?.jobcardno;
  if (raw == null || raw === "") return null;
  if (!isSuperAdminUser(req)) {
    throw httpError(403, "Only Super Admin can set ERP job card number.");
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw httpError(400, "jobcardno must be a positive whole number (e.g. 14129).");
  }
  return n;
}

/** body.approved: true | false | omit → filter for register list. */
export function parseApprovedFilter(raw) {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return undefined;
}

function itemGweight(itemMap, itemdcode) {
  const w = itemMap.get(canonicalCode(itemdcode))?.gweight;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function enrichJobCardDrawerRow(row, itemMap) {
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

export async function toCardRows(cards = []) {
  const { itemMap } = await getImsMapsSafe();
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  const joined = await loadQtyItemsByShortageIds(cards);
  const planByJc = await loadProcessPlanMapsByJobCards(cards.map((c) => c.pjobcardno));
  return cards.map((c) => {
    const { items = [], qty = 0, shortage_approved = false, shortage_remark = null, shortage_count = 0 } =
      joined.get(c.docno) || {};
    const itemdcode = Number(c.itemdcode);
    const pjc = String(c.pjobcardno || "").trim();
    // Rebuilt from prod_plan (not stored on prod_jc).
    const process_plan = planByJc.get(pjc) || [];
    return {
      ...c,
      process_plan,
      pjobcardno: c.pjobcardno,
      jobcarddt: c.jobcarddt,
      itemdcode,
      job_card_no: c.pjobcardno,
      doc_no: c.pjobcardno,
      job_date: c.jobcarddt,
      doc_dt: c.jobcarddt,
      prime_item_dcode: itemdcode,
      prime_item_code: info(itemdcode).item_code || String(itemdcode),
      prime_item_desc: info(itemdcode).item_desc || null,
      qty,
      items: items.map((it) => ({ ...it, item_code: info(it.itemdcode).item_code || String(it.itemdcode) })),
      type: Number(c.type) || 0,
      type_key: JOB_CARD_TYPE_KEY[Number(c.type)] || "jc",
      shortage_approved,
      shortage_remark,
      shortage_count,
      created_by_name: c.created_by || null,
      updated_by_name: c.updated_by || null,
      approved_by_name: c.approved_by || null,
      tooling_by_name: c.tooling_by || null,
    };
  });
}

export function assertUsable(ids, rows, usedIds) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !isProductionScopeRow(byId.get(id)));
  if (missing.length) throw httpError(400, `Shortage entry not found: ${idList(missing)}.`);

  const notApproved = rows.filter((r) => r.is_accepted !== true).map((r) => r.id);
  if (notApproved.length) {
    throw httpError(
      400,
      `Not accepted: ${idList(notApproved)}. Accept them in Maintain Job Card (Pending) or Shortage → Prime Item first.`
    );
  }

  const used = rows.filter((r) => usedIds.has(r.id)).map((r) => r.id);
  if (used.length) throw httpError(400, `Already used in a job card: ${idList(used)}.`);
}

export function buildProcessPlan(stages, picks) {
  if (!stages) throw httpError(400, "No prime process saved for this prime item in Engineering → Prime Process Master.");
  const pickByStage = new Map((Array.isArray(picks) ? picks : []).map((p) => [Number(p.stage_no), p]));

  return stages.map((stage) => {
    const pick = pickByStage.get(Number(stage.stage_no)) || {};
    const process = stage.processes.find((p) => p.process_id === Number(pick.process_id));
    if (!process) throw httpError(400, `Stage ${stage.stage_no}: select a process.`);

    const machineIds = (Array.isArray(pick.machine_ids) ? pick.machine_ids : []).map(Number);
    const machines = process.machines.filter((m) => machineIds.includes(m.machine_id));
    if (process.machines.length && !machines.length) {
      throw httpError(
        400,
        machineIds.length
          ? `Stage ${stage.stage_no}: machine is not mapped to ${process.process_name}.`
          : `Stage ${stage.stage_no}: select a machine.`
      );
    }
    if (!process.multi_jc && !process.default_mc && machines.length > 1) {
      throw httpError(400, `Stage ${stage.stage_no}: ${process.process_name} takes one machine.`);
    }

    // One wire only (even if UI sent many).
    const rmId = Number((Array.isArray(pick.rm_item_dcodes) ? pick.rm_item_dcodes : [])[0]);
    const rm = Number.isFinite(rmId) && rmId > 0
      ? process.rm_items.find((r) => Number(r.rm_item_dcode) === rmId)
      : null;
    if (process.rm_items.length && !rm) throw httpError(400, `Stage ${stage.stage_no}: select RM.`);

    return {
      stage_no: stage.stage_no,
      process_id: process.process_id,
      process_name: process.process_name,
      machines: machines.map((m) => ({ machine_id: m.machine_id, machine_name: m.macname || m.name })),
      rm_items: rm
        ? [{ itemdcode: Number(rm.rm_item_dcode), rm_item_dcode: Number(rm.rm_item_dcode), rm_item_code: rm.rm_item_code || null }]
        : [],
    };
  });
}

export const planKey = (plan = []) =>
  JSON.stringify(
    (plan || []).map((s) => [
      Number(s.stage_no),
      Number(s.process_id),
      (s.machines || []).map((m) => Number(m.machine_id)).sort((a, b) => a - b),
      (s.rm_items || []).slice(0, 1).map((r) => Number(r.itemdcode ?? r.rm_item_dcode)),
    ])
  );

export function assertApproveRequiresProcessPlan(planOrHasPlan) {
  const ok = typeof planOrHasPlan === "boolean"
    ? planOrHasPlan
    : Array.isArray(planOrHasPlan) && planOrHasPlan.length > 0;
  if (!ok) {
    throw httpError(400, "Save process plan first — job card can be authorized only after process plan is set.");
  }
}

export function assertApproveRequiresTooling(card) {
  assertMaintainJobcardTooling(card, "authorize");
}

export function assertMaintainJobcardTooling(card, mode = "save") {
  if (card?.tooling_approved === true) return;
  const action = mode === "authorize" ? "authorizing the job card" : "saving the process plan on Maintain Job Card";
  if (card?.tooling_approved === false) {
    throw httpError(400, `Tooling is No — set Tooling to Yes in Production → Tooling before ${action}.`);
  }
  throw httpError(400, `Tooling is pending — approve in Production → Tooling before ${action}.`);
}

export async function assertMaintainJobcardToolingIfRequired(card) {
  const { getProductionMaintainJobcardToolingRequired } = await import("../../../../core/configuration/models/appConfig.model.js");
  if (!(await getProductionMaintainJobcardToolingRequired())) return;
  const itemdcode = Number(card?.itemdcode ?? card?.item_dcode);
  if (itemdcode) {
    const { findPrimeProcess } = await import("../models/jobCard.model.js");
    const { primeProcessRequiresTooling } = await import("../../shortage/utils/primeItemShortage.js");
    const stages = await findPrimeProcess(itemdcode);
    if (!primeProcessRequiresTooling(stages)) return;
  }
  assertMaintainJobcardTooling(card);
}

export async function attachEstShifts(rows = []) {
  const stageCache = new Map();
  await Promise.all(
    rows.map(async (row) => {
      const plan = Array.isArray(row.process_plan) ? row.process_plan : [];
      const qty = Number(row.qty) || 0;
      const itemdcode = Number(row.itemdcode);
      row.est_shifts = null;
      row.stage1_shifts = null;
      row.stage1_machine_shifts = null;
      if (!plan.length || !qty || !itemdcode) return; // process_plan attached in toCardRows from prod_plan
      if (!stageCache.has(itemdcode)) {
        try {
          stageCache.set(itemdcode, await findPrimeProcess(itemdcode));
        } catch {
          stageCache.set(itemdcode, null);
        }
      }
      const stages = stageCache.get(itemdcode);
      if (!stages?.length) return;
      const est = calcJobCardProductionTime({ qty, stages, process_plan: plan });
      if (!est?.valid) return;
      row.est_shifts = est.shifts ?? null;
      const st1 = (est.stages || []).find((s) => Number(s.stage_no) === 1) || est.stages?.[0] || null;
      row.stage1_shifts = st1?.shifts ?? null;
      const byMac = {};
      for (const m of st1?.machines || []) {
        const id = Number(m.machine_id);
        if (id) byMac[id] = Number(m.shifts) || 0;
      }
      row.stage1_machine_shifts = Object.keys(byMac).length ? byMac : null;
    })
  );
  return rows;
}

export function remarkMapFromBody(raw) {
  const map = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [k, v] of Object.entries(raw)) {
    const text = String(v ?? "").trim();
    if (!text) continue;
    const key = String(k).trim();
    if (!key) continue;
    map.set(key, text.slice(0, 500));
    const id = Number(key);
    if (Number.isFinite(id) && id > 0) map.set(id, text.slice(0, 500));
  }
  return map;
}

export async function loadRegisterList(approvedFilter) {
  let data = await toCardRows(await findAllJobCards({ approved: approvedFilter }));
  if (approvedFilter === true) data = await attachEstShifts(data);
  return data;
}

/**
 * Returns all IMS item codes that share the same primary item as `rootDcode`
 * (matches Product Master primary item linkage, including siblings).
 */
function itemdcodesByPrimary(itemMap, rootDcode) {
  const root = canonicalCode(rootDcode);
  if (!root || !itemMap?.size) return [];
  const meta = itemMap.get(root) || {};
  const primKey = canonicalCode(meta.primitemdcode) || root;
  const primCode = String(meta.primitem_code || meta.item_code || "").trim().toUpperCase();
  const out = [];
  for (const [dcode, it] of itemMap.entries()) {
    const itPrim = canonicalCode(it.primitemdcode) || dcode;
    const itPrimCode = String(it.primitem_code || "").trim().toUpperCase();
    const itCode = String(it.item_code || "").trim().toUpperCase();
    const match =
      dcode === root ||
      dcode === primKey ||
      itPrim === root ||
      itPrim === primKey ||
      (primCode && (itPrimCode === primCode || itCode === primCode));
    if (match) {
      const n = Number(dcode);
      if (n > 0) out.push(n);
    }
  }
  return out;
}

/** Lightweight register rows for pickers: job card, primary-item family, and shortage items. */
export async function loadRegisterPickerList(approvedFilter) {
  const cards = await findAllJobCards({ approved: approvedFilter });
  const { itemMap } = await getImsMapsSafe();
  const info = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  const joined = await loadQtyItemsByShortageIds(cards);
  return (cards || [])
    .map((c) => {
      const pjobcardno = String(c.pjobcardno || "").trim();
      if (!pjobcardno) return null;
      const itemdcode = Number(c.itemdcode) > 0 ? Number(c.itemdcode) : null;
      const prime = info(c.itemdcode);
      const item_code = String(prime.item_code || c.itemdcode || "").trim() || null;
      const item_desc = String(prime.item_desc || "").trim() || null;
      const seen = new Set();
      const items = [];
      const pushItem = (dcode, extra = {}) => {
        const id = Number(dcode);
        if (!(id > 0) || seen.has(id)) return;
        seen.add(id);
        const meta = info(id);
        items.push({
          itemdcode: id,
          item_code: String(meta.item_code || id).trim(),
          item_desc: String(meta.item_desc || "").trim() || null,
          ...extra,
        });
      };
      if (itemdcode) pushItem(itemdcode, { is_prime: true });
      /** Include every item in the same Product Master primary family. */
      for (const id of itemdcodesByPrimary(itemMap, itemdcode)) {
        pushItem(id, { is_prime: id === itemdcode });
      }
      for (const it of joined.get(c.docno)?.items || []) pushItem(it.itemdcode, { qty: it.qty });
      return { pjobcardno, itemdcode, item_code, item_desc, items };
    })
    .filter(Boolean);
}

/** POST /jc/update — parse body → JC fields + nextPlan (prod_plan) + statusOverrides. */
export async function prepareJobCardUpdate(req, existing) {
  const fields = {};
  let hasBusinessChanges = false;
  let softOpsChange = false;
  let planqtyChanged = false;
  const userName = auditUserName(req) || "system";
  let statusOverrides = new Map();
  let processDiffs = [];
  let nextPlan;

  const status = req.body.status != null ? String(req.body.status).trim() : "";
  if (status && status !== existing.status) {
    if (!JOB_CARD_STATUSES.includes(status)) {
      return { error: { status: 400, message: `status must be one of: ${JOB_CARD_STATUSES.join(", ")}.` } };
    }
    fields.status = status;
    softOpsChange = true;
  }

  if (req.body.remarks !== undefined) {
    const remarks = req.body.remarks == null ? null : String(req.body.remarks) || null;
    if (remarks !== (existing.remarks ?? null)) {
      fields.remarks = remarks;
      hasBusinessChanges = true;
      softOpsChange = false;
    }
  }

  const jobDate = String(req.body.jobcarddt ?? req.body.job_date ?? req.body.pldt ?? "").trim().slice(0, 10);
  if (jobDate && jobDate !== String(existing.jobcarddt ?? "").slice(0, 10)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jobDate) || Number.isNaN(Date.parse(jobDate))) {
      return { error: { status: 400, message: "jobcarddt must be a valid date (YYYY-MM-DD)." } };
    }
    fields.jobcarddt = jobDate;
    softOpsChange = true;
  }

  if (req.body.planqty !== undefined && req.body.planqty !== null && req.body.planqty !== "") {
    const pq = Number(req.body.planqty);
    if (!Number.isFinite(pq) || pq < 0) {
      return { error: { status: 400, message: "planqty must be a valid number." } };
    }
    if (pq !== Number(existing.planqty)) {
      fields.planqty = pq;
      planqtyChanged = true;
      hasBusinessChanges = true;
      softOpsChange = false;
    }
  }

  const pjc = String(existing.pjobcardno || "").trim();
  const existingPlan = pjc ? (await loadProcessPlanMapsByJobCards([pjc])).get(pjc) || [] : [];

  if (req.body.process_plan !== undefined) {
    const built = stripPlanStatuses(buildProcessPlan(await findPrimeProcess(existing.itemdcode), req.body.process_plan));
    statusOverrides = statusMapFromPicks(req.body.process_plan);
    nextPlan = built;

    if (planKey(built) !== planKey(existingPlan)) {
      const noMachines = (p) => planKey((p || []).map((s) => ({ ...s, machines: [] })));
      if (req.body.machine_move === true && noMachines(built) === noMachines(existingPlan)) {
        softOpsChange = true;
      } else {
        if (built.length && existing.status === "Pending") fields.status = "Planning";
        hasBusinessChanges = true;
        softOpsChange = false;
      }
    } else if (statusOverrides.size) {
      softOpsChange = true;
      processDiffs = [...statusOverrides.entries()].map(([key, st]) => {
        const [process_id, machine_id] = String(key).split(":");
        return { process_id: Number(process_id), machine_id: Number(machine_id) || null, status: st };
      });
    }

    if (built.length) await assertMaintainJobcardToolingIfRequired(existing);
  }

  if (req.body.approved === true && existing.approved !== true) {
    fields.approved = true;
    fields.approved_by = userName;
    fields.approved_at = new Date();
  } else if (req.body.approved === false && existing.approved === true) {
    fields.approved = false;
    fields.approved_by = null;
    fields.approved_at = null;
  }

  const planAfter = nextPlan !== undefined ? nextPlan : existingPlan;
  if (req.body.approved == null && planAfter.length && existing.approved !== true) {
    fields.approved = true;
    fields.approved_by = userName;
    fields.approved_at = new Date();
  }

  if (Object.keys(fields).length || softOpsChange || hasBusinessChanges || statusOverrides.size || nextPlan !== undefined) {
    fields.updated_by = userName;
    fields.updated_at = new Date();
  }

  return {
    fields,
    hasBusinessChanges,
    softOpsChange,
    planqtyChanged,
    processDiffs,
    statusOverrides,
    nextPlan,
    existingPlan,
  };
}

export function buildUpdateResponseMessage({ softOpsChange, hasBusinessChanges, fields, processDiffs }) {
  if (softOpsChange && !hasBusinessChanges) {
    if (fields.status && !fields.jobcarddt && !processDiffs.length) return `Job card status → ${fields.status}.`;
    if (processDiffs.length && !fields.jobcarddt && !fields.status) return "Process status updated.";
    return "Job card schedule updated.";
  }
  return "Job card updated.";
}
