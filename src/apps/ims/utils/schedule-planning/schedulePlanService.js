import dbQuery, { withTransaction } from "../../../../config/db.js";
import { fetchImsDataRaw } from "../../services/ims.service.js";
import { buildInventoryReportSql } from "../inventory-report/inventoryReportSql.js";
import { deletePlans, loadAllPlanMap, loadPlanRow, planKey, upsertPlan, updatePlanStatus } from "./schedulePlanDb.js";
import { SCHEDULE_PLAN_STATUS, SCHEDULE_PLAN_ACTION, canHoldFrom, canPlanFrom, canRejectFrom, isActiveScheduleStatus, parseListFilter, SCHEDULE_LIST_FILTER, statusLabel, actionTypeLabel } from "./schedulePlanStatus.js";
import { insertScheduleTransaction, loadActionDates, loadActionReasons, loadItemTransactionHistory, loadLastTransactionMap, loadPlanDateHistoryMap, deletePlanTransactions } from "./schedulePlanTransactionDb.js";
import { buildScheduleComparison, hasScheduleComparisonMismatch } from "./schedulePlanCompare.js";
import { toPublicImsMessage } from "../erp-api/imsMeta.js";

const IMS_SCHEDULE_LIST = "schdule";

function requireFinYear(body) {
  const finYearId = String(body?.fin_year_id ?? "").trim();
  if (!finYearId) return { error: { success: false, status: 400, message: "fin_year_id is required." } };
  return { finYearId };
}

/** IMS external API expects remarks as date/qty pairs — not stored in our DB. */
function imsRemarksForSync(actionDateIso, qty) {
  const date = isoToRemark(actionDateIso);
  if (!date) return "[]";
  return JSON.stringify([{ date, qty: Number(qty) || 0 }]);
}

function isoToRemark(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  if (!y || !m || !d) return String(iso);
  return `${Number(d)}/${Number(m)}/${y.slice(-2)}`;
}

