import dbQuery, { withTransaction } from "../../../../../../config/db/db.js";
import { fetchImsDataRaw } from "../../../../lib/services/ims.service.js";
import { buildInventoryReportSql } from "../../../inventory-report/utils/sql/inventoryReportSql.js";
import { deletePlans, loadAllPlanMap, loadCustomerMonthScheduleItems, loadDispatchCompleteTabItems, loadDispatchPlanItems, loadPlanRow, loadScheduleDispatchQtyMap, planKey, upsertPlan, updatePlanStatus, setPlanShortageNo } from "../db/schedulePlanDb.js";
import { SCHEDULE_PLAN_STATUS, SCHEDULE_PLAN_ACTION, canCompleteFrom, canHoldFrom, canPlanFrom, canReadyFrom, canRejectFrom, canTransitionAsSuperAdmin, normalizeScheduleStatus, parseListFilter, SCHEDULE_LIST_FILTER, SCHEDULE_REPORT_FILTER, statusLabel, actionTypeLabel, isScheduleCompleteRow, isScheduleOpenPlanRow, filterScheduleRowsByBalanceTab } from "../status/schedulePlanStatus.js";
import { insertScheduleTransaction, loadActionDates, loadActionReasons, loadItemTransactionHistory, loadLastTransactionMap, loadPlanDateHistoryMap, deletePlanTransactions } from "../db/schedulePlanTransactionDb.js";
import { buildScheduleComparison, hasScheduleComparisonMismatch } from "../compare/schedulePlanCompare.js";
import { toPublicImsMessage } from "../../../../lib/utils/erp-api/lookup/imsMeta.js";

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
  const parts = s.split("/");
  if (parts.length === 3) {
    let [d, m, y] = parts.map((p) => p.trim());
    if (y.length === 2) y = `20${y}`;
    const dd = String(Number(d)).padStart(2, "0");
    const mm = String(Number(m)).padStart(2, "0");
    if (/^\d{4}$/.test(y) && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1) {
      return `${y}-${mm}-${dd}`;
    }
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
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
  const actionDate =
    lastTxn.action_date
    ?? (lastTxn.created_at != null ? String(lastTxn.created_at).slice(0, 10) : null);
  return {
    ...row,
    action_date: actionDate,
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
    // Prefer txn action_date; fall back to when the action was recorded.
    last_action_date:
      lastTxn.action_date
      ?? (lastTxn.created_at != null ? String(lastTxn.created_at).slice(0, 10) : null),
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
  const st = normalizeScheduleStatus(plan.is_planned ?? SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH);
  return attachLastTxn({
    schno: plan.schno ?? ims.schno,
    schmonth: plan.schmonth ?? ims.schmonth,
    schdt: plan.schdt ?? ims.schdt,
    acc_code: plan.acc_code ?? ims.acc_code,
    acc_name: plan.acc_name ?? ims.acc_name,
    itemdcode: plan.itemdcode ?? ims.itemdcode,
    item_code: plan.item_code ?? ims.item_code,
    itemdesc: plan.itemdesc ?? ims.itemdesc,
    custitemcode: ims.custitemcode ?? plan.custitemcode ?? null,
    totalqty: plan.totalqty ?? ims.totalqty ?? ims.total_qty,
    Remarks: imsRemarks,
    remarks: imsRemarks,
    is_planned: st,
    status: statusLabel(st).toLowerCase(),
    status_label: statusLabel(st),
    plan_id: plan.plan_id,
    shortage_no: plan.shortage_no ?? null,
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
  const lastPlanDate = all.length ? all[all.length - 1] : null;
  // Target date belongs to Plan rows only (not Ready).
  const usePlanDate = st === SCHEDULE_PLAN_STATUS.PLANNED || st === SCHEDULE_PLAN_STATUS.RUNNING;
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
  action_date, action_reason, remark, user_name,
}) {
  try {
    await insertScheduleTransaction({
      fin_year_id, schno, itemdcode, plan_id, action_type, from_status, to_status,
      action_date, action_reason, remark, user_name,
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

/**
 * IMS line not in our DB → Ready to Dispatch (7). Status 0 kept in code for future.
 */
function imsOnlyReadyRow(imsRow) {
  const st = SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH;
  return {
    ...imsRow,
    is_planned: st,
    status: statusLabel(st).toLowerCase(),
    status_label: statusLabel(st),
    plan_id: null,
    in_db: false,
  };
}

/** No DB row / legacy Pending (0) → Ready to Dispatch (7) for transitions. */
function effectiveFromStatus(existingRow) {
  if (existingRow?.is_planned != null && existingRow.is_planned !== "") {
    return normalizeScheduleStatus(existingRow.is_planned);
  }
  return SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH;
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
    if (!plan) {
      // Not in plan table → Ready to Dispatch (7).
      // If txn history has a real to_status (Ready/Plan/Hold/…), use that.
      const txnStatus =
        lastTxn?.to_status != null && lastTxn.to_status !== ""
          ? Number(lastTxn.to_status)
          : null;
      const hasRealTxnStatus =
        Number.isFinite(txnStatus) && txnStatus !== SCHEDULE_PLAN_STATUS.PENDING;
      const base = imsOnlyReadyRow(imsRow);
      if (hasRealTxnStatus) {
        return attachLastTxn(
          {
            ...base,
            is_planned: txnStatus,
            status: statusLabel(txnStatus).toLowerCase(),
            status_label: statusLabel(txnStatus),
          },
          lastTxn,
          { keepStatus: true }
        );
      }
      return attachLastTxn(base, lastTxn, { keepStatus: true });
    }
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

  // Comparison = live ERP/API rows only (skip DB-only rows not in current API).
  const allRows =
    filterMode === SCHEDULE_LIST_FILTER.COMPARISON
      ? mergedFromIms
      : [...mergedFromIms, ...orphanPlans];

  switch (filterMode) {
    case SCHEDULE_LIST_FILTER.PENDING:
      return allRows.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.PENDING);

    case SCHEDULE_LIST_FILTER.READY_TO_DISPATCH:
      // return allRows.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH);
      return allRows.filter((r) => {
        const code = Number(r.is_planned);
        return code === SCHEDULE_PLAN_STATUS.PENDING || code === SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH;
      });

    case SCHEDULE_LIST_FILTER.PENDING_HOLD_REJECT:
      return allRows.filter((r) => {
        const code = Number(r.is_planned);
        // return (code === SCHEDULE_PLAN_STATUS.PENDING || code === SCHEDULE_PLAN_STATUS.HOLD || code === SCHEDULE_PLAN_STATUS.REJECT);
        return code === SCHEDULE_PLAN_STATUS.HOLD || code === SCHEDULE_PLAN_STATUS.REJECT;
      });

    case SCHEDULE_LIST_FILTER.PLAN:
      return allRows.filter((r) => {
        const code = Number(r.is_planned);
        return code === SCHEDULE_PLAN_STATUS.PLANNED || code === SCHEDULE_PLAN_STATUS.RUNNING;
      });

    case SCHEDULE_LIST_FILTER.COMPLETE:
      return allRows.filter((r) => {
        const code = Number(r.is_planned);
        return (code === SCHEDULE_PLAN_STATUS.COMPLETE || code === SCHEDULE_PLAN_STATUS.PLANNED || code === SCHEDULE_PLAN_STATUS.RUNNING);
      });

    case SCHEDULE_LIST_FILTER.REJECT:
      return allRows.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.REJECT);

    case SCHEDULE_LIST_FILTER.HOLD:
      return allRows.filter((r) => Number(r.is_planned) === SCHEDULE_PLAN_STATUS.HOLD);

    case SCHEDULE_LIST_FILTER.COMPARISON:
      // ERP (live API) + our DB snapshot + field mismatch only.
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

async function enrichScheduleDispatchBalances(records, { excludeFuid = null } = {}) {
  if (!records.length) return records;
  try {
    const dispatchMap = await loadScheduleDispatchQtyMap({ excludeFuid });
    return records.map((r) => {
      const scheduleQty = Number(r.totalqty ?? r.total_qty ?? 0);
      const dispatched = Number(dispatchMap.get(planKey(r.schno, r.itemdcode)) ?? 0);
      const balanceQty = scheduleQty - dispatched;
      return {
        ...r,
        schedule_qty: scheduleQty,
        dispatch_qty: dispatched,
        balance_qty: balanceQty,
      };
    });
  } catch (err) {
    console.error("[schedule-planning] dispatch balance failed", err?.message || err);
    return records.map((r) => {
      const scheduleQty = Number(r.totalqty ?? r.total_qty ?? 0);
      return { ...r, schedule_qty: scheduleQty, dispatch_qty: 0, balance_qty: scheduleQty };
    });
  }
}

function currentScheduleMonth() {
  return String(new Date().getMonth() + 1);
}

function monthDocdtBounds(monthNum) {
  const m = Number(monthNum);
  if (!Number.isFinite(m) || m < 1 || m > 12) return { from: null, to: null };
  const year = new Date().getFullYear();
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(year, m, 0).getDate();
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

function buildImsScheduleFilterSql(body, finYearId) {
  const fyId = Number(finYearId);
  if (!Number.isFinite(fyId)) return null;

  const parts = [`m.fyid = ${fyId}`];

  const monthRaw = body?.month != null ? String(body.month).trim() : "";
  const hasMonth = monthRaw && monthRaw.toLowerCase() !== "all";
  const from = normDate(body?.fromDate);
  const to = normDate(body?.toDate) || from;

  if (hasMonth) {
    const m = Number(monthRaw);
    if (Number.isFinite(m) && m >= 1 && m <= 12) {
      parts.push(`m.schmonth = ${m}`);
      // Month-only: IMS expects docdt bounds too (same as manual date-range filter).
      if (!from && !to) {
        const bounds = monthDocdtBounds(m);
        if (bounds.from) parts.push(`m.docdt >= '${bounds.from}'`);
        if (bounds.to) parts.push(`m.docdt <= '${bounds.to}'`);
      }
    }
  }
  if (from) {
    parts.push(`m.docdt >= '${from}'`);
  }
  if (to) {
    parts.push(`m.docdt <= '${to}'`);
  }

  return parts.join(" and ");
}

function customReportHasMonthOrDate(body) {
  const monthRaw = body?.month != null ? String(body.month).trim() : "";
  const hasMonth = monthRaw && monthRaw.toLowerCase() !== "all";
  const hasDate = Boolean(normDate(body?.fromDate)) || Boolean(normDate(body?.toDate));
  return hasMonth || hasDate;
}

function reportScopeBounds(body) {
  const reportType = String(body?.reportType ?? SCHEDULE_REPORT_FILTER.DEFAULT).toLowerCase();
  if (reportType !== SCHEDULE_REPORT_FILTER.CUSTOM) return null;

  const monthRaw = body?.month != null ? String(body.month).trim() : "";
  const hasMonth = monthRaw && monthRaw.toLowerCase() !== "all";
  let from = normDate(body?.fromDate);
  let to = normDate(body?.toDate) || from;
  let month = null;
  if (hasMonth) {
    const m = Number(monthRaw);
    if (Number.isFinite(m) && m >= 1 && m <= 12) month = m;
  }
  if (month != null && !normDate(body?.fromDate) && !normDate(body?.toDate)) {
    const bounds = monthDocdtBounds(month);
    from = bounds.from;
    to = bounds.to;
  }
  return { month, from, to };
}

function rowScheduleDate(row) {
  return normDate(row?.docdt ?? row?.schdt);
}

/** Custom post-filter — drops rows outside selected month/date (IMS SQL can miss orphan DB rows). */
function rowMatchesReportScope(row, scope) {
  if (!scope) return true;
  const { month, from, to } = scope;

  if (month != null) {
    const rowMonth = Number(row?.schmonth);
    if (Number.isFinite(rowMonth) && rowMonth >= 1 && rowMonth <= 12 && rowMonth !== month) {
      return false;
    }
  }

  if (from || to) {
    const docdt = rowScheduleDate(row);
    if (!docdt) return false;
    if (from && docdt < from) return false;
    if (to && docdt > to) return false;
  }

  return true;
}

function applyReportScopeFilter(records, body) {
  if (!Array.isArray(records) || !records.length) return records;
  const reportType = String(body?.reportType ?? SCHEDULE_REPORT_FILTER.DEFAULT).toLowerCase();
  if (reportType !== SCHEDULE_REPORT_FILTER.CUSTOM) return records;
  const scope = reportScopeBounds(body);
  if (!scope || (scope.month == null && !scope.from && !scope.to)) return records;
  return records.filter((row) => rowMatchesReportScope(row, scope));
}

function decorateScheduleDisplayStatus(row) {
  if (!isScheduleCompleteRow(row)) return row;

  const dbStatus = Number(row.db_is_planned ?? row.is_planned ?? SCHEDULE_PLAN_STATUS.PENDING);
  const code = SCHEDULE_PLAN_STATUS.COMPLETE;

  if (
    Number(row.is_planned) === code &&
    row.status_label === statusLabel(code) &&
    row.db_is_planned != null
  ) {
    return row;
  }

  return {
    ...row,
    db_is_planned: dbStatus,
    is_planned: code,
    status: statusLabel(code).toLowerCase(),
    status_label: statusLabel(code),
  };
}

function decorateScheduleDisplayRows(records) {
  if (!Array.isArray(records) || !records.length) return records;
  return records.map(decorateScheduleDisplayStatus);
}

/** Default = `{ requestedData: "schdule" }`. Custom = SQL on m.fyid / m.schmonth / m.docdt. */
function imsFilterForReport(body, finYearId) {
  const reportType = String(body?.reportType ?? SCHEDULE_REPORT_FILTER.DEFAULT).toLowerCase();
  if (reportType !== SCHEDULE_REPORT_FILTER.CUSTOM) {
    return null;
  }
  return buildImsScheduleFilterSql(body, finYearId);
}

/** Active items for one schedule — for plan modal (excludes complete & reject). */
async function listScheduleItemsForSchno(fy, schno) {
  const schnoNorm = String(schno ?? "").trim();
  if (!schnoNorm) {
    return { success: false, status: 400, message: "schno is required.", records: [] };
  }

  const [imsResult, planMap, lastTxnMap] = await Promise.all([
    fetchImsDataRaw(IMS_SCHEDULE_LIST, null),
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
  records = records.filter((r) => {
    const st = Number(r.is_planned ?? SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH);
    return st !== SCHEDULE_PLAN_STATUS.COMPLETE && st !== SCHEDULE_PLAN_STATUS.REJECT;
  });
  const planDateHistoryMap = await loadPlanDateHistoryMap(fy.finYearId);
  records = enrichPlanDateHistory(records, planDateHistoryMap);
  records = await enrichFgStock(records);
  records = await enrichScheduleDispatchBalances(records);
  records = decorateScheduleDisplayRows(records);
  records = records.filter((r) => !isScheduleCompleteRow(r));

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
  const reportType = String(body?.reportType ?? SCHEDULE_REPORT_FILTER.DEFAULT).toLowerCase();

  if (reportType === SCHEDULE_REPORT_FILTER.CUSTOM && !customReportHasMonthOrDate(body)) {
    return {
      success: false,
      status: 400,
      message: "Custom report requires a month or date range (or both).",
      records: [],
    };
  }

  const imsFilter = imsFilterForReport(body, fy.finYearId);
  if (reportType === SCHEDULE_REPORT_FILTER.CUSTOM && !imsFilter) {
    return {
      success: false,
      status: 400,
      message: "Invalid financial year for custom report.",
      records: [],
    };
  }

  const [imsResult, planMap, lastTxnMap, planDateHistoryMap] = await Promise.all([
    fetchImsDataRaw(IMS_SCHEDULE_LIST, imsFilter),
    loadAllPlanMap(fy.finYearId),
    loadLastTransactionMap(fy.finYearId),
    loadPlanDateHistoryMap(fy.finYearId),
  ]);

  let records = buildFilteredList(imsResult?.records, filterMode, planMap, lastTxnMap);
  // Hide DB-only rows no longer returned by ERP/API (all tabs including Comparison).
  records = records.filter((r) => !r.comparison?.missing_ims);
  records = applyReportScopeFilter(records, body);
  records = enrichPlanDateHistory(records, planDateHistoryMap);
  records = await enrichFgStock(records);
  records = await enrichScheduleDispatchBalances(records);
  records = decorateScheduleDisplayRows(records);

  if (filterMode === SCHEDULE_LIST_FILTER.READY_TO_DISPATCH) {
    // Exclude fully dispatched rows (balance 0) — still is_planned 7 but display = Complete.
    records = records.filter((r) => !isScheduleCompleteRow(r));
  } else if (filterMode === SCHEDULE_LIST_FILTER.PLAN) {
    records = filterScheduleRowsByBalanceTab(records, { complete: false });
  } else if (filterMode === SCHEDULE_LIST_FILTER.COMPLETE) {
    records = filterScheduleRowsByBalanceTab(records, { complete: true });
  }

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

export async function saveSchedulePlan(body = {}, userName = null, opts = {}) {
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
  const fromStatus = effectiveFromStatus(existingRow);
  const isSuperAdmin = Boolean(opts?.isSuperAdmin);

  if (fromStatus === SCHEDULE_PLAN_STATUS.COMPLETE) {
    return {
      success: false,
      status: 400,
      message: "Completed items cannot be planned.",
    };
  }
  if (!(isSuperAdmin && canTransitionAsSuperAdmin(fromStatus)) && !canPlanFrom(fromStatus)) {
    return {
      success: false,
      status: 400,
      message: "Cannot Plan from current status.",
    };
  }

  /** ADD Plan → Planned (1), same as original. */
  const toStatus = SCHEDULE_PLAN_STATUS.PLANNED;

  const localRow = await upsertPlan({
    fin_year_id: fy.finYearId, schno, itemdcode, snap,
    user_name: userName,
    is_planned: toStatus,
  });

  if (!localRow) return { success: false, status: 500, message: "Could not save schedule plan." };

  await recordTransaction({
    fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
    action_type: SCHEDULE_PLAN_ACTION.PLAN, from_status: fromStatus, to_status: toStatus,
    action_date: actionDateNorm, action_reason: null, remark: item_remark ?? null,
    user_name: userName,
  });

  await syncIms(fy.finYearId, body, { actionDate: actionDateNorm, qty: totalQty });
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.PLAN,
    action_date: actionDateNorm,
    action_reason: null,
    remark: item_remark ?? null,
  });
  return {
    success: true,
    message: "Plan saved.",
    data: planToRow(localRow, body, lastTxn),
  };
}

export async function rejectSchedulePlan(body = {}, userName = null, opts = {}) {
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
  const fromStatus = effectiveFromStatus(existingRow);
  const rejectUpdate = fromStatus === SCHEDULE_PLAN_STATUS.REJECT;
  const isSuperAdmin = Boolean(opts?.isSuperAdmin);

  if (fromStatus === SCHEDULE_PLAN_STATUS.COMPLETE) {
    return {
      success: false,
      status: 400,
      message: "Completed items cannot be rejected.",
    };
  }

  if (
    !rejectUpdate &&
    !(isSuperAdmin && canTransitionAsSuperAdmin(fromStatus)) &&
    !canRejectFrom(fromStatus)
  ) {
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
        user_name: userName,
      });
    } else {
      const updated = await updatePlanStatus({
        fin_year_id: fy.finYearId, schno, itemdcode,
        is_planned: SCHEDULE_PLAN_STATUS.REJECT,
        user_name: userName,
      });
      if (!updated) return { success: false, status: 500, message: "Could not reject schedule." };
      const map = await loadAllPlanMap(fy.finYearId);
      localRow = map.get(planKey(schno, itemdcode));
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: updated.plan_id ?? existingRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.REJECT, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.REJECT,
        action_date: ad, action_reason: reason, remark: item_remark ?? null,
        user_name: userName,
      });
    }
  } else {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_name: userName,
      is_planned: SCHEDULE_PLAN_STATUS.REJECT,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.REJECT, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.REJECT,
        action_date: ad, action_reason: reason, remark: item_remark ?? null,
        user_name: userName,
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

export async function holdSchedulePlan(body = {}, userName = null, opts = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, item_remark, action_date } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const actionDateNorm = normDate(action_date);
  if (!actionDateNorm) {
    return { success: false, status: 400, message: "action_date is required for hold." };
  }

  const snap = pickSnap(body);
  const rangeErr = validateScheduleTargetDate(actionDateNorm, body.schmonth ?? snap.schmonth, body.schdt ?? snap.schdt);
  if (rangeErr) return { success: false, status: 400, message: rangeErr };

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  const fromStatus = effectiveFromStatus(existingRow);
  const holdUpdate = fromStatus === SCHEDULE_PLAN_STATUS.HOLD;
  const isSuperAdmin = Boolean(opts?.isSuperAdmin);
  if (
    !holdUpdate &&
    !(isSuperAdmin && canTransitionAsSuperAdmin(fromStatus)) &&
    !canHoldFrom(fromStatus)
  ) {
    return { success: false, status: 400, message: "Cannot hold from current status." };
  }

  const itemRemark = item_remark ?? null;

  let localRow;
  if (existingRow && holdUpdate) {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_name: userName,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: actionDateNorm, action_reason: null, remark: itemRemark,
        user_name: userName,
      });
    }
  } else if (existingRow) {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_name: userName,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: actionDateNorm, action_reason: null, remark: itemRemark,
        user_name: userName,
      });
    }
  } else {
    localRow = await upsertPlan({
      fin_year_id: fy.finYearId, schno, itemdcode, snap: pickSnap(body),
      user_name: userName,
      is_planned: SCHEDULE_PLAN_STATUS.HOLD,
    });
    if (localRow) {
      await recordTransaction({
        fin_year_id: fy.finYearId, schno, itemdcode, plan_id: localRow.plan_id,
        action_type: SCHEDULE_PLAN_ACTION.HOLD, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.HOLD,
        action_date: actionDateNorm, action_reason: null, remark: itemRemark,
        user_name: userName,
      });
    }
  }

  if (!localRow) return { success: false, status: 500, message: "Could not hold schedule." };
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.HOLD,
    action_date: actionDateNorm,
    action_reason: null,
    remark: itemRemark,
  });
  return {
    success: true,
    message: holdUpdate ? "Hold details updated." : "Schedule put on hold.",
    data: planToRow(localRow, body, lastTxn),
  };
}

