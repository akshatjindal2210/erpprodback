import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";
import { SCHEDULE_PLAN_STATUS } from "./schedulePlanStatus.js";

export const planKey = (schno, itemdcode) => `${String(schno ?? "").trim()}|${String(itemdcode ?? "").trim()}`;

const PLAN_COLS = `
  p.plan_id, p.fin_year_id, p.schno, p.itemdcode, p.schmonth, p.schdt::text AS schdt,
  p.acc_code, p.acc_name, p.item_code, p.itemdesc, p.totalqty,
  p.is_planned, p.created_at, p.updated_at,
  u_cr.name AS created_by_name, u_up.name AS updated_by_name`;

const sel = (a) => PLAN_COLS.replace(/\bp\./g, `${a}.`);

export async function loadAllPlanMap(finYearId) {
  const rows = await dbQuery(
    `SELECT ${sel("sp")} FROM ${T.SCHEDULE_PLAN} sp
     LEFT JOIN ${C.USERS} u_cr ON u_cr.id = sp.created_by
     LEFT JOIN ${C.USERS} u_up ON u_up.id = sp.updated_by
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
    fin_year_id, schno, itemdcode, snap, user_id, is_planned,
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
     SELECT ${sel("u")} FROM u
     LEFT JOIN ${C.USERS} u_cr ON u_cr.id = u.created_by
     LEFT JOIN ${C.USERS} u_up ON u_up.id = u.updated_by`,
    [
      String(fin_year_id), String(schno).trim(), Number(itemdcode),
      snap.schmonth, snap.schdt, snap.acc_code, snap.acc_name, snap.item_code, snap.itemdesc, snap.totalqty,
      status, user_id ?? null,
    ]
  );
  return out ?? null;
}

export async function updatePlanStatus({ fin_year_id, schno, itemdcode, is_planned, user_id }) {
  const rows = await dbQuery(
    `UPDATE ${T.SCHEDULE_PLAN} SET
       is_planned = $4,
       updated_by = $5,
       updated_at = NOW()
     WHERE fin_year_id = $1 AND schno = $2 AND itemdcode = $3
     RETURNING plan_id`,
    [
      String(fin_year_id), String(schno).trim(), Number(itemdcode),
      Number(is_planned), user_id ?? null,
    ]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
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