function normDate(v) {
  if (v == null || !String(v).trim()) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function localTodayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Schedule month only, from today through month-end. Returns error message or null. */
function validateScheduleTargetDate(actionDateIso, schmonth, schdt) {
  const month = Number(schmonth);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;

  let year = new Date().getFullYear();
  const schNorm = normDate(schdt);
  if (schNorm) {
    year = parseInt(schNorm.slice(0, 4), 10);
    const schM = parseInt(schNorm.slice(5, 7), 10);
    if (Number.isFinite(schM) && month < schM) year += 1;
  }

  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const max = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const monthStart = `${year}-${mm}-01`;
  const today = localTodayYmd();
  const min = today > monthStart ? today : monthStart;

  if (min > max) return "No target dates left in schedule month.";
  if (actionDateIso < min || actionDateIso > max) {
    return "Target date must be within schedule month from today onwards.";
  }
  return null;
}

function pickSnap(src = {}) {
  const q = src.totalqty ?? src.total_qty;
  return {
    schmonth: src.schmonth != null ? Number(src.schmonth) : null,
    schdt: normDate(src.schdt),
    acc_code: src.acc_code != null ? Number(src.acc_code) : null,
    acc_name: src.acc_name != null ? String(src.acc_name).trim() : null,
    item_code: src.item_code != null ? String(src.item_code).trim() : null,
    itemdesc: src.itemdesc != null ? String(src.itemdesc).trim() : null,
    totalqty: q != null ? Number(q) : null,
  };
}

function applyTxnDisplay(row, lastTxn) {
  if (!lastTxn) return row;
  return {
    ...row,
    action_date: lastTxn.action_date ?? null,
    action_reason: lastTxn.action_reason ?? null,
    item_remark: lastTxn.remark ?? null,
  };
}

function attachLastTxn(row, lastTxn, { keepStatus = false } = {}) {
  if (!lastTxn) return row;
  const toStatus = lastTxn.to_status != null ? Number(lastTxn.to_status) : null;
  const withTxn = {
    ...applyTxnDisplay(row, lastTxn),
    last_action_type: lastTxn.action_type,
    last_action_label: actionTypeLabel(lastTxn.action_type),
    last_action_at: lastTxn.created_at,
    last_action_by_name: lastTxn.created_by_name ?? null,
    last_action_reason: lastTxn.action_reason ?? null,
    last_action_date: lastTxn.action_date ?? null,
    last_txn_to_status: toStatus,
  };
  if (!keepStatus && toStatus != null && Number.isFinite(toStatus)) {
    return {
      ...withTxn,
      is_planned: toStatus,
      status: statusLabel(toStatus).toLowerCase(),
      status_label: statusLabel(toStatus),
    };
  }
  return withTxn;
}

function txnSnapshot(txn) {
  if (!txn) return null;
  return {
    action_type: txn.action_type,
    action_date: txn.action_date ?? null,
    action_reason: txn.action_reason ?? null,
    remark: txn.remark ?? null,
    created_at: txn.created_at ?? new Date().toISOString(),
    created_by_name: txn.created_by_name ?? null,
  };
}

/** API row — display values from last transaction; plan table holds status + IMS snapshot only. */
function planToRow(plan, ims = {}, lastTxn = null) {
  const imsRemarks = ims.Remarks ?? ims.remarks ?? null;
  const st = Number(plan.is_planned ?? SCHEDULE_PLAN_STATUS.PENDING);
  return attachLastTxn({
    schno: plan.schno ?? ims.schno,
    schmonth: plan.schmonth ?? ims.schmonth,
    schdt: plan.schdt ?? ims.schdt,
    acc_code: plan.acc_code ?? ims.acc_code,
    acc_name: plan.acc_name ?? ims.acc_name,
    itemdcode: plan.itemdcode ?? ims.itemdcode,
    item_code: plan.item_code ?? ims.item_code,
    itemdesc: plan.itemdesc ?? ims.itemdesc,
    totalqty: plan.totalqty ?? ims.totalqty ?? ims.total_qty,
    Remarks: imsRemarks,
    remarks: imsRemarks,
    is_planned: st,
    status: statusLabel(st).toLowerCase(),
    status_label: statusLabel(st),
    plan_id: plan.plan_id,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    created_by_name: plan.created_by_name ?? null,
    updated_by_name: plan.updated_by_name ?? null,
  }, lastTxn);
}

function attachPlanDateHistory(row, historyMap) {
  const k = planKey(row.schno, row.itemdcode);
  const all = historyMap?.get(k) ?? [];
  const previous = all.length > 1 ? all.slice(0, -1) : [];
  const st = Number(row.is_planned);
  const usePlanDate = st === SCHEDULE_PLAN_STATUS.PLANNED || st === SCHEDULE_PLAN_STATUS.RUNNING;
  const lastPlanDate = all.length ? all[all.length - 1] : null;
  return {
    ...row,
    plan_date_history: all,
    previous_plan_dates: previous,
    ...(usePlanDate && lastPlanDate ? { action_date: lastPlanDate } : {}),
  };
}

function enrichPlanDateHistory(records, historyMap) {
  if (!Array.isArray(records) || !records.length) return records;
  return records.map((row) => attachPlanDateHistory(row, historyMap));
}

async function recordTransaction({
  fin_year_id, schno, itemdcode, plan_id, action_type, from_status, to_status,
  action_date, action_reason, remark, user_id,
}) {
  try {
    await insertScheduleTransaction({
      fin_year_id, schno, itemdcode, plan_id, action_type, from_status, to_status,
      action_date, action_reason, remark, user_id,
    });
  } catch (err) {
    console.error("[schedule-planning] transaction log failed", err?.message || err);
  }
}

function attachComparison(imsRow, planRow, mergedRow) {
  const comparison = buildScheduleComparison(imsRow, planRow);
  return {
    ...mergedRow,
    comparison,
    has_comparison_mismatch: comparison.has_mismatch,
  };
}

function pendingRow(imsRow) {
  return {
    ...imsRow,
    is_planned: SCHEDULE_PLAN_STATUS.PENDING,
    status: "pending",
    status_label: "Pending",
  };
}

function buildFilteredList(imsRecords, filterMode, planMap, lastTxnMap = new Map()) {
  const rows = Array.isArray(imsRecords) ? imsRecords : [];
  const map = planMap instanceof Map ? planMap : new Map();
  const txnMap = lastTxnMap instanceof Map ? lastTxnMap : new Map();
  const seen = new Set();

  const mergedFromIms = rows.map((imsRow) => {
    const k = planKey(imsRow.schno, imsRow.itemdcode);
    seen.add(k);
    const plan = map.get(k);
    const lastTxn = txnMap.get(k) ?? null;
    if (!plan) return attachLastTxn(pendingRow(imsRow), lastTxn, { keepStatus: true });
    return attachComparison(imsRow, plan, { ...imsRow, ...planToRow(plan, imsRow, lastTxn) });
  });

  const orphanPlans = [];
  for (const plan of map.values()) {
    const k = planKey(plan.schno, plan.itemdcode);
    if (seen.has(k)) continue;
    const lastTxn = txnMap.get(k) ?? null;
    const row = planToRow(plan, {}, lastTxn);
    orphanPlans.push({
      ...row,
      comparison: { has_mismatch: true, fields: {}, missing_ims: true },
      has_comparison_mismatch: true,
    });
  }

  const allRows = [...mergedFromIms, ...orphanPlans];

  switch (filterMode) {
    case SCHEDULE_LIST_FILTER.PENDING:
      return mergedFromIms.filter((r) => {
        const plan = map.get(planKey(r.schno, r.itemdcode));
        return !plan;
      }).map((r) => attachLastTxn(pendingRow(r), txnMap.get(planKey(r.schno, r.itemdcode)) ?? null, { keepStatus: true }));

    case SCHEDULE_LIST_FILTER.SCHEDULE:
      return mergedFromIms.filter((r) => isActiveScheduleStatus(r.is_planned));

    case SCHEDULE_LIST_FILTER.COMPLETE:
      return mergedFromIms.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.COMPLETE);

    case SCHEDULE_LIST_FILTER.REJECT:
      return mergedFromIms.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.REJECT);

    case SCHEDULE_LIST_FILTER.HOLD:
      return mergedFromIms.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.HOLD);

    case SCHEDULE_LIST_FILTER.COMPARISON:
      return allRows.filter((r) => {
        const k = planKey(r.schno, r.itemdcode);
        if (!map.has(k)) return false;
        return hasScheduleComparisonMismatch(r);
      });

    case SCHEDULE_LIST_FILTER.ALL:
    default:
      return allRows;
  }
}