/** APPROVE: Hold / Reject / Plan → Ready to Dispatch (IMS-only also treated as Ready). */
export async function readyToDispatchSchedulePlan(body = {}, userName = null, opts = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, item_remark } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  const fromStatus = effectiveFromStatus(existingRow);
  const alreadyReady =
    Boolean(existingRow) && fromStatus === SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH;
  const isSuperAdmin = Boolean(opts?.isSuperAdmin);
  if (
    !alreadyReady &&
    !(isSuperAdmin && canTransitionAsSuperAdmin(fromStatus)) &&
    !canReadyFrom(fromStatus)
  ) {
    return { success: false, status: 400, message: "Cannot mark Ready to Dispatch from current status." };
  }

  const snap = pickSnap(body);
  // Ready to Dispatch: remark only — no client target date; txn stamps today.
  const actionDateNorm = localTodayYmd();

  const localRow = await upsertPlan({
    fin_year_id: fy.finYearId,
    schno,
    itemdcode,
    snap,
    user_name: userName,
    is_planned: SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
  });
  if (!localRow) return { success: false, status: 500, message: "Could not mark Ready to Dispatch." };

  await recordTransaction({
    fin_year_id: fy.finYearId,
    schno,
    itemdcode,
    plan_id: localRow.plan_id,
    action_type: SCHEDULE_PLAN_ACTION.READY,
    from_status: fromStatus,
    to_status: SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    action_date: actionDateNorm,
    action_reason: null,
    remark: item_remark ?? null,
    user_name: userName,
  });

  // No IMS target-date sync for Ready (remark / authorize only).
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.READY,
    action_date: actionDateNorm,
    action_reason: null,
    remark: item_remark ?? null,
  });
  return {
    success: true,
    message: alreadyReady ? "Ready to Dispatch details updated." : "Marked Ready to Dispatch.",
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

export async function submitScheduleShortage(body = {}, userId = null, userName = null) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const schno = String(body?.schno ?? "").trim();
  const shortageQty = Number(body.shortage_qty);
  if (!schno || body?.itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }
  if (!Number.isFinite(shortageQty) || shortageQty < 0) {
    return { success: false, status: 400, message: "Enter a valid shortage quantity." };
  }

  const existingRow = await loadPlanRow(fy.finYearId, schno, body.itemdcode);
  const existingShortage = String(existingRow?.shortage_no ?? "").trim();
  if (existingShortage) {
    return {
      success: false,
      status: 400,
      message: `Shortage already recorded (No: ${existingShortage}).`,
      data: { shortage_no: existingShortage },
    };
  }

  const fromStatus = effectiveFromStatus(existingRow);
  const itemRemark = body.item_remark != null ? String(body.item_remark).trim() : "";
  const actionDateNorm = localTodayYmd();

  const filter = {
    fin_year_id: fy.finYearId,
    schno,
    itemdcode: body.itemdcode,
    item_code: body.item_code,
    itemdesc: body.itemdesc,
    schmonth: body.schmonth,
    schdt: normDate(body.schdt) ?? body.schdt,
    acc_code: body.acc_code,
    acc_name: body.acc_name,
    original_qty: Number(body.original_qty) || 0,
    shortage_qty: shortageQty,
    user_id: userId,
    user_name: userName,
  };

  console.log("[schedule-planning] shortage request", filter);
  // const ims = await fetchImsDataRaw("shortgoogle", filter);
  
  // TODO START: restore real IMS shortgoogle once API returns shortage_no reliably.
  const dummyShortageNo = `SH-${schno}-${body.itemdcode}-${Date.now().toString().slice(-6)}`;
  const ims = {
    success: true,
    id: dummyShortageNo,
    shortage_no: dummyShortageNo,
    records: [
      {
        id: dummyShortageNo,
        shortage_no: dummyShortageNo,
        schno,
        itemdcode: body.itemdcode,
        shortage_qty: shortageQty,
      },
    ],
    message: "Data processed and forwarded successfully.",
  };
  // TODO END: restore real IMS shortgoogle once API returns shortage_no reliably.
  
  console.log("[schedule-planning] shortage response (dummy)", JSON.stringify(ims, null, 2));

  const row = Array.isArray(ims?.records) ? ims.records[0] : ims?.records;
  const id = ims?.id ?? row?.id ?? ims?.shortage_no ?? row?.shortage_no ?? null;
  const msg = ims?.msg ?? ims?.message ?? row?.msg ?? row?.message ?? null;

  if (ims?.success !== true) {
    return {
      success: false,
      status: 400,
      message: toPublicImsMessage(msg || ims?.message, "Could not submit shortage."),
    };
  }

  const shortageNo = id != null && String(id).trim() !== "" ? String(id).trim() : null;
  if (!shortageNo) {
    return {
      success: false,
      status: 400,
      message: "IMS did not return a shortage id.",
    };
  }

  const snap = pickSnap(body);
  if (!existingRow) {
    const created = await upsertPlan({
      fin_year_id: fy.finYearId,
      schno,
      itemdcode: body.itemdcode,
      snap,
      user_name: userName,
      is_planned: SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    });
    if (!created) {
      return { success: false, status: 500, message: "Could not save schedule plan for shortage." };
    }
  }

  const localRow = await setPlanShortageNo({fin_year_id: fy.finYearId, schno, itemdcode: body.itemdcode, shortage_no: shortageNo, user_name: userName });
  if (!localRow) {
    return { success: false, status: 400, message: "Shortage already recorded for this item." };
  }

  await recordTransaction({
    fin_year_id: fy.finYearId,
    schno,
    itemdcode: body.itemdcode,
    plan_id: localRow.plan_id,
    action_type: SCHEDULE_PLAN_ACTION.SHORTAGE,
    from_status: fromStatus,
    to_status: fromStatus,
    action_date: actionDateNorm,
    action_reason: null,
    remark: itemRemark || null,
    user_name: userName,
  });

  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.SHORTAGE,
    action_date: actionDateNorm,
    action_reason: null,
    remark: itemRemark || null,
    created_by_name: userName,
  });

  return {
    success: true,
    message: msg || "Shortage submitted successfully.",
    data: {
      id: shortageNo,
      shortage_no: shortageNo,
      ...planToRow(localRow, body, lastTxn),
    },
  };
}

