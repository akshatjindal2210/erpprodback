/**
 * Monthly packing limit for Packing Entry (Daily Production) New Sticker / generate.
 *
 * Rule (business):
 * - Base = SUM(approved shortage for same item + month) — PPC + WIP + Additional + Deviation.
 *   Schedule plan is NOT used.
 * - Allowed = base + floor(base × shortage_qty_percentage/100).
 *   e.g. base 2000 + 10% ⇒ max 2200; % = 0 ⇒ max = base only.
 * - No shortage rows → base/allowed = 0 (must add shortage / Create Deviation first).
 * - Over allowed → Create Deviation first, then New Sticker.
 *
 * Used = already sticker-generated qty this month for the item (dailyprod + production boxes).
 */
import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { getShortageQtyPercentage } from "../../../../core/configuration/models/appConfig.model.js";
import { fetchFromIMS, fetchImsDataRaw } from "../../services/ims.service.js";
import { getItemSellableQty, resolveStickerRequestedQty } from "./itemSellableStock.js";
import { loadScheduleDispatchQtyMap, planKey } from "../../../modules/schedule-planning/utils/db/schedulePlanDb.js";

export { resolveStickerRequestedQty };

function pad2(n) {
  return String(n).padStart(2, "0");
}

function currentCalendarMonth() {
  return new Date().getMonth() + 1;
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Resolve YYYY-MM and schmonth (1–12) from optional doc_dt / year_month. */
export function resolveLimitMonth({ doc_dt = null, year_month = null } = {}) {
  const ymRaw = year_month != null ? String(year_month).trim().slice(0, 7) : "";
  if (/^\d{4}-\d{2}$/.test(ymRaw)) {
    return { yearMonth: ymRaw, schmonth: parseInt(ymRaw.slice(5, 7), 10) };
  }

  const dt = doc_dt != null ? String(doc_dt).trim() : "";
  if (/^\d{4}-\d{2}-\d{2}/.test(dt)) {
    return {
      yearMonth: dt.slice(0, 7),
      schmonth: parseInt(dt.slice(5, 7), 10),
    };
  }

  return {
    yearMonth: currentYearMonth(),
    schmonth: currentCalendarMonth(),
  };
}

/**
 * Qty already stickered this month for the item.
 * GREATEST(dailyprod total_qty, production box qty sum).
 */
export async function getItemMonthlyPackingUsed(
  itemdcode,
  { yearMonth = currentYearMonth(), excludeDocNo = null } = {}
) {
  const code = String(itemdcode ?? "").trim();
  if (!code || !yearMonth) return 0;

  const values = [code, yearMonth];
  let excludeSql = "";
  if (excludeDocNo != null && String(excludeDocNo).trim() !== "") {
    values.push(String(excludeDocNo).trim());
    excludeSql = `AND TRIM(dp.doc_no::text) IS DISTINCT FROM $${values.length}`;
  }

  const monthExpr = `to_char(
    COALESCE(dp.doc_dt, dp.system_generate_date::date, CURRENT_DATE),
    'YYYY-MM'
  )`;

  const [dpRows, boxRows] = await Promise.all([
    dbQuery(
      `SELECT COALESCE(SUM(COALESCE(dp.total_qty, 0)), 0)::float AS used_qty
       FROM ims_dailyprod dp
       WHERE dp.sticker_generated = true
         AND TRIM(dp.item_dcode::text) = TRIM($1::text)
         AND ${monthExpr} = $2
         ${excludeSql}`,
      values
    ),
    dbQuery(
      `SELECT COALESCE(SUM(COALESCE(b.qty, 0)), 0)::float AS used_qty
       FROM ims_box_table b
       INNER JOIN ims_dailyprod dp
         ON TRIM(b.packing_number::text) = TRIM(dp.doc_no::text)
       WHERE b.is_deleted = false
         AND b.sa_id IS NULL
         AND dp.sticker_generated = true
         AND TRIM(dp.item_dcode::text) = TRIM($1::text)
         AND ${monthExpr} = $2
         ${excludeSql}`,
      values
    ),
  ]);

  const fromDp = Number(dpRows?.[0]?.used_qty) || 0;
  const fromBoxes = Number(boxRows?.[0]?.used_qty) || 0;
  return Math.max(fromDp, fromBoxes);
}

/**
 * Batch packing-used for many items × months.
 * Returns Map<itemdcode string, totalUsed> where totalUsed = sum over months of
 * GREATEST(dailyprod, boxes) for that item+month.
 */
export async function getItemsMonthlyPackingUsedBatch(itemdcodes = [], yearMonths = [], { byMonth = false } = {}) {
  const codes = [
    ...new Set(
      (itemdcodes || [])
        .map((c) => String(c ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const months = [
    ...new Set(
      (yearMonths || [])
        .map((m) => String(m ?? "").trim().slice(0, 7))
        .filter((m) => /^\d{4}-\d{2}$/.test(m))
    ),
  ];
  const out = byMonth ? new Map() : new Map(codes.map((c) => [c, 0]));
  if (!codes.length || !months.length) return out;

  const monthExpr = `to_char(
    COALESCE(dp.doc_dt, dp.system_generate_date::date, CURRENT_DATE),
    'YYYY-MM'
  )`;

  const [dpRows, boxRows] = await Promise.all([
    dbQuery(
      `SELECT TRIM(dp.item_dcode::text) AS itemdcode,
              ${monthExpr} AS ym,
              COALESCE(SUM(COALESCE(dp.total_qty, 0)), 0)::float AS used_qty
       FROM ims_dailyprod dp
       WHERE dp.sticker_generated = true
         AND TRIM(dp.item_dcode::text) = ANY($1::text[])
         AND ${monthExpr} = ANY($2::text[])
       GROUP BY 1, 2`,
      [codes, months]
    ),
    dbQuery(
      `SELECT TRIM(dp.item_dcode::text) AS itemdcode,
              ${monthExpr} AS ym,
              COALESCE(SUM(COALESCE(b.qty, 0)), 0)::float AS used_qty
       FROM ims_box_table b
       INNER JOIN ims_dailyprod dp
         ON TRIM(b.packing_number::text) = TRIM(dp.doc_no::text)
       WHERE b.is_deleted = false
         AND b.sa_id IS NULL
         AND dp.sticker_generated = true
         AND TRIM(dp.item_dcode::text) = ANY($1::text[])
         AND ${monthExpr} = ANY($2::text[])
       GROUP BY 1, 2`,
      [codes, months]
    ),
  ]);

  const perKey = new Map();
  for (const row of dpRows || []) {
    const key = `${String(row.itemdcode).trim()}|${String(row.ym).trim()}`;
    const prev = perKey.get(key) || { dp: 0, box: 0 };
    prev.dp = Number(row.used_qty) || 0;
    perKey.set(key, prev);
  }
  for (const row of boxRows || []) {
    const key = `${String(row.itemdcode).trim()}|${String(row.ym).trim()}`;
    const prev = perKey.get(key) || { dp: 0, box: 0 };
    prev.box = Number(row.used_qty) || 0;
    perKey.set(key, prev);
  }

  for (const [key, vals] of perKey.entries()) {
    const used = Math.max(vals.dp, vals.box);
    if (byMonth) out.set(key, used);
    else {
      const itemdcode = key.split("|")[0];
      if (out.has(itemdcode)) out.set(itemdcode, (out.get(itemdcode) || 0) + used);
    }
  }
  return out;
}

/**
 * All approved shortage qty for item/month (PPC + WIP + Additional + Deviation).
 * This is the monthly packing budget for Packing Entry stickers.
 */
export async function getApprovedShortageQty(itemdcode, yearMonth = currentYearMonth()) {
  const code = parseInt(String(itemdcode), 10);
  const ym = String(yearMonth || "").slice(0, 7);
  if (!Number.isFinite(code) || !/^\d{4}-\d{2}$/.test(ym)) {
    return { total: 0, hasRows: false, deviation: 0 };
  }

  const [row] = await dbQuery(
    `SELECT
       COUNT(*)::int AS row_count,
       COALESCE(SUM(COALESCE(qty, 0)), 0)::float AS shortage_qty,
       COALESCE(SUM(CASE WHEN type = 'Deviation' THEN COALESCE(qty, 0) ELSE 0 END), 0)::float AS deviation_qty
     FROM ${T.SHORTAGE}
     WHERE is_deleted = false
       AND approved = true
       AND itemdcode = $1
       AND to_char(month, 'YYYY-MM') = $2`,
    [code, ym]
  );

  const rowCount = Number(row?.row_count) || 0;
  return {
    total: Number(row?.shortage_qty) || 0,
    deviation: Number(row?.deviation_qty) || 0,
    hasRows: rowCount > 0,
  };
}

function reorderFromItem(row) {
  if (!row || typeof row !== "object") return 0;
  for (const [key, value] of Object.entries(row)) {
    if (String(key).replace(/[^a-z]/gi, "").toLowerCase() !== "reorderqty") continue;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function getItemReorderQty(itemdcode) {
  const code = String(itemdcode ?? "").trim();
  if (!code) return 0;
  const records = await fetchFromIMS("item");
  const row = (records || []).find((r) => String(r.ItemDcode ?? r.itemdcode ?? r.Itemdcode ?? "").trim() === code);
  return reorderFromItem(row);
}

/** Display-only: item + month ka schedule total (pehle DB, warna IMS — Schedule Planning jaisa). */
async function sumItemScheduleQty(itemdcode, schmonth) {
  const code = Number(itemdcode);
  const month = Number(schmonth);
  if (!Number.isFinite(code) || month < 1 || month > 12) return 0;

  const [local] = await dbQuery(
    `SELECT COALESCE(SUM(totalqty), 0)::float AS qty
     FROM ${T.SCHEDULE_PLAN}
     WHERE itemdcode = $1 AND schmonth = $2 AND is_planned NOT IN (4, 5)`,
    [code, month]
  );
  const fromDb = Number(local?.qty) || 0;
  if (fromDb > 0) return fromDb;

  const rows = (await fetchImsDataRaw("schdule", null))?.records || [];
  return rows.reduce((sum, row) => Number(row?.itemdcode ?? row?.item_dcode) === code && Number(row?.schmonth) === month ? sum + (Number(row?.totalqty ?? row?.total_qty) || 0) : sum, 0);
}

function imsScheduleRows(records, itemdcode, schmonth) {
  const code = Number(itemdcode);
  const month = Number(schmonth);
  return (records || []).flatMap((row) => {
    const item = Number(row?.itemdcode ?? row?.item_dcode ?? row?.ItemDcode);
    const m = Number(row?.schmonth ?? row?.Schmonth ?? row?.sch_month);
    if (item !== code || m !== month) return [];
    return [{
      schno: String(row?.schno ?? row?.Schno ?? "").trim(),
      itemdcode: item,
      totalqty: Number(row?.totalqty ?? row?.total_qty ?? row?.Totalqty) || 0,
    }];
  });
}

/** Schedule Item Wise Default list: all IMS schedules for the item and month, not only local plan rows. */
async function loadItemMonthSchedulePair(itemdcode, schmonth) {
  const code = Number(itemdcode);
  const month = Number(schmonth);
  if (!Number.isFinite(code) || month < 1 || month > 12) return { scheduleQty: 0, balanceQty: 0 };

  const [imsRaw, localRows] = await Promise.all([
    fetchImsDataRaw("schdule", null),
    dbQuery(
      `SELECT TRIM(schno) AS schno, itemdcode, COALESCE(totalqty, 0)::float AS totalqty
       FROM ${T.SCHEDULE_PLAN}
       WHERE itemdcode = $1 AND schmonth = $2 AND is_planned NOT IN (4, 5)`,
      [code, month]
    ),
  ]);
  const localBySchno = new Map((localRows || []).map((row) => [String(row.schno ?? "").trim(), row]));
  let plans = imsScheduleRows(imsRaw?.records, code, month).map((row) => {
    const local = localBySchno.get(row.schno);
    return local ? { ...row, totalqty: Number(local.totalqty) || row.totalqty } : row;
  });
  if (!plans.length) plans = localRows || [];
  if (!plans.length) return { scheduleQty: 0, balanceQty: 0 };

  const dispatchMap = await loadScheduleDispatchQtyMap();
  let scheduleQty = 0;
  let balanceQty = 0;
  for (const plan of plans) {
    const qty = Number(plan.totalqty) || 0;
    const dispatched = Number(dispatchMap.get(planKey(plan.schno, plan.itemdcode ?? code)) ?? 0);
    scheduleQty += qty;
    balanceQty += Math.max(0, qty - dispatched);
  }
  return { scheduleQty, balanceQty };
}

/**
 * Evaluate monthly packing limit (Packing Entry / Daily Production only).
 * Base = approved shortage sum only; then + config tolerance %.
 */
export async function evaluateMonthlyPackingLimit({itemdcode, total_qty, packing_config, doc_no, doc_dt = null, year_month = null, withReorder = false}) {
  const requestedQty = resolveStickerRequestedQty({ total_qty, packing_config });
  const { yearMonth, schmonth: month } = resolveLimitMonth({ doc_dt, year_month });

  const [monthUsedQty, shortagePackedQty, shortage, pct, fgStockQty] = await Promise.all([
    getItemMonthlyPackingUsed(itemdcode, { yearMonth, excludeDocNo: doc_no }),
    withReorder ? getItemMonthlyPackingUsed(itemdcode, { yearMonth }) : 0,
    getApprovedShortageQty(itemdcode, yearMonth),
    getShortageQtyPercentage(),
    getItemSellableQty(itemdcode),
  ]);
  const [schedulePair, reorderQty] = await Promise.all([
    withReorder ? loadItemMonthSchedulePair(itemdcode, month) : null,
    withReorder ? getItemReorderQty(itemdcode) : 0,
  ]);
  const scheduleQty = schedulePair?.scheduleQty ?? 0;
  const scheduleBalanceQty = schedulePair?.balanceQty ?? 0;

  const baseQty = shortage.total;
  const toleranceQty = Math.floor(baseQty * (pct / 100));
  const allowedLimit = baseQty + toleranceQty;
  const projectedTotal = monthUsedQty + requestedQty;
  const excessQty = Math.max(0, projectedTotal - allowedLimit);

  return {
    ok: projectedTotal <= allowedLimit,
    skipped: false,
    reason: shortage.hasRows ? "shortage_cap" : "no_shortage",
    requested_qty: requestedQty,
    month_used_qty: monthUsedQty,
    projected_total: projectedTotal,
    monthly_requirement: 0,
    schedule_qty: scheduleQty,
    schedule_balance_qty: scheduleBalanceQty,
    shortage_balance_qty: baseQty - (withReorder ? shortagePackedQty : monthUsedQty),
    reorder_qty: reorderQty,
    fg_stock_qty: fgStockQty,
    in_hand_qty: fgStockQty,
    base_qty: baseQty,
    base_allowed_limit: baseQty,
    tolerance_qty: toleranceQty,
    shortage_buffer_qty: shortage.total,
    shortage_deviation_qty: shortage.deviation,
    has_shortage_rows: shortage.hasRows,
    allowed_limit: allowedLimit,
    shortage_qty_percentage: pct,
    excess_qty: excessQty,
    schmonth: month,
    year_month: yearMonth,
  };
}

/** Pending packing rows — true when Create Deviation is required before New Sticker. */
export async function rowNeedsPackingDeviation(row = {}) {
  if (row?.sticker_generated === true || row?.sticker_generated === "true") return false;
  const itemdcode = row.item_dcode ?? row.itemdcode;
  if (itemdcode == null || String(itemdcode).trim() === "") return false;

  const check = await evaluateMonthlyPackingLimit({
    itemdcode,
    total_qty: row.total_qty,
    doc_no: row.doc_no != null ? String(row.doc_no).trim() : null,
    doc_dt: row.doc_dt,
  });
  return !check.ok && !check.skipped;
}

/** Attach `needs_deviation` for packing-entry pending list (red row hint in UI). */
export async function attachNeedsDeviationFlag(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      needs_deviation: await rowNeedsPackingDeviation(row),
    })),
  );
}