async function enrichFgStock(records) {
  if (!records.length) return records;
  try {
    const sql = buildInventoryReportSql();
    const stockRows = await dbQuery(
      `WITH ${sql.groupedCte}, report_filtered AS (SELECT g.* FROM report_rows g ${sql.groupWhere}),
       by_item AS (
         SELECT TRIM(f.item_dcode) AS item_dcode,
                UPPER(TRIM(f.item_code)) AS item_code,
                COALESCE(SUM(f.fg_stock_qty), 0)::bigint AS in_hand_qty
         FROM report_filtered f
         WHERE TRIM(COALESCE(f.item_dcode, '')) NOT IN ('', '—')
         GROUP BY 1, 2
       ),
       by_dcode AS (
         SELECT item_dcode, COALESCE(SUM(in_hand_qty), 0)::bigint AS in_hand_qty
         FROM by_item
         GROUP BY 1
       ),
       by_code AS (
         SELECT item_code, COALESCE(SUM(in_hand_qty), 0)::bigint AS in_hand_qty
         FROM by_item
         WHERE TRIM(COALESCE(item_code, '')) NOT IN ('', '—')
         GROUP BY 1
       )
       SELECT 'dcode' AS kind, item_dcode AS key, in_hand_qty FROM by_dcode
       UNION ALL
       SELECT 'code' AS kind, item_code AS key, in_hand_qty FROM by_code`
    );
    const byDcode = new Map();
    const byCode = new Map();
    for (const s of stockRows || []) {
      const q = Number(s.in_hand_qty) || 0;
      const key = String(s.key ?? "").trim();
      if (!key) continue;
      if (s.kind === "dcode") byDcode.set(key, q);
      else if (s.kind === "code") byCode.set(key.toUpperCase(), q);
    }
    return records.map((r) => {
      const d = String(r.itemdcode ?? "").trim();
      const i = String(r.item_code ?? "").trim().toUpperCase();
      const qty = (d && byDcode.get(d)) ?? (i && byCode.get(i)) ?? 0;
      return { ...r, fg_stock_qty: qty, in_hand_qty: qty };
    });
  } catch (err) {
    console.error("[schedule-planning] in-hand stock failed", err?.message || err);
    return records.map((r) => ({ ...r, fg_stock_qty: r.fg_stock_qty ?? 0, in_hand_qty: r.in_hand_qty ?? r.fg_stock_qty ?? 0 }));
  }
}