export async function removeSchedulePlan(body = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const schno = String(body?.schno ?? "").trim();
  if (!schno) {
    return { success: false, status: 400, message: "schno is required." };
  }

  const deleteScope = String(body?.delete_scope ?? "").trim().toLowerCase();
  const itemOnly = deleteScope === "item";
  const scheduleOnly = deleteScope === "schedule" || !deleteScope;

  let itemdcode = null;
  if (itemOnly) {
    const raw = body?.itemdcode ?? body?.item_dcode;
    if (raw == null || String(raw).trim() === "") {
      return { success: false, status: 400, message: "itemdcode is required for item delete." };
    }
    itemdcode = Number(raw);
    if (!Number.isFinite(itemdcode)) {
      return { success: false, status: 400, message: "Invalid itemdcode for item delete." };
    }
  } else if (scheduleOnly) {
    itemdcode = null;
  } else {
    return { success: false, status: 400, message: "delete_scope must be 'schedule' or 'item'." };
  }

  const scope = { fin_year_id: fy.finYearId, schno, ...(itemdcode != null ? { itemdcode } : {}) };

  const { planDeleted, txnDeleted } = await withTransaction(async (client) => {
    const txnDeleted = await deletePlanTransactions(scope, client);
    const planDeleted = await deletePlans(scope, client);
    return { planDeleted, txnDeleted };
  });

  if (!planDeleted) {
    return {
      success: false,
      status: 404,
      message: itemOnly ? "No schedule item found to delete." : "No schedule plan found to delete.",
    };
  }

  return {
    success: true,
    message: itemOnly
      ? "Schedule item deleted."
      : planDeleted === 1
        ? "Schedule deleted."
        : `Schedule deleted (${planDeleted} items).`,
    deleted_count: planDeleted,
    txn_deleted_count: txnDeleted,
  };
}

