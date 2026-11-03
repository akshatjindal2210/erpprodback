/**
 * prod_plan_manpower — operator on machine + date + shift.
 * No hours column: calendar uses shift hours; cron writes prod_entry at shift end.
 */
import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as E, MST_TABLES, PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { netShiftHours, isShiftActiveOnDate, normalizeActiveDays } from "../../../../core/lib/utils/shift/shiftHours.util.js";

const TABLE = T.PLAN_MANPOWER;

export { isShiftActiveOnDate };

/** Active shifts from settings (for calendar / board). */
export async function listActiveShiftCodes() {
  const rows = await dbQuery(
    `SELECT code, start_time, end_time, lunch, setting_allow, active_days
     FROM ${MST_TABLES.SHIFTS}
     WHERE is_active = true
     ORDER BY start_time ASC, code ASC`
  );

  return (rows || []).map((row, index) => {
    const hoursInfo = netShiftHours(row.start_time, row.end_time, row.lunch);
    const shift = {
      id: index + 1,
      code: String(row.code || "").trim() || `S${index + 1}`,
      hours: hoursInfo.hours,
      start_time: String(row.start_time || "").slice(0, 8),
      end_time: String(row.end_time || "").slice(0, 8),
      setting_allow: !!row.setting_allow,
      active_days: normalizeActiveDays(row.active_days),
    };
    if (hoursInfo.overnight) shift.overnight = true;
    return shift;
  });
}

export async function getShiftsPerDay() {
  const [row] = await dbQuery(
    `SELECT COUNT(*)::int AS count FROM ${MST_TABLES.SHIFTS} WHERE is_active = true`
  );
  return Math.max(1, Number(row?.count) || 1);
}

/** DB row → short API shape: m=mac, d=date, s=shift, i=id, e=emp, n=name */
function toApiRow(row) {
  const out = {
    m: Number(row.maccode),
    d: String(row.plan_date || "").slice(0, 10),
    s: Number(row.shift_no),
    i: Number(row.id),
    e: String(row.emp_code || "").trim(),
  };
  const name = String(row.emp_name || "").trim();
  if (name) out.n = name;
  return out;
}

/** Machine cavity / cycle — used by prod_entry also. */
export async function ratesByMac(maccodes) {
  const map = new Map();
  if (!maccodes?.length) return map;

  const rows = await dbQuery(
    `SELECT maccode, cavity, maccycletime, setup_time
     FROM ${E.MACHINE_MASTER}
     WHERE is_deleted = false AND maccode = ANY($1::int[])`,
    [maccodes]
  );
  for (const row of rows || []) map.set(Number(row.maccode), row);
  return map;
}

/** One cell: machine + date + shift. */
export async function getShiftOp(maccode, planDate, shiftNo) {
  const rows = await dbQuery(
    `SELECT id, maccode, plan_date, shift_no, emp_code, emp_name
     FROM ${TABLE}
     WHERE maccode = $1 AND plan_date = $2::date AND shift_no = $3
     ORDER BY id`,
    [Number(maccode), String(planDate).slice(0, 10), Number(shiftNo)]
  );
  if (!rows?.length) return null;
  return { segments: rows.map(toApiRow) };
}

/** List operators in a date range (optional machine filter). */
export async function listShiftOps({ from_date, to_date, maccode } = {}) {
  const params = [];
  const where = [];

  if (from_date) {
    params.push(String(from_date).slice(0, 10));
    where.push(`plan_date >= $${params.length}::date`);
  }
  if (to_date) {
    params.push(String(to_date).slice(0, 10));
    where.push(`plan_date <= $${params.length}::date`);
  }
  if (Number(maccode) > 0) {
    params.push(Number(maccode));
    where.push(`maccode = $${params.length}`);
  }

  const rows = await dbQuery(
    `SELECT id, maccode, plan_date, shift_no, emp_code, emp_name
     FROM ${TABLE}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY plan_date, shift_no, id`,
    params
  );
  return (rows || []).map(toApiRow);
}

/** Insert one operator on a cell. */
export async function appendShiftOpSegment({ maccode, plan_date, shift_no, emp_code, emp_name, created_by } = {}) {
  const user = String(created_by || "").trim() || "System";
  const now = new Date();

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE}
       (maccode, plan_date, shift_no, emp_code, emp_name, created_by, created_at, updated_by, updated_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $6, $7)
     RETURNING id, maccode, plan_date, shift_no, emp_code, emp_name`,
    [
      Number(maccode),
      String(plan_date).slice(0, 10),
      Number(shift_no),
      String(emp_code || "").trim(),
      emp_name ? String(emp_name).trim() : null,
      user,
      now,
    ]
  );
  return row ? toApiRow(row) : null;
}

/** Delete by row id, or whole cell if id missing. */
export async function deleteShiftOpSegments({ maccode, plan_date, shift_no, id } = {}) {
  const rowId = Number(id);
  let rows;

  if (rowId >= 1) {
    rows = await dbQuery(
      `DELETE FROM ${TABLE} WHERE id = $1
       RETURNING id, maccode, plan_date, shift_no, emp_code, emp_name`,
      [rowId]
    );
  } else {
    rows = await dbQuery(
      `DELETE FROM ${TABLE}
       WHERE maccode = $1 AND plan_date = $2::date AND shift_no = $3
       RETURNING id, maccode, plan_date, shift_no, emp_code, emp_name`,
      [Number(maccode), String(plan_date).slice(0, 10), Number(shift_no)]
    );
  }

  return (rows || []).map(toApiRow);
}

/** Change operator on one row. */
export async function updateShiftOpSegment({ id, emp_code, emp_name, updated_by } = {}) {
  const rowId = Number(id);
  if (!(rowId >= 1)) return null;

  const [row] = await dbQuery(
    `UPDATE ${TABLE}
     SET emp_code = COALESCE($2, emp_code),
         emp_name = COALESCE($3, emp_name),
         updated_by = $4,
         updated_at = $5
     WHERE id = $1
     RETURNING id, maccode, plan_date, shift_no, emp_code, emp_name`,
    [
      rowId,
      emp_code != null ? String(emp_code).trim() : null,
      emp_name != null ? String(emp_name).trim() : null,
      String(updated_by || "").trim() || "System",
      new Date(),
    ]
  );
  return row ? toApiRow(row) : null;
}
