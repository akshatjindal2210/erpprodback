import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as E, PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { qtyFromSlotHours } from "../../jc/jobCardProductionTime.js";
import { listActiveShiftCodes, ratesByMac } from "../../plan/models/planManpower.model.js";

const ENT = T.ENTRY;

const SEL = `
  e.docno, e.docdt, e.dept, e.jc, e.itemdcode,
  e.shift, e.shift_start, e.shift_end,
  e.run_proc, e.next_proc, e.operator_id, e.operator, e.qc_person_id, e.qc_person,
  e.machine, e.cavity, e.cycle, e.target_qty, e.prd_qty, e.loose_qty, e.rej_qty, e.ok_qty,
  e.bin, e.remark, e.is_deleted,
  e.created_by, e.created_at, e.updated_by, e.updated_at,
  e.approved_by, e.approved_at, e.deleted_by, e.deleted_at,
  m.macname AS machine_name, m.macno AS machine_no
`;

/** dept: 0 = Production, 1 = Job Work */
function deptCode(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "1" || s === "job work" || s === "jobwork") return 1;
  return 0;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** YYYY-MM-DD from date / Date / ISO string */
function ymd(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const day = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** TIMESTAMP `YYYY-MM-DD HH:MM:SS` from datetime, Date, or time + day */
function stamp(v, day) {
  if (v == null || v === "") return null;

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const dayPart = ymd(v);
    const hh = String(v.getHours()).padStart(2, "0");
    const mm = String(v.getMinutes()).padStart(2, "0");
    const ss = String(v.getSeconds()).padStart(2, "0");
    return `${dayPart} ${hh}:${mm}:${ss}`;
  }

  const s = String(v).trim().replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(s)) {
    return s.slice(0, 19);
  }

  const dayPart = ymd(day);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!dayPart || !m) return null;
  return `${dayPart} ${m[1].padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
}

/**
 * Inclusive window: today and previous (days-1) calendar days.
 * days <= 0 → unlimited (null / true).
 */
export function docdtDaysSql(days, alias = "e") {
  const d = Math.floor(Number(days));
  if (!(d > 0)) return null;
  const back = Math.max(1, d) - 1;
  return `${alias}.docdt >= CURRENT_DATE - INTERVAL '${back} days'`;
}

export function isDocdtWithinDays(docdt, days) {
  const limit = Math.floor(Number(days));
  if (!(limit > 0)) return true;
  const day = ymd(docdt);
  if (!day) return false;
  const d = new Date(`${day}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const age = Math.floor((today.getTime() - d.getTime()) / 86400000);
  return age >= 0 && age <= limit - 1;
}

async function fillMachineRates(row) {
  const mac = n(row.machine);
  if (!(mac > 0)) return row;
  const rates = await ratesByMac([mac]);
  const m = rates.get(mac) || {};
  if (row.cavity == null && m.cavity != null) row.cavity = String(m.cavity);
  if (!(n(row.cycle) > 0) && n(m.maccycletime) > 0) row.cycle = n(m.maccycletime);
  if (!(n(row.prd_qty) > 0) && n(row.hours) > 0) {
    row.prd_qty = qtyFromSlotHours({ cavity: row.cavity, maccycletime: row.cycle }, row.hours) || 0;
  }
  return row;
}

function normalizeRow(raw = {}) {
  const target = n(raw.target_qty) ?? 0;
  let prd = n(raw.prd_qty) ?? 0;
  let rej = n(raw.rej_qty) ?? 0;
  if (target > 0 && prd > target) prd = target;
  if (rej > prd) rej = prd;

  const docdt = ymd(raw.docdt);
  const startDay = ymd(raw.start_dt) || docdt;
  const endDay = ymd(raw.end_dt) || startDay;
  const okIn = n(raw.ok_qty ?? raw.qty);

  return {
    dept: deptCode(raw.dept ?? raw.department),
    jc: str(raw.jc),
    docdt,
    shift: n(raw.shift),
    shift_start: stamp(raw.shift_start ?? raw.start_time, startDay),
    shift_end: stamp(raw.shift_end ?? raw.end_time, endDay),
    run_proc: n(raw.run_proc),
    next_proc: n(raw.next_proc),
    operator_id: str(raw.operator_id ?? raw.emp_code),
    operator: str(raw.operator ?? raw.manpower),
    qc_person_id: str(raw.qc_person_id),
    qc_person: str(raw.qc_person),
    machine: n(raw.machine),
    itemdcode: n(raw.itemdcode),
    cavity: raw.cavity != null && raw.cavity !== "" ? String(raw.cavity) : null,
    cycle: n(raw.cycle),
    hours: n(raw.hours),
    target_qty: target,
    prd_qty: prd,
    loose_qty: n(raw.loose_qty) ?? Math.max(0, target - prd),
    rej_qty: rej,
    ok_qty: okIn != null ? okIn : Math.max(0, prd - rej),
    bin: str(raw.bin),
    remark: raw.remark != null ? str(raw.remark) : null,
  };
}