export async function completeSchedulePlan(body = {}, userName = null, opts = {}) {
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const { schno, itemdcode, item_remark } = body || {};
  if (schno == null || itemdcode == null) {
    return { success: false, status: 400, message: "schno and itemdcode are required." };
  }

  const existingRow = await loadPlanRow(fy.finYearId, schno, itemdcode);
  if (!existingRow) {
    return { success: false, status: 404, message: "Schedule plan not found." };
  }

  const fromStatus = Number(existingRow.is_planned ?? SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH);
  const isSuperAdmin = Boolean(opts?.isSuperAdmin);
  if (!(isSuperAdmin && canTransitionAsSuperAdmin(fromStatus)) && !canCompleteFrom(fromStatus)) {
    return { success: false, status: 400, message: "Cannot complete from current status." };
  }

  const updated = await updatePlanStatus({
    fin_year_id: fy.finYearId, schno, itemdcode,
    is_planned: SCHEDULE_PLAN_STATUS.COMPLETE,
    user_name: userName,
  });

  if (!updated) return { success: false, status: 500, message: "Could not mark as complete." };

  await recordTransaction({
    fin_year_id: fy.finYearId, schno, itemdcode, plan_id: updated.plan_id ?? existingRow.plan_id,
    action_type: SCHEDULE_PLAN_ACTION.COMPLETE, from_status: fromStatus, to_status: SCHEDULE_PLAN_STATUS.COMPLETE,
    action_date: localTodayYmd(), action_reason: null, remark: item_remark ?? null,
    user_name: userName,
  });

  const snap = pickSnap(body);
  const lastTxn = txnSnapshot({
    action_type: SCHEDULE_PLAN_ACTION.COMPLETE,
    action_date: localTodayYmd(),
    action_reason: null,
    remark: item_remark ?? null,
  });
  return {
    success: true,
    message: "Marked as complete.",
    data: planToRow({ ...existingRow, is_planned: SCHEDULE_PLAN_STATUS.COMPLETE }, snap, lastTxn),
  };
}

