import dbQuery from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as E, PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { qtyFromSlotHours } from "../../jc/jobCardProductionTime.js";
import { ratesByMac } from "../../plan/models/planManpower.model.js";

const ENT = T.ENTRY;

const SEL = `
  e.docno, e.docdt, e.jc, e.itemdcode, e.shift, e.shift_start, e.shift_end,
  e.run_proc, e.next_proc, e.operator_id, e.operator, e.qc_person,
  e.machine, e.cavity, e.cycle, e.prd_qty, e.rej_qty, e.ok_qty, e.bin,
  e.is_deleted,
  e.created_by, e.created_at, e.updated_by, e.updated_at,
  e.approved_by, e.approved_at, e.deleted_by, e.deleted_at,
  m.macname AS machine_name, m.macno AS machine_no
`;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function d(v) {
  if (v == null || v === "") return null;
  return String(v).slice(0, 10);
}

function t(v) {
  if (v == null || v === "") return null;
  return String(v).slice(0, 8);
}

function opName(raw) {
  const v = raw?.operator ?? raw?.manpower;
  return v ? String(v).trim() : null;
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
  return {
    jc: raw.jc ? String(raw.jc).trim() : null,
    docdt: d(raw.docdt),
    shift: n(raw.shift),
    shift_start: t(raw.shift_start ?? raw.start_time ?? raw.start_tm ?? raw.start),
    shift_end: t(raw.shift_end ?? raw.end_time ?? raw.end_tm ?? raw.end),
    run_proc: n(raw.run_proc),
    next_proc: n(raw.next_proc),
    operator_id: raw.operator_id != null || raw.emp_code != null
      ? String(raw.operator_id ?? raw.emp_code).trim() || null
      : null,
    operator: opName(raw),
    qc_person: raw.qc_person ? String(raw.qc_person).trim() : null,
    machine: n(raw.machine),
    itemdcode: n(raw.itemdcode),
    cavity: raw.cavity != null ? String(raw.cavity) : null,
    cycle: n(raw.cycle),
    hours: n(raw.hours), // calc only → prd_qty
    prd_qty: n(raw.prd_qty) ?? 0,
    rej_qty: n(raw.rej_qty) ?? 0,
    ok_qty: n(raw.ok_qty ?? raw.qty) ?? 0,
    bin: raw.bin ? String(raw.bin).trim() : null,
  };
}

export async function listEntries({ from_date, to_date } = {}) {
  const params = [];
  const where = ["COALESCE(e.is_deleted, false) = false"];
  if (from_date) {
    params.push(d(from_date));
    where.push(`e.docdt >= $${params.length}::date`);
  }
  if (to_date) {
    params.push(d(to_date));
    where.push(`e.docdt <= $${params.length}::date`);
  }
  return dbQuery(
    `SELECT ${SEL}
     FROM ${ENT} e
     LEFT JOIN ${E.MACHINE_MASTER} m ON m.maccode = e.machine AND COALESCE(m.is_deleted, false) = false
     WHERE ${where.join(" AND ")}
     ORDER BY e.docdt DESC, e.shift ASC, e.docno DESC`,
    params
  );
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

/** Append-only insert — never overwrites history. */
export async function createEntry(raw = {}, user = "system") {
  const row = await fillMachineRates(normalizeRow(raw));

  if (!row.docdt || !(row.shift >= 1) || !(row.machine > 0) || !row.jc) {
    const err = new Error("docdt, shift, machine and jc are required.");
    err.status = 400;
    throw err;
  }

  const [created] = await dbQuery(
    `INSERT INTO ${ENT} (
       docdt, jc, itemdcode, shift, shift_start, shift_end, run_proc, next_proc,
       operator_id, operator, qc_person, machine, cavity, cycle,
       prd_qty, rej_qty, ok_qty, bin, created_by, created_at
     ) VALUES (
       $1::date,$2,$3::int,$4::smallint,$5::time,$6::time,$7::int,$8::int,
       $9,$10,$11,$12::int,$13,$14::int,
       $15,$16,$17,$18,$19,NOW()
     ) RETURNING docno`,
    [
      row.docdt, row.jc, row.itemdcode, row.shift, row.shift_start, row.shift_end,
      row.run_proc, row.next_proc, row.operator_id, row.operator, row.qc_person,
      row.machine, row.cavity, row.cycle,
      row.prd_qty || 0, row.rej_qty || 0, row.ok_qty || 0, row.bin,
      user,
    ]
  );
  return getEntry(created.docno);
}

/**
 * Append-only "update": inserts a new log row from existing + patch.
 * The previous row is left unchanged (history preserved).
 */
export async function updateEntry(docno, raw = {}, user = null) {
  const existing = await getEntry(docno);
  if (!existing) return null;

  const merged = {
    jc: raw.jc !== undefined ? raw.jc : existing.jc,
    docdt: raw.docdt !== undefined ? raw.docdt : existing.docdt,
    shift: raw.shift !== undefined ? raw.shift : existing.shift,
    shift_start:
      raw.shift_start !== undefined || raw.start_time !== undefined || raw.start_tm !== undefined || raw.start !== undefined
        ? (raw.shift_start ?? raw.start_time ?? raw.start_tm ?? raw.start)
        : existing.shift_start,
    shift_end:
      raw.shift_end !== undefined || raw.end_time !== undefined || raw.end_tm !== undefined || raw.end !== undefined
        ? (raw.shift_end ?? raw.end_time ?? raw.end_tm ?? raw.end)
        : existing.shift_end,
    run_proc: raw.run_proc !== undefined ? raw.run_proc : existing.run_proc,
    next_proc: raw.next_proc !== undefined ? raw.next_proc : existing.next_proc,
    operator_id:
      raw.operator_id !== undefined || raw.emp_code !== undefined
        ? (raw.operator_id ?? raw.emp_code)
        : existing.operator_id,
    operator: raw.operator !== undefined || raw.manpower !== undefined
      ? (raw.operator ?? raw.manpower)
      : existing.operator,
    qc_person: raw.qc_person !== undefined ? raw.qc_person : existing.qc_person,
    machine: raw.machine !== undefined ? raw.machine : existing.machine,
    itemdcode: raw.itemdcode !== undefined ? raw.itemdcode : existing.itemdcode,
    cavity: raw.cavity !== undefined ? raw.cavity : existing.cavity,
    cycle: raw.cycle !== undefined ? raw.cycle : existing.cycle,
    hours: raw.hours,
    prd_qty: raw.prd_qty !== undefined ? raw.prd_qty : existing.prd_qty,
    rej_qty: raw.rej_qty !== undefined ? raw.rej_qty : existing.rej_qty,
    ok_qty: raw.ok_qty !== undefined || raw.qty !== undefined
      ? (raw.ok_qty ?? raw.qty)
      : existing.ok_qty,
    bin: raw.bin !== undefined ? raw.bin : existing.bin,
  };

  return createEntry(merged, user || "system");
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
     WHERE docno = $1 AND is_deleted = false
     RETURNING docno`,
    [id, user]
  );
  return row || null;
}
