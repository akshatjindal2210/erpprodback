import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as E, MST_TABLES, PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { qtyFromSlotHours } from "../../jc/jobCardProductionTime.js";
import { netShiftHours } from "../../../../core/lib/utils/shift/shiftHours.util.js";

const PM = T.PLAN_MANPOWER;

/** Calendar shifts — only fields UI uses. */
export async function listActiveShiftCodes() {
  const rows = await dbQuery(
    `SELECT code, start_time, end_time, lunch
     FROM ${MST_TABLES.SHIFTS}
     WHERE is_active = true
     ORDER BY start_time ASC, code ASC`
  );
  return (rows || []).map((r, i) => {
    const code = String(r.code || "").trim() || `S${i + 1}`;
    const meta = netShiftHours(r.start_time, r.end_time, r.lunch);
    const out = { id: i + 1, code, hours: meta.hours };
    if (meta.overnight) out.overnight = true;
    return out;
  });
}

export async function getShiftsPerDay() {
  const [row] = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${MST_TABLES.SHIFTS} WHERE is_active = true`);
  return Math.max(1, Number(row?.count) || 1);
}

const SEL = `id, maccode, plan_date, shift_no, emp_code, emp_name, hours`;

/** Compact row: m d s i e n h q */
function leanRow(r, macRates) {
  const mac = Number(r.maccode ?? r.m);
  const hrsRaw = r.hours ?? r.h ?? r.hours_used;
  const h = hrsRaw != null && Number(hrsRaw) > 0 ? Math.round(Number(hrsRaw) * 100) / 100 : null;
  const rates = macRates || { cavity: r.cavity, maccycletime: r.maccycletime };
  const q = qtyFromSlotHours(rates, h);
  const out = {
    m: mac,
    d: String(r.plan_date ?? r.d ?? "").slice(0, 10),
    s: Number(r.shift_no ?? r.s ?? r.shift),
    i: Number(r.id ?? r.i),
    e: String(r.emp_code ?? r.e ?? r.emp ?? "").trim(),
  };
  const n = String(r.emp_name ?? r.n ?? r.ename ?? "").trim();
  if (n) out.n = n;
  if (h != null) out.h = h;
  if (q > 0) out.q = q;
  return out;
}

async function ratesByMac(ids) {
  const rates = new Map();
  if (!ids?.length) return rates;
  const macs = await dbQuery(
    `SELECT maccode, cavity, maccycletime
     FROM ${E.MACHINE_MASTER}
     WHERE is_deleted = false AND maccode = ANY($1::int[])`,
    [ids]
  );
  for (const m of macs || []) rates.set(Number(m.maccode), m);
  return rates;
}

export async function getShiftOp(maccode, planDate, shiftNo) {
  const rows = await dbQuery(
    `SELECT ${SEL}
     FROM ${PM}
     WHERE maccode = $1 AND plan_date = $2::date AND shift_no = $3
     ORDER BY id ASC`,
    [Number(maccode), String(planDate).slice(0, 10), Number(shiftNo)]
  );
  if (!rows?.length) return null;
  const rates = await ratesByMac([Number(maccode)]);
  const segments = rows.map((r) => leanRow(r, rates.get(Number(maccode))));
  return { segments };
}

/** Range list for calendar — machine/shift manpower only. */
export async function listShiftOps({ from_date, to_date, maccode } = {}) {
  const params = [];
  const where = [];
  if (from_date) {
    params.push(String(from_date).slice(0, 10));
    where.push(`s.plan_date >= $${params.length}::date`);
  }
  if (to_date) {
    params.push(String(to_date).slice(0, 10));
    where.push(`s.plan_date <= $${params.length}::date`);
  }
  if (maccode != null && Number(maccode) > 0) {
    params.push(Number(maccode));
    where.push(`s.maccode = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await dbQuery(
    `SELECT s.id, s.maccode, s.plan_date, s.shift_no,
            s.emp_code, s.emp_name, s.hours,
            m.cavity, m.maccycletime
     FROM ${PM} s
     LEFT JOIN ${E.MACHINE_MASTER} m
       ON m.maccode = s.maccode AND m.is_deleted = false
     ${clause}
     ORDER BY s.plan_date ASC, s.shift_no ASC, s.id ASC`,
    params
  );
  return (rows || []).map((r) => leanRow(r));
}

export async function appendShiftOpSegment({ maccode, plan_date, shift_no, emp_code, emp_name, hours_used }) {
  const hrsN = Number(hours_used);
  const hours = Number.isFinite(hrsN) && hrsN > 0 ? Math.round(hrsN * 100) / 100 : null;
  const planDate = String(plan_date).slice(0, 10);
  const shiftNo = Number(shift_no);
  const mac = Number(maccode);

  const [row] = await dbQuery(
    `INSERT INTO ${PM} (maccode, plan_date, shift_no, emp_code, emp_name, hours)
     VALUES ($1, $2::date, $3, $4, $5, $6)
     RETURNING ${SEL}`,
    [mac, planDate, shiftNo, String(emp_code || "").trim(), emp_name ? String(emp_name).trim() : null, hours]
  );
  if (!row) return null;
  const rates = await ratesByMac([mac]);
  return leanRow(row, rates.get(mac));
}

export async function upsertShiftOp(args) {
  return appendShiftOpSegment(args);
}

/** Delete one row by id, or whole cell when id omitted. */
export async function deleteShiftOpSegments({ maccode, plan_date, shift_no, id } = {}) {
  const mac = Number(maccode);
  const planDate = String(plan_date || "").slice(0, 10);
  const shiftNo = Number(shift_no);
  if (!Number.isFinite(mac) || mac < 1 || !planDate || !Number.isFinite(shiftNo) || shiftNo < 1) {
    return [];
  }
  const rowId = Number(id);
  if (Number.isFinite(rowId) && rowId >= 1) {
    const rows = await dbQuery(`DELETE FROM ${PM} WHERE id = $1 RETURNING ${SEL}`, [rowId]);
    return (rows || []).map((r) => leanRow(r));
  }
  const rows = await dbQuery(
    `DELETE FROM ${PM}
     WHERE maccode = $1 AND plan_date = $2::date AND shift_no = $3
     RETURNING ${SEL}`,
    [mac, planDate, shiftNo]
  );
  return (rows || []).map((r) => leanRow(r));
}

/** Update emp / hours on one row. */
export async function updateShiftOpSegment({ id, emp_code, emp_name, hours_used } = {}) {
  const rowId = Number(id);
  if (!Number.isFinite(rowId) || rowId < 1) return null;
  const hrsN = Number(hours_used);
  const hours = Number.isFinite(hrsN) && hrsN > 0 ? Math.round(hrsN * 100) / 100 : null;
  const [row] = await dbQuery(
    `UPDATE ${PM}
     SET emp_code = COALESCE($2, emp_code),
         emp_name = COALESCE($3, emp_name),
         hours = COALESCE($4, hours)
     WHERE id = $1
     RETURNING ${SEL}`,
    [
      rowId,
      emp_code != null ? String(emp_code).trim() : null,
      emp_name != null ? String(emp_name).trim() : null,
      hours,
    ]
  );
  if (!row) return null;
  const rates = await ratesByMac([Number(row.maccode)]);
  return leanRow(row, rates.get(Number(row.maccode)));
}