/**
 * Today Dispatch Plan filters (UI: Plan | Complete).
 * Same month, action_date month-start → today.
 * Plan → Planned (1) / Running (2) + balance > 0
 * Complete → Complete, or Planned/Running with balance 0
 */
function parseDispatchStatusFilter(rawStatus) {
  const mode = String(rawStatus ?? "plan").trim().toLowerCase();
  if (mode === "complete" || mode === "completed") {
    return {
      codes: [
        SCHEDULE_PLAN_STATUS.PLANNED,
        SCHEDULE_PLAN_STATUS.RUNNING,
        SCHEDULE_PLAN_STATUS.COMPLETE,
        SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
      ],
      showComplete: true,
      actionTypes: ["plan", "complete", "ready"],
    };
  }
  return {
    codes: [SCHEDULE_PLAN_STATUS.PLANNED, SCHEDULE_PLAN_STATUS.RUNNING],
    showComplete: false,
    actionTypes: ["plan"],
  };
}

function mapDispatchPlanRecord(row) {
  return {
    plan_id: row.plan_id,
    fin_year_id: row.fin_year_id,
    schno: row.schno,
    itemdcode: row.itemdcode,
    schmonth: row.schmonth,
    schdt: row.schdt,
    acc_code: row.acc_code,
    acc_name: row.acc_name,
    item_code: row.item_code,
    itemdesc: row.itemdesc,
    totalqty: row.totalqty,
    is_planned: row.is_planned,
    shortage_no: row.shortage_no ?? null,
    action_date: row.action_date ?? null,
    item_remark: row.item_remark ?? null,
    in_hand_qty: 0,
    fg_stock_qty: 0,
  };
}


