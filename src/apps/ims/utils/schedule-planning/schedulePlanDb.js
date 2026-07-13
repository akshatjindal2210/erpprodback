import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { SCHEDULE_PLAN_STATUS } from "./schedulePlanStatus.js";

export const planKey = (schno, itemdcode) => `${String(schno ?? "").trim()}|${String(itemdcode ?? "").trim()}`;

const PLAN_COLS = `
  p.plan_id, p.fin_year_id, p.schno, p.itemdcode, p.schmonth, p.schdt::text AS schdt,
  p.acc_code, p.acc_name, p.item_code, p.itemdesc, p.totalqty,
  p.is_planned, p.created_at, p.updated_at,
  p.created_by AS created_by_name, p.updated_by AS updated_by_name`;

const sel = (a) => PLAN_COLS.replace(/\bp\./g, `${a}.`);

function normalizeDispatchStatuses(rawStatuses = []) {
  const input = Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses];
  const allowed = new Set([
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.HOLD,
    SCHEDULE_PLAN_STATUS.COMPLETE,
  ]);
  const seen = new Set();
  const out = [];
  for (const status of input) {
    const n = Number(status);
    if (!Number.isFinite(n) || !allowed.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0
    ? out
    : [SCHEDULE_PLAN_STATUS.PLANNED, SCHEDULE_PLAN_STATUS.HOLD];
}

export async function loadAllPlanMap(finYearId) {
  const rows = await dbQuery(
    `SELECT ${sel("sp")} FROM ${T.SCHEDULE_PLAN} sp
     WHERE sp.fin_year_id = $1`,
    [String(finYearId)]
  );
  const map = new Map();
  for (const row of rows || []) map.set(planKey(row.schno, row.itemdcode), row);
  return map;
}

export async function loadPlanRow(finYearId, schno, itemdcode) {
  const [row] = await dbQuery(
    `SELECT plan_id, is_planned
     FROM ${T.SCHEDULE_PLAN}
     WHERE fin_year_id = $1 AND schno = $2 AND itemdcode = $3 LIMIT 1`,
    [String(finYearId), String(schno).trim(), Number(itemdcode)]
  );
  return row ?? null;
}

export async function upsertPlan(row) {
  const {
    fin_year_id, schno, itemdcode, snap, user_name, is_planned,
  } = row;

  const status = Number(is_planned ?? SCHEDULE_PLAN_STATUS.PLANNED);

  const [out] = await dbQuery(
    `WITH u AS (
       INSERT INTO ${T.SCHEDULE_PLAN} (
         fin_year_id, schno, itemdcode, schmonth, schdt, acc_code, acc_name, item_code, itemdesc, totalqty,
         is_planned, created_by, created_at, updated_by, updated_at
       ) VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,NOW(),$12,NOW())
       ON CONFLICT (fin_year_id, schno, itemdcode) DO UPDATE SET
         schmonth = COALESCE(EXCLUDED.schmonth, ${T.SCHEDULE_PLAN}.schmonth),
         schdt = COALESCE(EXCLUDED.schdt, ${T.SCHEDULE_PLAN}.schdt),
         acc_code = COALESCE(EXCLUDED.acc_code, ${T.SCHEDULE_PLAN}.acc_code),
         acc_name = COALESCE(EXCLUDED.acc_name, ${T.SCHEDULE_PLAN}.acc_name),
         item_code = COALESCE(EXCLUDED.item_code, ${T.SCHEDULE_PLAN}.item_code),
         itemdesc = COALESCE(EXCLUDED.itemdesc, ${T.SCHEDULE_PLAN}.itemdesc),
         totalqty = COALESCE(EXCLUDED.totalqty, ${T.SCHEDULE_PLAN}.totalqty),
         is_planned = EXCLUDED.is_planned,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *
     )
     SELECT ${sel("u")} FROM u`,
    [
      String(fin_year_id), String(schno).trim(), Number(itemdcode),
      snap.schmonth, snap.schdt, snap.acc_code, snap.acc_name, snap.item_code, snap.itemdesc, snap.totalqty,
      status, user_name ?? null,
    ]
  );
  return out ?? null;
}

export async function updatePlanStatus({ fin_year_id, schno, itemdcode, is_planned, user_name }) {
  const rows = await dbQuery(
    `UPDATE ${T.SCHEDULE_PLAN} SET
       is_planned = $4,
       updated_by = $5,
       updated_at = NOW()
     WHERE fin_year_id = $1 AND schno = $2 AND itemdcode = $3
     RETURNING plan_id`,
    [
      String(fin_year_id), String(schno).trim(), Number(itemdcode),
      Number(is_planned), user_name ?? null,
    ]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Dispatch-plan helper — no fin_year_id required.
 * Returns plan/hold items whose latest transaction action_date falls in [fromDate, toDate].
 * Used by the Forwarding Note "Today Dispatch Plan" tab.
 */
export async function loadDispatchPlanItems(fromDate, toDate, statuses = []) {
  const dispatchStatuses = normalizeDispatchStatuses(statuses);
  const rows = await dbQuery(
    `SELECT
       sp.plan_id, sp.fin_year_id, sp.schno, sp.itemdcode, sp.schmonth, sp.schdt::text AS schdt,
       sp.acc_code, sp.acc_name, sp.item_code, sp.itemdesc, sp.totalqty,
      sp.is_planned,
      lt.action_date::text AS action_date,
      lt.remark AS item_remark
     FROM ${T.SCHEDULE_PLAN} sp
     LEFT JOIN LATERAL (
      SELECT action_date, remark
       FROM ${T.SCHEDULE_PLAN_TRANSACTION}
       WHERE fin_year_id = sp.fin_year_id
         AND schno       = sp.schno
         AND itemdcode   = sp.itemdcode
         AND LOWER(TRIM(action_type)) IN ('plan', 'hold')
       ORDER BY created_at DESC, txn_id DESC
       LIMIT 1
     ) lt ON true
      WHERE sp.schmonth = EXTRACT(MONTH FROM $2::date)::int
      AND lt.action_date BETWEEN $1::date AND $2::date
       AND sp.is_planned = ANY($3::int[])
     ORDER BY lt.action_date ASC, sp.schno, sp.item_code`,
    [fromDate, toDate, dispatchStatuses]
  );
  return rows || [];
}

/** Sum of forwarding-note item qty per schedule + item (partial dispatch tracking). */
export async function loadScheduleDispatchQtyMap({ excludeFuid = null } = {}) {
  // Prefer item-wise schno (multi-schedule FN); fall back to master schno for older rows.
  const excludeId = Number(excludeFuid);
  const hasExclude = Number.isFinite(excludeId) && excludeId > 0;
  const rows = await dbQuery(
    `SELECT TRIM(COALESCE(NULLIF(TRIM(fi.schno::text), ''), NULLIF(TRIM(f.schno::text), ''))) AS schno,
            fi.item_dcode::int AS itemdcode,
            COALESCE(SUM(fi.total_qty), 0)::float AS dispatch_qty
     FROM ${T.FORWARDING_NOTE_MASTER} f
     INNER JOIN ${T.FORWARDING_NOTE_ITEM_WISE} fi
       ON fi.fuid = f.fuid AND fi.is_deleted = false
     WHERE f.is_deleted = false
       AND COALESCE(NULLIF(TRIM(fi.schno::text), ''), NULLIF(TRIM(f.schno::text), '')) IS NOT NULL
       ${hasExclude ? "AND f.fuid <> $1::int" : ""}
     GROUP BY 1, fi.item_dcode::int`,
    hasExclude ? [excludeId] : []
  );
  const map = new Map();
  for (const row of rows || []) {
    const key = planKey(row.schno, row.itemdcode);
    map.set(key, Number(row.dispatch_qty) || 0);
  }
  return map;
}

/**
 * Current-month schedule plan lines for one customer (Plan/Hold), for FN create picker.
 * Not limited to today's action_date — full schmonth for the customer.
 */
export async function loadCustomerMonthScheduleItems(accCode, statuses = []) {
  const code = Number(accCode);
  if (!Number.isFinite(code) || code <= 0) return [];
  const dispatchStatuses = normalizeDispatchStatuses(statuses);
  const rows = await dbQuery(
    `SELECT
       sp.plan_id, sp.fin_year_id, sp.schno, sp.itemdcode, sp.schmonth, sp.schdt::text AS schdt,
       sp.acc_code, sp.acc_name, sp.item_code, sp.itemdesc, sp.totalqty,
       sp.is_planned,
       lt.action_date::text AS action_date,
       lt.remark AS item_remark
     FROM ${T.SCHEDULE_PLAN} sp
     LEFT JOIN LATERAL (
       SELECT action_date, remark
       FROM ${T.SCHEDULE_PLAN_TRANSACTION}
       WHERE fin_year_id = sp.fin_year_id
         AND schno       = sp.schno
         AND itemdcode   = sp.itemdcode
         AND LOWER(TRIM(action_type)) IN ('plan', 'hold')
       ORDER BY created_at DESC, txn_id DESC
       LIMIT 1
     ) lt ON true
     WHERE sp.acc_code = $1::integer
       AND sp.schmonth = EXTRACT(MONTH FROM CURRENT_DATE)::int
       AND sp.is_planned = ANY($2::int[])
     ORDER BY sp.schno, sp.item_code`,
    [code, dispatchStatuses]
  );
  return rows || [];
}

export async function deletePlans({ fin_year_id, schno, itemdcode }, client = null) {
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows ?? [];
      }
    : (sql, params) => dbQuery(sql, params);

  const fy = String(fin_year_id);
  const sch = String(schno ?? "").trim();
  if (!sch) return 0;

  const byItem = itemdcode != null && String(itemdcode).trim() !== "";
  const rows = await run(
    byItem
      ? `DELETE FROM ${T.SCHEDULE_PLAN} WHERE fin_year_id = $1 AND schno = $2 AND itemdcode = $3 RETURNING plan_id`
      : `DELETE FROM ${T.SCHEDULE_PLAN} WHERE fin_year_id = $1 AND schno = $2 RETURNING plan_id`,
    byItem ? [fy, sch, Number(itemdcode)] : [fy, sch]
  );
  return Array.isArray(rows) ? rows.length : 0;
}