function imsFilter(body, finYearId) {
  const { month, fromDate, toDate } = body || {};
  const f = { fin_year_id: finYearId };
  const m = month != null ? String(month).trim() : "";
  if (m && m.toLowerCase() !== "all") f.month = m;
  if (fromDate) f.fromDate = String(fromDate).trim();
  if (toDate) f.toDate = String(toDate).trim();
  return f;
}

/** All items for one schedule (any status) — for plan/reject modal. */
async function listScheduleItemsForSchno(fy, schno) {
  const schnoNorm = String(schno ?? "").trim();
  if (!schnoNorm) {
    return { success: false, status: 400, message: "schno is required.", records: [] };
  }

  const [imsResult, planMap, lastTxnMap] = await Promise.all([
    fetchImsDataRaw(IMS_SCHEDULE_LIST, { fin_year_id: fy.finYearId, month: "all" }),
    loadAllPlanMap(fy.finYearId),
    loadLastTransactionMap(fy.finYearId),
  ]);

  const imsRows = (Array.isArray(imsResult?.records) ? imsResult.records : []).filter(
    (r) => String(r.schno ?? "").trim() === schnoNorm
  );

  const schnoPlanMap = new Map();
  for (const plan of planMap.values()) {
    if (String(plan.schno ?? "").trim() !== schnoNorm) continue;
    schnoPlanMap.set(planKey(plan.schno, plan.itemdcode), plan);
  }

  let records = buildFilteredList(imsRows, SCHEDULE_LIST_FILTER.ALL, schnoPlanMap, lastTxnMap);
  const planDateHistoryMap = await loadPlanDateHistoryMap(fy.finYearId);
  records = enrichPlanDateHistory(records, planDateHistoryMap);
  records = await enrichFgStock(records);

  const imsOk = imsResult?.success === true;
  return {
    success: records.length > 0 || imsOk,
    records,
    message:
      records.length > 0 || imsOk
        ? undefined
        : toPublicImsMessage(imsResult?.message, "Could not load schedule items."),
  };
}

async function syncIms(finYearId, body, { actionDate, qty }) {
  const { schno, itemdcode } = body;
  if (!actionDate) return;
  try {
    await fetchImsDataRaw("schedule_save", {
      fin_year_id: finYearId, schno: String(schno).trim(), itemdcode,
      target_date: isoToRemark(actionDate),
      qty: Number(qty) || 0,
      status: "schedule",
      remarks: imsRemarksForSync(actionDate, qty),
    });
  } catch (err) {
    console.warn("[schedule-planning] IMS sync skipped:", err?.message || err);
  }
}