/**
 * Forwarding Note item picker — current-month Ready/Plan for one customer.
 * Excludes Complete, Reject, Hold. Balance + FG from our DB.
 */
export async function listCustomerMonthSchedules(body = {}) {
  const accCode = Number(body?.acc_code);
  if (!Number.isFinite(accCode) || accCode <= 0) {
    return { success: false, status: 400, records: [], message: "acc_code is required." };
  }
  const fy = requireFinYear(body);
  if (fy.error) return fy.error;

  const month = Number(currentScheduleMonth());
  const excludeFuidRaw = Number(body?.exclude_fuid ?? body?.excludeFuid);
  const excludeFuid =
    Number.isFinite(excludeFuidRaw) && excludeFuidRaw > 0 ? excludeFuidRaw : null;

  try {
    const imsFilter = buildImsScheduleFilterSql({ month: currentScheduleMonth() }, fy.finYearId);
    const [imsResult, planMap, lastTxnMap] = await Promise.all([
      fetchImsDataRaw(IMS_SCHEDULE_LIST, imsFilter),
      loadAllPlanMap(fy.finYearId),
      loadLastTransactionMap(fy.finYearId),
    ]);

    const imsRows = (Array.isArray(imsResult?.records) ? imsResult.records : []).filter(
      (r) => Number(r.acc_code ?? r.Acc_code ?? r.accCode) === accCode
    );

    // Customer IMS month rows + DB merge (IMS-only → Ready; DB keeps Plan/Hold/Ready/…).
    let records = buildFilteredList(imsRows, SCHEDULE_LIST_FILTER.ALL, planMap, lastTxnMap);

    // Same-month Ready / Plan orphans (in DB, missing from IMS this month).
    const seen = new Set(records.map((r) => planKey(r.schno, r.itemdcode)));
    for (const plan of planMap.values()) {
      if (Number(plan.acc_code) !== accCode) continue;
      if (Number(plan.schmonth) !== month) continue;
      const st = Number(plan.is_planned);
      if (st !== SCHEDULE_PLAN_STATUS.PLANNED && st !== SCHEDULE_PLAN_STATUS.RUNNING) continue;
      const k = planKey(plan.schno, plan.itemdcode);
      if (seen.has(k)) continue;
      seen.add(k);
      records.push(planToRow(plan, {}, lastTxnMap.get(k) ?? null));
    }

    records = records.filter((r) => {
      if (Number(r.acc_code ?? r.Acc_code ?? 0) !== accCode) return false;
      const st = Number(r.is_planned ?? SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH);
      if (
        st === SCHEDULE_PLAN_STATUS.COMPLETE ||
        st === SCHEDULE_PLAN_STATUS.REJECT ||
        st === SCHEDULE_PLAN_STATUS.HOLD
      ) {
        return false;
      }
      const rowMonth = Number(r.schmonth);
      if (Number.isFinite(rowMonth) && rowMonth > 0 && rowMonth !== month) {
        // IMS-only Ready other-month lines still allowed.
        if (!r.plan_id && normalizeScheduleStatus(st) === SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH) return true;
        return false;
      }
      return true;
    });

    records.sort((a, b) => {
      const sa = String(a.schno ?? "");
      const sb = String(b.schno ?? "");
      if (sa !== sb) return sa.localeCompare(sb, undefined, { numeric: true });
      return String(a.item_code ?? "").localeCompare(String(b.item_code ?? ""), undefined, {
        sensitivity: "base",
      });
    });

    const enriched = await enrichFgStock(records);
    // Edit/approve: exclude this FN so balance includes qty already on the note.
    const withBalances = await enrichScheduleDispatchBalances(enriched, { excludeFuid });
    // Picker: skip fully dispatched / complete lines (Bal 0).
    const openBalance = withBalances.filter((r) => Number(r.balance_qty ?? 0) > 0);
    return { success: true, records: openBalance };
  } catch (err) {
    console.error("[schedule-planning] customer-month schedules error:", err?.message || err);
    // Fallback: DB-only same-month Plan/Hold if IMS fails.
    try {
      const rows = await loadCustomerMonthScheduleItems(accCode, [
        SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
        SCHEDULE_PLAN_STATUS.PLANNED,
        SCHEDULE_PLAN_STATUS.RUNNING,
      ]);
      const records = (rows || []).map(mapDispatchPlanRecord);
      const enriched = await enrichFgStock(records);
      const withBalances = await enrichScheduleDispatchBalances(enriched, { excludeFuid });
      const openBalance = withBalances.filter((r) => Number(r.balance_qty ?? 0) > 0);
      return { success: true, records: openBalance };
    } catch (fallbackErr) {
      console.error("[schedule-planning] customer-month DB fallback error:", fallbackErr?.message || fallbackErr);
      return { success: false, records: [], message: "Could not load customer schedules." };
    }
  }
}

