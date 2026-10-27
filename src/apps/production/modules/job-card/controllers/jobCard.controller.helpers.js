/**
 * Maintain Job Card — HTTP helpers (mapping, validation, process plan).
 * Logic unchanged; keeps jobCard.controller.js thin.
 */
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { calcJobCardProductionTime } from "../jobCardProductionTime.js";
import { findAllJobCards, findPrimeProcess, loadQtyItemsByShortageIds } from "../models/jobCard.model.js";
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
  return cards.map((c) => {
    const { items = [], qty = 0, shortage_approved = false, shortage_remark = null, shortage_count = 0 } =
      joined.get(c.docno) || {};
    const itemdcode = Number(c.itemdcode);
    return {
      ...c,
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
    if (!process.multi_jc && machines.length > 1) {
      throw httpError(400, `Stage ${stage.stage_no}: ${process.process_name} takes one machine.`);
    }

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

export const planKey = (plan = []) =>
  JSON.stringify(
    (plan || []).map((s) => [
      Number(s.stage_no),
      Number(s.process_id),
      (s.machines || []).map((m) => Number(m.machine_id)).sort((a, b) => a - b),
      (s.rm_items || []).map((r) => Number(r.rm_item_dcode)),
    ])
  );

export function assertApproveRequiresProcessPlan(plan) {
  const steps = Array.isArray(plan) ? plan : [];
  if (!steps.length) {
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
      if (!plan.length || !qty || !itemdcode) return;
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

export function logRowsFromDiff(diffs, userName, remarkByKey = new Map()) {
  const who = userName ? String(userName).slice(0, 100) : null;
  return diffs.map((d) => {
    const mid = Number(d.machine_id);
    const key = `${Number(d.process_id)}:${Number.isFinite(mid) && mid > 0 ? mid : 0}`;
    return {
      process_id: d.process_id,
      machine_id: Number.isFinite(mid) && mid > 0 ? mid : null,
      status: d.status,
      changed_by: who,
      remark:
        remarkByKey.get(key) ||
        remarkByKey.get(Number(d.process_id)) ||
        remarkByKey.get(String(d.process_id)) ||
        null,
    };
  });
}

export async function loadRegisterList(approvedFilter) {
  let data = await toCardRows(await findAllJobCards({ approved: approvedFilter }));
  if (approvedFilter === true) data = await attachEstShifts(data);
  return data;
}