export async function listSchedulePlanning(body = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const schno = String(body?.schno ?? "").trim();
  if (schno) {
    return listScheduleItemsForSchno(fy, schno);
  }

  const filterMode = parseListFilter(body.status);

  const [imsResult, planMap, lastTxnMap, planDateHistoryMap] = await Promise.all([
    fetchImsDataRaw(IMS_SCHEDULE_LIST, imsFilter(body, fy.finYearId)),
    loadAllPlanMap(fy.finYearId),
    loadLastTransactionMap(fy.finYearId),
    loadPlanDateHistoryMap(fy.finYearId),
  ]);

  let records = buildFilteredList(imsResult?.records, filterMode, planMap, lastTxnMap);
  records = enrichPlanDateHistory(records, planDateHistoryMap);
  records = await enrichFgStock(records);

  const imsOk = imsResult?.success === true;
  const hasRecords = records.length > 0;
  return {
    success: hasRecords || imsOk,
    records,
    message: hasRecords || imsOk
      ? undefined
      : toPublicImsMessage(imsResult?.message, "Could not load schedule data."),
  };
}

export async function listScheduleActionDates(body = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;
  const [dates, reasons] = await Promise.all([
    loadActionDates(fy.finYearId),
    loadActionReasons(fy.finYearId),
  ]);
  return { success: true, data: { action_dates: dates, reject_reasons: reasons }, reasons };
}

export async function saveSchedulePlan(body = {}, userId = null) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, item_remark, action_date } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const actionDateNorm = normDate(action_date);
  if (!actionDateNorm) {
    return { success: false, status: 400, message: "action_date is required for planning." };
  }

  const snap = pickSnap(body);
  const rangeErr = validateScheduleTargetDate(actionDateNorm, body.schmonth ?? snap.schmonth, body.schdt ?? snap.schdt);
  if (rangeErr) return { success: false, status: 400, message: rangeErr };

  const totalQty = Number(body.qty ?? body.totalqty ?? 0);

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  const fromStatus = existingRow?.is_planned != null ? Number(existingRow.is_planned) : SCHEDULE_PLAN_STATUS.PENDING;

  if (!canPlanFrom(fromStatus)) {
    return { success: false, status: 400, message: "Cannot plan from current status." };
  }

  const toStatus = fromStatus === SCHEDULE_PLAN_STATUS.PENDING || fromStatus === SCHEDULE_PLAN_STATUS.REJECT || fromStatus === SCHEDULE_PLAN_STATUS.HOLD
    ? SCHEDULE_PLAN_STATUS.PLANNED
    : fromStatus;

  const localRow = await upsertPlan({
    fin_year_id: fy.finYearId, schno, itemdcode, snap,
    user_id: userId,
    is_planned: toStatus,
  });

  if (!localRow) return { success: false, status: 500, message: "Could not save schedule plan." };

  await recordTransaction({
    fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
    action_type: SCHEDULE_PLAN_ACTION.PLAN, from_status: fromStatus, to_status: toStatus,
    action_date: actionDateNorm, action_reason: null, remark: item_remark ?? null,
    user_id: userId,
  });

  await syncIms(fy.finYearId, body, { actionDate: actionDateNorm, qty: totalQty });
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.PLAN,
    action_date: actionDateNorm,
    action_reason: null,
    remark: item_remark ?? null,
  });
  return { success: true, message: "Schedule plan saved.", data: planToRow(localRow, body, lastTxn) };
}

