import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";
import { planKey } from "./schedulePlanDb.js";

export async function insertScheduleTransaction(row) {
  const {
    fin_year_id, schno, itemdcode, plan_id, action_type, from_status, to_status,
    action_date, action_reason, remark, user_id,
  } = row;

  const [out] = await dbQuery(
    `INSERT INTO ${T.SCHEDULE_PLAN_TRANSACTION} (
       fin_year_id, schno, itemdcode, plan_id, action_type, from_status, to_status,
       action_date, action_reason, remark, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,NOW())
     RETURNING txn_id, created_at`,
    [
      String(fin_year_id), String(schno).trim(), Number(itemdcode),
      plan_id ?? null, String(action_type).trim().toLowerCase(),
      from_status != null ? Number(from_status) : null,
      Number(to_status),
      action_date ?? null, action_reason ?? null, remark ?? null,
      user_id ?? null,
    ]
  );
  return out ?? null;
}

export async function loadLastTransactionMap(finYearId) {
  const rows = await dbQuery(
    `SELECT DISTINCT ON (t.fin_year_id, t.schno, t.itemdcode)
       t.txn_id, t.fin_year_id, t.schno, t.itemdcode, t.plan_id, t.action_type,
       t.from_status, t.to_status, t.action_date::text AS action_date, t.action_reason,
       t.remark, t.created_at,
       u.name AS created_by_name
     FROM ${T.SCHEDULE_PLAN_TRANSACTION} t
     LEFT JOIN ${C.USERS} u ON u.id = t.created_by
     WHERE t.fin_year_id = $1
     ORDER BY t.fin_year_id, t.schno, t.itemdcode, t.created_at DESC, t.txn_id DESC`,
    [String(finYearId)]
  );
  const map = new Map();
  for (const row of rows || []) map.set(planKey(row.schno, row.itemdcode), row);
  return map;
}

export async function loadActionDates(finYearId) {
  const rows = await dbQuery(
    `SELECT DISTINCT action_date::text AS action_date
     FROM ${T.SCHEDULE_PLAN_TRANSACTION}
     WHERE fin_year_id = $1
       AND action_date IS NOT NULL
       AND LOWER(TRIM(action_type)) = 'plan'
     ORDER BY action_date DESC`,
    [String(finYearId)]
  );
  return (rows || []).map((r) => r.action_date).filter(Boolean);
}

export async function loadActionReasons(finYearId) {
  const baseSql = `
    SELECT reason FROM (
      SELECT TRIM(action_reason) AS reason, MAX(created_at) AS last_used
      FROM ${T.SCHEDULE_PLAN_TRANSACTION}
      WHERE action_reason IS NOT NULL
        AND TRIM(action_reason) <> ''
      __FY_FILTER__
      GROUP BY TRIM(action_reason)
    ) r
    ORDER BY last_used DESC, reason ASC`;

  const fy = finYearId != null ? String(finYearId).trim() : "";
  if (fy) {
    const rows = await dbQuery(
      baseSql.replace("__FY_FILTER__", "AND fin_year_id = $1"),
      [fy]
    );
    const reasons = (rows || []).map((r) => r.reason).filter(Boolean);
    if (reasons.length) return reasons;
  }

  const allRows = await dbQuery(baseSql.replace("__FY_FILTER__", ""), []);
  return (allRows || []).map((r) => r.reason).filter(Boolean);
}

export async function loadPlanDateHistoryMap(finYearId) {
  const rows = await dbQuery(
    `SELECT t.schno, t.itemdcode, t.action_date::text AS action_date
     FROM ${T.SCHEDULE_PLAN_TRANSACTION} t
     WHERE t.fin_year_id = $1
       AND LOWER(TRIM(t.action_type)) = 'plan'
       AND t.action_date IS NOT NULL
     ORDER BY t.schno, t.itemdcode, t.created_at ASC, t.txn_id ASC`,
    [String(finYearId)]
  );
  const map = new Map();
  for (const row of rows || []) {
    const k = planKey(row.schno, row.itemdcode);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row.action_date);
  }
  return map;
}

export async function loadItemTransactionHistory(finYearId, schno, itemdcode) {
  const rows = await dbQuery(
    `SELECT
       t.txn_id, t.action_type, t.from_status, t.to_status,
       t.action_date::text AS action_date, t.action_reason, t.remark,
       t.created_at, u.name AS created_by_name
     FROM ${T.SCHEDULE_PLAN_TRANSACTION} t
     LEFT JOIN ${C.USERS} u ON u.id = t.created_by
     WHERE t.fin_year_id = $1 AND t.schno = $2 AND t.itemdcode = $3
     ORDER BY t.created_at DESC, t.txn_id DESC`,
    [String(finYearId), String(schno).trim(), Number(itemdcode)]
  );
  return rows || [];
}

export async function deletePlanTransactions({ fin_year_id, schno, itemdcode }, client = null) {
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
      ? `DELETE FROM ${T.SCHEDULE_PLAN_TRANSACTION} WHERE fin_year_id = $1 AND schno = $2 AND itemdcode = $3 RETURNING txn_id`
      : `DELETE FROM ${T.SCHEDULE_PLAN_TRANSACTION} WHERE fin_year_id = $1 AND schno = $2 RETURNING txn_id`,
    byItem ? [fy, sch, Number(itemdcode)] : [fy, sch]
  );
  return Array.isArray(rows) ? rows.length : 0;
}