/**
 * Today Dispatch Plan for Forwarding Note.
 * Same month · action_date month-start → today · no Hold.
 * Plan tab → balance_qty > 0 · Complete tab → balance_qty <= 0 or manual Complete.
 */
export async function listScheduleDispatchPlan(body = {}) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const toDate = `${year}-${month}-${day}`;
  const { codes, showComplete, actionTypes } = parseDispatchStatusFilter(body?.status);
  const finYearId = String(body?.fin_year_id ?? "").trim() || null;

  try {
    const rows = showComplete
      ? await loadDispatchCompleteTabItems(toDate, finYearId, codes)
      : await loadDispatchPlanItems(`${year}-${month}-01`, toDate, codes, { actionTypes });

    let records = await enrichFgStock((rows || []).map(mapDispatchPlanRecord));
    records = await enrichScheduleDispatchBalances(records);
    records = decorateScheduleDisplayRows(records);
    records = filterScheduleRowsByBalanceTab(records, { complete: showComplete });

    records.sort((a, b) => Number(b.balance_qty ?? 0) - Number(a.balance_qty ?? 0));

    return { success: true, records };
  } catch (err) {
    console.error("[schedule-planning] dispatch helper error:", err?.message || err);
    return { success: false, records: [], message: "Could not load dispatch plan data." };
  }
}