export async function rejectSchedulePlan(body = {}, userId = null) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, action_date, action_reason, item_remark } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }
  const ad = normDate(action_date) || normDate(new Date().toISOString().slice(0, 10));
  const reason = action_reason != null ? String(action_reason).trim() : "";
  if (!reason) return { success: false, status: 400, message: "action_reason is required for reject." };

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  const fromStatus = existingRow?.is_planned != null ? Number(existingRow.is_planned) : SCHEDULE_PLAN_STATUS.PENDING;
  const rejectUpdate = fromStatus === SCHEDULE_PLAN_STATUS.REJECT;
  if (!rejectUpdate && !canRejectFrom(fromStatus)) {
    return { success: false, status: 400, message: "Cannot reject from current status." };
  }

  let localRow;
  if (existingRow) {
    if (rejectUpdate) {
      localRow = existingRow;
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: existingRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.REJECT, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.REJECT,
        action_date: ad, action_reason: reason, remark: item_remark ?? null,
        user_id: userId,
      });
    } else {
      const updated = await updatePlanStatus({
        fin_year_id: fy.finYearId, schno, itemdcode,
        is_planned: SCHEDULE_PLAN_STATUS.REJECT,
        user_id: userId,
      });
      if (!updated) return { success: false, status: 500, message: "Could not reject schedule." };
      const map = await loadAllPlanMap(fy.finYearId);
      localRow = map.get(planKey(schno, itemdcode));
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: updated.plan_id ?? existingRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.REJECT, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.REJECT,
        action_date: ad, action_reason: reason, remark: item_remark ?? null,
        user_id: userId,
      });
    }
  } else {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_id: userId,
      is_planned: SCHEDULE_PLAN_STATUS.REJECT,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.REJECT, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.REJECT,
        action_date: ad, action_reason: reason, remark: item_remark ?? null,
        user_id: userId,
      });
    }
  }

  if (!localRow) return { success: false, status: 500, message: "Could not reject schedule." };
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.REJECT,
    action_date: ad,
    action_reason: reason,
    remark: item_remark ?? null,
  });
  return {
    success: true,
    message: rejectUpdate ? "Reject details updated." : "Schedule rejected.",
    data: planToRow(localRow, body, lastTxn),
  };
}

export async function holdSchedulePlan(body = {}, userId = null) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, item_remark } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  const fromStatus = existingRow?.is_planned != null ? Number(existingRow.is_planned) : SCHEDULE_PLAN_STATUS.PENDING;
  const holdUpdate = fromStatus === SCHEDULE_PLAN_STATUS.HOLD;
  if (!holdUpdate && !canHoldFrom(fromStatus)) {
    return { success: false, status: 400, message: "Cannot hold from current status." };
  }

  const itemRemark = item_remark ?? null;

  let localRow;
  if (existingRow && holdUpdate) {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_id: userId,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: null, action_reason: null, remark: itemRemark,
        user_id: userId,
      });
    }
  } else if (existingRow) {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_id: userId,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: null, action_reason: null, remark: itemRemark,
        user_id: userId,
      });
    }
  } else {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_id: userId,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: null, action_reason: null, remark: itemRemark,
        user_id: userId,
      });
    }
  }

  if (!localRow) return { success: false, status: 500, message: "Could not hold schedule." };
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.HOLD,
    action_date: null,
    action_reason: null,
    remark: itemRemark,
  });
  return {
    success: true,
    message: holdUpdate ? "Hold details updated." : "Schedule put on hold.",
    data: planToRow(localRow, body, lastTxn),
  };
}

export async function listScheduleItemTransactions(body = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const rows = await loadItemTransactionHistory(fy.finYearId, schno, itemdcode);
  return {
    success: true,
    data: rows.map((row) => ({
      ...row,
      from_status_label: statusLabel(row.from_status),
      to_status_label: statusLabel(row.to_status),
      action_label: actionTypeLabel(row.action_type),
    })),
  };
}

export async function removeSchedulePlan(body = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const schno = String(body?.schno ?? "").trim();
  if (!schno) {
    return { success: false, status: 400, message: "schno is required." };
  }

  const scope = { fin_year_id: fy.finYearId, schno };

  const { planDeleted, txnDeleted } = await withTransaction(async (client) => {
    const txnDeleted = await deletePlanTransactions(scope, client);
    const planDeleted = await deletePlans(scope, client);
    return { planDeleted, txnDeleted };
  });

  if (!planDeleted) {
    return { success: false, status: 404, message: "No schedule plan found to delete." };
  }

  return {
    success: true,
    message: planDeleted === 1
      ? "Schedule deleted."
      : `Schedule deleted (${planDeleted} items).`,
    deleted_count: planDeleted,
    txn_deleted_count: txnDeleted,
  };
}