function assertEntry(row) {
  if (!row.docdt || !(row.shift >= 1) || !(row.machine > 0) || !row.jc) {
    const err = new Error("docdt, shift, machine and jc are required.");
    err.status = 400;
    throw err;
  }
}

function writeParams(row, user) {
  return [
    row.docdt,
    row.dept,
    row.jc,
    row.itemdcode,
    row.shift,
    row.shift_start,
    row.shift_end,
    row.run_proc,
    row.next_proc,
    row.operator_id,
    row.operator,
    row.qc_person_id,
    row.qc_person,
    row.machine,
    row.cavity,
    row.cycle,
    row.target_qty || 0,
    row.prd_qty || 0,
    row.loose_qty || 0,
    row.rej_qty || 0,
    row.ok_qty || 0,
    row.bin,
    row.remark,
    user || "system",
  ];
}

async function withShiftName(rows) {
  const list = await listActiveShiftCodes();
  const byId = new Map((list || []).map((s) => [Number(s.id), String(s.code || "").trim()]));
  return (rows || []).map((r) => ({
    ...r,
    shift_name: byId.get(Number(r.shift)) || (Number(r.shift) >= 1 ? String(r.shift) : null),
  }));
}

export async function listEntries({ from_date, to_date, permission = null } = {}) {
  const params = [];
  const where = ["COALESCE(e.is_deleted, false) = false"];
  const viewSql = docdtDaysSql(permission?.can_view_days, "e");
  if (viewSql) where.push(viewSql);
  if (from_date) {
    params.push(ymd(from_date));
    where.push(`e.docdt >= $${params.length}::date`);
  }
  if (to_date) {
    params.push(ymd(to_date));
    where.push(`e.docdt <= $${params.length}::date`);
  }
  const rows = await dbQuery(
    `SELECT ${SEL}
     FROM ${ENT} e
     LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = e.machine AND COALESCE(m.is_deleted, false) = false
     WHERE ${where.join(" AND ")}
     ORDER BY e.docdt DESC, e.shift ASC, e.docno DESC`,
    params
  );
  return withShiftName(rows);
}

export async function getEntry(docno) {
  const id = n(docno);
  if (!(id > 0)) return null;
  const [row] = await dbQuery(
    `SELECT ${SEL}
     FROM ${ENT} e
     LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = e.machine AND COALESCE(m.is_deleted, false) = false
     WHERE e.docno = $1 AND COALESCE(e.is_deleted, false) = false`,
    [id]
  );
  return row || null;
}

export async function createEntry(raw = {}, user = "system") {
  const row = await fillMachineRates(normalizeRow(raw));
  assertEntry(row);
  const [created] = await dbQuery(
    `INSERT INTO ${ENT} (
       docdt, dept, jc, itemdcode, shift, shift_start, shift_end,
       run_proc, next_proc, operator_id, operator, qc_person_id, qc_person,
       machine, cavity, cycle,
       target_qty, prd_qty, loose_qty, rej_qty, ok_qty, bin, remark, created_by, created_at
     ) VALUES (
       $1::date,$2::smallint,$3,$4::int,$5::smallint,$6::timestamp,$7::timestamp,
       $8::int,$9::int,$10,$11,$12,$13,
       $14::int,$15,$16::int,
       $17,$18,$19,$20,$21,$22,$23,$24,NOW()
     ) RETURNING docno`,
    writeParams(row, user)
  );
  return getEntry(created.docno);
}

/** In-place update — FE sends full form body. */
export async function updateEntry(docno, raw = {}, user = null) {
  const id = n(docno);
  if (!(id > 0)) return null;
  if (!(await getEntry(id))) return null;

  const row = await fillMachineRates(
    normalizeRow({
      ...raw,
      start_dt: raw.start_dt || raw.docdt,
      end_dt: raw.end_dt || raw.start_dt || raw.docdt,
    })
  );
  assertEntry(row);

  const [updated] = await dbQuery(
    `UPDATE ${ENT} SET
       docdt=$2::date, dept=$3::smallint, jc=$4, itemdcode=$5::int,
       shift=$6::smallint, shift_start=$7::timestamp, shift_end=$8::timestamp,
       run_proc=$9::int, next_proc=$10::int,
       operator_id=$11, operator=$12, qc_person_id=$13, qc_person=$14,
       machine=$15::int, cavity=$16, cycle=$17::int,
       target_qty=$18, prd_qty=$19, loose_qty=$20, rej_qty=$21, ok_qty=$22,
       bin=$23, remark=$24, updated_by=$25, updated_at=NOW()
     WHERE docno=$1 AND COALESCE(is_deleted, false)=false
     RETURNING docno`,
    [id, ...writeParams(row, user)]
  );
  return updated ? getEntry(updated.docno) : null;
}

export async function deleteEntry(docno, user = null) {
  const id = n(docno);
  if (!(id > 0)) return null;
  const [row] = await dbQuery(
    `UPDATE ${ENT}
     SET is_deleted = true,
         deleted_by = $2,
         deleted_at = NOW(),
         updated_by = $2,
         updated_at = NOW()
     WHERE docno = $1 AND COALESCE(is_deleted, false) = false
     RETURNING docno`,
    [id, user]
  );
  return row || null;
}
