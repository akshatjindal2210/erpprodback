import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams, addIn, whereSql } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";
import { HRMS_LOAN_AMOUNT } from "../../../lib/config/app.config.js";

const LN = T.LOAN;
const LD = T.DEDUCTION;
const logLoan = createHrmsActivityLogger("hrms_loan");
const logDeduction = createHrmsActivityLogger("hrms_deduction");

const EMI_SQL = `type IN ('loan','advance')`;
const EXTRA_SQL = `type NOT IN ('loan','advance')`;
const DEDUCTION_TYPE_LABEL = { loan: "Loan", advance: "Advance", extra: "Extra" };
const DEDUCTION_STATUS_LABEL = { pending: "Pending", approved: "Approved", deducted: "Deducted" };
const DEDUCTION_COLS = `
  d.id, d.loan_id, d.emp_dcode, d.type, d.amount, d.remarks, d.status,
  to_char(d.month, 'YYYY-MM-DD') AS month,
  ${istTs("d.deducted_at")} AS deducted_at,
  d.created_by, ${istTs("d.created_at")} AS created_at,
  d.updated_by, ${istTs("d.updated_at")} AS updated_at,
  d.approved_by, ${istTs("d.approved_at")} AS approved_at, d.approved_remarks
`;

function normDeductionType(type, loanType) {
  const t = String(type || "").trim().toLowerCase();
  if (t === "p" || t === "extra") return "extra";
  if (t === "advance") return "advance";
  if (t === "loan") return "loan";
  if (t === "e") return String(loanType || "").toLowerCase() === "advance" ? "advance" : "loan";
  return t || "loan";
}

function scheduleType(loanType) {
  return String(loanType || "").toLowerCase() === "advance" ? "advance" : "loan";
}

function hasHrmsManagerPermission(user) {
  const role = String(user?.type || user?.role || "").toLowerCase().trim();
  if (role === "super_admin") return true;
  const raw = user?.special_permissions;
  const perms = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : (raw || {});
  return Boolean(perms?.hrms?.gate_pass_supervisor);
}

const LOAN_COLS = `
  l.id, l.emp_dcode, l.type, l.amount, l.emi_months,
  to_char(l.start_month, 'YYYY-MM-DD') AS start_month, l.reason,
      (SELECT d.amount FROM ${LD} d WHERE d.loan_id = l.id AND d.type IN ('loan','advance') ORDER BY d.month ASC LIMIT 1) AS emi_amount,
  l.sup_by, ${istTs("l.sup_at")} AS sup_at, l.sup_remarks,
  l.approved_by, ${istTs("l.approved_at")} AS approved_at, l.approved_remarks,
  l.created_by, l.updated_by,
  ${istTs("l.created_at")} AS created_at,
  ${istTs("l.updated_at")} AS updated_at
`;

function requireRemark(body) {
  return String(body?.remarks || body?.sup_remarks || body?.approved_remarks || "").trim() || null;
}

function empDcode(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function monthDate(v) {
  const m = String(v ?? "").trim().match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? `${m[1]}-${m[2]}-01` : null;
}

function monthYm(v) {
  return String(v ?? "").slice(0, 7);
}

function toPaise(n) {
  return Math.round(Number(n) * 100);
}

function fromPaise(p) {
  return Math.round(Number(p)) / 100;
}

function currentYmIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
}

/** Schedule in paise; last row absorbs remainder so SUM == total. */
function buildSchedulePaise(amountRupees, months, startYm, firstRupees) {
  const start = monthDate(startYm);
  if (!start || !months) return { error: "Start month / EMI months invalid." };
  const totalP = toPaise(amountRupees);
  if (totalP < toPaise(HRMS_LOAN_AMOUNT.MIN) || totalP > toPaise(HRMS_LOAN_AMOUNT.MAX)) {
    return { error: `Amount must be between ${HRMS_LOAN_AMOUNT.MIN} and ${HRMS_LOAN_AMOUNT.MAX}.` };
  }
  const [y0, m0] = start.split("-").map(Number);
  let firstP = firstRupees != null && firstRupees !== "" ? Math.round(toPaise(firstRupees) / 100) * 100 : null;
  if (firstP != null) {
    if (firstP <= 0) return { error: "First month amount must be greater than 0." };
    if (firstP > totalP) return { error: "First month amount cannot exceed loan amount." };
    if (months === 1 && firstP !== totalP) return { error: "Single-month schedule must equal loan amount." };
  }
  const rows = [];
  let sumP = 0;
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y0, m0 - 1 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    let p;
    if (i === months - 1) p = totalP - sumP;
    else if (i === 0 && firstP != null) p = firstP;
    else if (firstP != null) p = Math.floor((totalP - firstP) / ((months - 1) * 100)) * 100;
    else p = Math.floor(totalP / (months * 100)) * 100;
    if (i < months - 1 && p < 100) p = 100;
    sumP += p;
    rows.push({ month, amount: fromPaise(p) });
  }
  if (sumP !== totalP) return { error: "Schedule sum must equal loan amount." };
  return { rows };
}

function parseSchedule(body, amount, months, startYm) {
  const raw = body?.schedule;
  if (Array.isArray(raw) && raw.length) {
    if (raw.length !== months) return { error: "Schedule months must match EMI months." };
    const start = monthYm(startYm);
    const rows = [];
    let sumP = 0;
    for (let i = 0; i < raw.length; i++) {
      const md = monthDate(raw[i]?.month);
      const p = toPaise(raw[i]?.amount);
      if (!md || p <= 0) return { error: "Each schedule row needs month and amount > 0." };
      if (i === 0 && monthYm(md) !== start) return { error: "First schedule month must match start month." };
      rows.push({ month: md, amount: fromPaise(p) });
      sumP += p;
    }
    if (toPaise(rows[0].amount) > toPaise(amount)) return { error: "First month amount cannot exceed loan amount." };
    if (sumP !== toPaise(amount)) return { error: "Schedule sum must equal loan amount." };
    return { rows };
  }
  return buildSchedulePaise(amount, months, startYm, body?.first_month_amount);
}

async function ensureEmiRows(client, loan) {
  const found = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${LD} WHERE loan_id = $1 AND ${EMI_SQL}`,
    [loan.id]
  );
  if (found.rows[0]?.n) return;
  const sched = buildSchedulePaise(loan.amount, Number(loan.emi_months) || 1, loan.start_month);
  if (sched.error || !sched.rows?.length) {
    throw Object.assign(new Error(sched.error || "EMI schedule is missing."), { status: 400 });
  }
  await insertEmiRows(client, loan, sched.rows);
}

async function insertEmiRows(client, loan, rows) {
  const type = scheduleType(loan.type);
  const by = loan.created_by || null;
  for (const row of rows) {
    await client.query(
      `INSERT INTO ${LD} (loan_id, emp_dcode, month, type, amount, created_by, status)
       VALUES ($1, $2, $3::date, $4, $5, $6, 'pending')`,
      [loan.id, loan.emp_dcode, row.month, type, row.amount, by]
    );
  }
}

async function approveEmiRows(client, loanId, by, remarks) {
  await client.query(
    `UPDATE ${LD}
     SET approved_by = $2, approved_at = NOW(), approved_remarks = $3, status = 'approved',
         updated_by = $2, updated_at = NOW()
     WHERE loan_id = $1 AND ${EMI_SQL} AND status = 'pending'`,
    [loanId, by, remarks]
  );
}

async function replaceEmiRows(client, loan, rows) {
  const locked = await client.query(
    `SELECT id FROM ${LD} WHERE loan_id = $1 AND ${EMI_SQL} AND status = 'deducted' LIMIT 1`,
    [loan.id]
  );
  if (locked.rows[0]) throw Object.assign(new Error("Cannot change schedule after deductions started."), { status: 409 });
  await client.query(`DELETE FROM ${LD} WHERE loan_id = $1 AND ${EMI_SQL} AND status <> 'deducted'`, [loan.id]);
  await insertEmiRows(client, loan, rows);
}

async function empMap() {
  const map = new Map();
  for (const row of await fetchEmpMaster({})) {
    const d = empDcode(row.emp_dcode);
    if (d) map.set(d, row);
  }
  return map;
}

function formatRow(row, map) {
  if (!row) return row;
  const emp = map?.get(empDcode(row.emp_dcode));
  const status = row.sup_at && row.approved_at ? "approved" : row.sup_at ? "pending_approve" : "pending_manager";
  return {
    ...row,
    amount: Number(row.amount),
    emi_amount: row.emi_amount != null ? Number(row.emi_amount) : null,
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
    status,
    status_display: status === "approved" ? "Approved" : status === "pending_approve" ? "Pending Approve" : "Pending Manager",
    type_display: row.type === "advance" ? "Advance" : "Loan",
    start_month_display: monthYm(row.start_month),
    sup_at_display: formatHrmsDateTime(row.sup_at),
    approved_at_display: formatHrmsDateTime(row.approved_at),
    created_at_display: formatHrmsDateTime(row.created_at),
    updated_at_display: formatHrmsDateTime(row.updated_at),
  };
}

async function getById(id, map) {
  const rows = await dbQuery(`SELECT ${LOAN_COLS} FROM ${LN} l WHERE l.id = $1`, [id]);
  return rows[0] ? formatRow(rows[0], map) : null;
}

async function parseBody(body, excludeId = null) {
  const dcode = empDcode(body.emp_dcode);
  const type = String(body.type ?? "").trim().toLowerCase();
  const amount = Number(body.amount);
  const months = type === "advance" ? 1 : Number(body.emi_months);
  const start = monthDate(body.start_month);
  const reason = String(body.reason ?? "").trim();

  if (!dcode) return { error: "Employee is required." };
  if (type !== "loan" && type !== "advance") return { error: "Type (loan/advance) is required." };
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Valid amount is required." };
  if (amount < HRMS_LOAN_AMOUNT.MIN || amount > HRMS_LOAN_AMOUNT.MAX) {
    return { error: `Amount must be between ${HRMS_LOAN_AMOUNT.MIN} and ${HRMS_LOAN_AMOUNT.MAX}.` };
  }
  if (!Number.isFinite(months) || months < 1 || !Number.isInteger(months)) return { error: "EMI months is required." };
  if (!start) return { error: "Start month is required." };
  if (!reason) return { error: "Reason is required." };

  const sched = parseSchedule(body, amount, months, start);
  if (sched.error) return { error: sched.error };

  const params = [dcode];
  let sql = `SELECT id FROM ${LN} WHERE emp_dcode = $1 AND (sup_at IS NULL OR approved_at IS NULL)`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }
  if ((await dbQuery(`${sql} LIMIT 1`, params))[0]) {
    return { error: "Employee already has a pending loan/advance." };
  }

  return { dcode, type, amount: fromPaise(toPaise(amount)), months, start, reason, schedule: sched.rows };
}

function formatDeduction(row, map) {
  const ym = monthYm(row.month);
  const type = normDeductionType(row.type, row.loan_type);
  const emp = map?.get(empDcode(row.emp_dcode));
  const status = row.status === "deducted" || row.deducted_at ? "deducted" : row.status || "pending";
  const overdue = status === "approved" && ym < currentYmIst();
  return {
    id: row.id,
    loan_id: row.loan_id || null,
    emp_dcode: empDcode(row.emp_dcode),
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
    month: ym,
    type,
    type_display: DEDUCTION_TYPE_LABEL[type] || type,
    amount: Number(row.amount),
    remarks: row.remarks || null,
    status,
    status_display: overdue ? "Overdue" : DEDUCTION_STATUS_LABEL[status] || status,
    overdue,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    created_at_display: formatHrmsDateTime(row.created_at),
    updated_by: row.updated_by || null,
    updated_at: row.updated_at || null,
    updated_at_display: formatHrmsDateTime(row.updated_at),
    approved_by: row.approved_by || null,
    approved_at: row.approved_at || null,
    approved_at_display: formatHrmsDateTime(row.approved_at),
    approved_remarks: row.approved_remarks || null,
    deducted_at: row.deducted_at || null,
    deducted_at_display: formatHrmsDateTime(row.deducted_at),
  };
}

function summaryFromAgg(loanAmount, agg) {
  const total = Number(agg?.total ?? loanAmount) || 0;
  const paid = Number(agg?.paid ?? 0) || 0;
  const penaltyTotal = Number(agg?.penalty_total ?? 0) || 0;
  const penaltyPaid = Number(agg?.penalty_paid ?? 0) || 0;
  return {
    total,
    paid,
    balance: fromPaise(toPaise(total) - toPaise(paid)),
    next_due: agg?.next_due ? monthYm(agg.next_due) : null,
    closed: toPaise(total) > 0 && toPaise(paid) === toPaise(total) && toPaise(penaltyTotal) === toPaise(penaltyPaid),
    penalty_total: penaltyTotal,
    penalty_paid: penaltyPaid,
    penalty_pending: fromPaise(toPaise(penaltyTotal) - toPaise(penaltyPaid)),
  };
}

export async function listLoan(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const map = await empMap();
    const parts = [];
    const params = [];

    const dcode = empDcode(filters?.emp_dcode);
    if (dcode) {
      params.push(dcode);
      parts.push(`l.emp_dcode = $${params.length}`);
    }
    const type = String(filters?.type ?? "").trim().toLowerCase();
    if (type === "loan" || type === "advance") {
      params.push(type);
      parts.push(`l.type = $${params.length}`);
    }
    const status = String(filters?.status ?? "").trim().toLowerCase();
    if (status === "approved") parts.push(`l.sup_at IS NOT NULL AND l.approved_at IS NOT NULL`);
    else if (status === "pending_approve" || status === "pending_hr") parts.push(`l.sup_at IS NOT NULL AND l.approved_at IS NULL`);
    else if (status === "pending_manager") parts.push(`l.sup_at IS NULL`);

    const search = String(filters?.search ?? bodySearch ?? "").trim();
    if (search) {
      params.push(`%${search}%`);
      const searchParts = [`l.reason ILIKE $${params.length}`];
      const dcodes = [];
      for (const [d, emp] of map) {
        if ([emp.emp_code, emp.emp_name, emp.deptname].join(" ").toLowerCase().includes(search.toLowerCase())) dcodes.push(d);
      }
      addIn(searchParts, params, "l.emp_dcode", dcodes);
      parts.push(`(${searchParts.join(" OR ")})`);
    }

    const where = whereSql(parts);
    const countRows = await dbQuery(`SELECT COUNT(*) AS total FROM ${LN} l ${where}`, params);
    params.push(limit, offset);
    const rows = await dbQuery(
      `SELECT ${LOAN_COLS} FROM ${LN} l ${where} ORDER BY l.start_month DESC, l.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ success: true, data: rows.map((r) => formatRow(r, map)), total: Number(countRows[0]?.total ?? 0), page, limit });
  } catch (err) {
    console.error("[HRMS] listLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

/** Deduction register: one row per deduction (loan / advance / extra). */
export async function listLoanDeductionQueue(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const map = await empMap();
    const parts = [];
    const params = [];

    const dcode = empDcode(filters?.emp_dcode);
    if (dcode) {
      params.push(dcode);
      parts.push(`d.emp_dcode = $${params.length}`);
    }
    const type = String(filters?.type ?? "").trim().toLowerCase();
    if (type === "loan" || type === "advance" || type === "extra") {
      params.push(type);
      parts.push(`d.type = $${params.length}`);
    }
    const status = String(filters?.status ?? "").trim().toLowerCase();
    if (status === "deducted") parts.push(`d.status = 'deducted'`);
    else if (status === "approved") parts.push(`d.status = 'approved'`);
    else if (status === "pending") parts.push(`d.status = 'pending'`);
    else if (status === "overdue") {
      parts.push(`d.status = 'approved' AND to_char(d.month, 'YYYY-MM') < $${params.length + 1}`);
      params.push(currentYmIst());
    }

    const search = String(filters?.search ?? bodySearch ?? "").trim();
    if (search) {
      params.push(`%${search}%`);
      const searchParts = [`d.remarks ILIKE $${params.length}`];
      const dcodes = [];
      for (const [d, emp] of map) {
        if ([emp.emp_code, emp.emp_name, emp.deptname].join(" ").toLowerCase().includes(search.toLowerCase())) dcodes.push(d);
      }
      addIn(searchParts, params, "d.emp_dcode", dcodes);
      parts.push(`(${searchParts.join(" OR ")})`);
    }

    const where = whereSql(parts);
    const countRows = await dbQuery(`SELECT COUNT(*) AS total FROM ${LD} d ${where}`, params);
    const listParams = [...params, limit, offset];
    const rows = await dbQuery(
      `SELECT ${DEDUCTION_COLS}, l.type AS loan_type
       FROM ${LD} d
       LEFT JOIN ${LN} l ON l.id = d.loan_id
       ${where}
       ORDER BY d.month DESC, d.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    return res.json({
      success: true,
      data: rows.map((r) => formatDeduction(r, map)),
      total: Number(countRows[0]?.total ?? 0),
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] listLoanDeductionQueue:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitLoan(req, res) {
  try {
    const parsed = await parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const map = await empMap();
    if (!map.has(parsed.dcode)) return res.status(404).json({ success: false, message: "Employee not found." });

    const data = await withTransaction(async (client) => {
      const rows = await client.query(
        `INSERT INTO ${LN} (emp_dcode, type, amount, emi_months, start_month, reason, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)
         RETURNING id`,
        [parsed.dcode, parsed.type, parsed.amount, parsed.months, parsed.start, parsed.reason, auditUserName(req)]
      );
      const id = rows.rows[0].id;
      await insertEmiRows(client, {
        id,
        emp_dcode: parsed.dcode,
        type: parsed.type,
        created_by: auditUserName(req),
      }, parsed.schedule);
      const full = await client.query(`SELECT ${LOAN_COLS} FROM ${LN} l WHERE l.id = $1`, [id]);
      return formatRow(full.rows[0], map);
    });

    logLoan(req, "create", data.id, { type: parsed.type, emp_dcode: parsed.dcode, schedule: parsed.schedule.length }, data);
    return res.status(201).json({ success: true, message: "Loan created.", data });
  } catch (err) {
    console.error("[HRMS] submitLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateLoan(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.approved_at) return res.status(409).json({ success: false, message: "Approved loan cannot be edited." });
    if (existing.sup_at) return res.status(409).json({ success: false, message: "Cannot edit after manager approval." });

    const parsed = await parseBody(
      {
        emp_dcode: req.body?.emp_dcode ?? existing.emp_dcode,
        type: req.body?.type ?? existing.type,
        amount: req.body?.amount ?? existing.amount,
        emi_months: req.body?.emi_months ?? existing.emi_months,
        start_month: req.body?.start_month ?? existing.start_month,
        reason: req.body?.reason ?? existing.reason,
        schedule: req.body?.schedule,
        first_month_amount: req.body?.first_month_amount,
      },
      id
    );
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const data = await withTransaction(async (client) => {
      await client.query(
        `UPDATE ${LN} SET
           emp_dcode=$2, type=$3, amount=$4, emi_months=$5, start_month=$6::date, reason=$7,
           updated_by=$8, updated_at=NOW(),
           sup_by=NULL, sup_at=NULL, sup_remarks=NULL,
           approved_by=NULL, approved_at=NULL, approved_remarks=NULL
         WHERE id=$1`,
        [id, parsed.dcode, parsed.type, parsed.amount, parsed.months, parsed.start, parsed.reason, auditUserName(req)]
      );
      await replaceEmiRows(client, {
        id,
        emp_dcode: parsed.dcode,
        type: parsed.type,
        created_by: existing.created_by || auditUserName(req),
      }, parsed.schedule);
      const full = await client.query(`SELECT ${LOAN_COLS} FROM ${LN} l WHERE l.id = $1`, [id]);
      return formatRow(full.rows[0], map);
    });

    logLoan(req, "update", data.id, { type: parsed.type, emp_dcode: parsed.dcode }, data);
    return res.json({ success: true, message: "Loan updated.", data });
  } catch (err) {
    const status = err.status || 500;
    console.error("[HRMS] updateLoan:", err);
    return res.status(status).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyManagerLoan(req, res) {
  try {
    if (!hasHrmsManagerPermission(req.user)) {
      return res.status(403).json({ success: false, message: "Manager permission required." });
    }
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const remarks = requireRemark(req.body);
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at) return res.status(409).json({ success: false, message: "Already approved by manager." });

    const rows = await dbQuery(
      `UPDATE ${LN} SET sup_by=$2, sup_at=NOW(), sup_remarks=$3 WHERE id=$1 RETURNING id`,
      [id, auditUserName(req), remarks]
    );
    const data = await getById(rows[0].id, map);
    logLoan(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Manager approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyApproveLoan(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const remarks = requireRemark(req.body);
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!existing.sup_at) return res.status(409).json({ success: false, message: "Manager approval is required first." });
    if (existing.approved_at) return res.status(409).json({ success: false, message: "Already approved." });

    const data = await withTransaction(async (client) => {
      await ensureEmiRows(client, existing);
      const by = auditUserName(req);
      await client.query(`UPDATE ${LN} SET approved_by=$2, approved_at=NOW(), approved_remarks=$3 WHERE id=$1`, [
        id,
        by,
        remarks,
      ]);
      await approveEmiRows(client, id, by, remarks);
      const full = await client.query(`SELECT ${LOAN_COLS} FROM ${LN} l WHERE l.id = $1`, [id]);
      return formatRow(full.rows[0], map);
    });

    logLoan(req, "approve", data.id, { stage: "approve" }, data);
    return res.json({ success: true, message: "Approved.", data });
  } catch (err) {
    const status = err.status || 500;
    console.error("[HRMS] verifyApproveLoan:", err);
    return res.status(status).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteLoan(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    await dbQuery(`DELETE FROM ${LN} WHERE id = $1`, [id]);
    logLoan(req, "delete", existing.id, null, existing);
    return res.json({ success: true, message: "Deleted.", data: existing });
  } catch (err) {
    console.error("[HRMS] deleteLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function listLoanDeductions(req, res) {
  try {
    const loanId = Number(req.body?.loan_id ?? req.body?.id);
    if (!loanId) return res.status(400).json({ success: false, message: "loan_id is required." });
    const map = await empMap();
    const loan = await getById(loanId, map);
    if (!loan) return res.status(404).json({ success: false, message: "Not found." });

    const raw = await dbQuery(
      `SELECT ${DEDUCTION_COLS},
         COALESCE(SUM(amount) FILTER (WHERE ${EMI_SQL}) OVER (), 0) AS sum_total,
         COALESCE(SUM(amount) FILTER (WHERE ${EMI_SQL} AND status = 'deducted') OVER (), 0) AS sum_paid,
         MIN(month) FILTER (WHERE ${EMI_SQL} AND status <> 'deducted') OVER () AS sum_next_due,
         COALESCE(SUM(amount) FILTER (WHERE ${EXTRA_SQL}) OVER (), 0) AS sum_penalty_total,
         COALESCE(SUM(amount) FILTER (WHERE ${EXTRA_SQL} AND status = 'deducted') OVER (), 0) AS sum_penalty_paid
       FROM ${LD} d
       WHERE loan_id = $1
       ORDER BY month ASC, type ASC, id ASC`,
      [loanId]
    );
    const data = raw.map((r) => formatDeduction(r, map));
    const first = raw[0];
    const summary = summaryFromAgg(
      loan.amount,
      first
        ? {
            total: first.sum_total,
            paid: first.sum_paid,
            next_due: first.sum_next_due,
            penalty_total: first.sum_penalty_total,
            penalty_paid: first.sum_penalty_paid,
          }
        : { total: loan.amount, paid: 0, next_due: null, penalty_total: 0, penalty_paid: 0 }
    );
    return res.json({
      success: true,
      data,
      summary,
      loan: { ...loan, status_display: summary.closed ? "Closed" : loan.status_display },
    });
  } catch (err) {
    console.error("[HRMS] listLoanDeductions:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function markLoanDeductions(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => n > 0) : [];
    const loanId = Number(req.body?.loan_id);
    const month = monthDate(req.body?.month);
    if (!ids.length && !(loanId && month)) {
      return res.status(400).json({ success: false, message: "ids or loan_id + month required." });
    }
    const by = auditUserName(req);

    const updated = await withTransaction(async (client) => {
      let target = ids;
      if (!target.length) {
        const found = await client.query(
          `SELECT id FROM ${LD} WHERE loan_id = $1 AND month = $2::date AND status = 'approved'`,
          [loanId, month]
        );
        target = found.rows.map((r) => Number(r.id));
      }
      if (!target.length) return [];
      const result = await client.query(
        `UPDATE ${LD}
         SET deducted_at = NOW(), status = 'deducted', updated_by = $2, updated_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'approved'
         RETURNING id, loan_id, to_char(month,'YYYY-MM') AS month, type, amount, status, deducted_at`,
        [target, by]
      );
      return result.rows;
    });

    if (!updated.length) return res.status(409).json({ success: false, message: "Only approved rows can be deducted." });
    logDeduction(req, "update", updated[0].loan_id, {
      stage: "deduct",
      ids: updated.map((r) => r.id),
      old_values: { status: "approved" },
      new_values: { status: "deducted" },
    });
    return res.json({ success: true, message: "Marked deducted.", data: updated });
  } catch (err) {
    console.error("[HRMS] markLoanDeductions:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function undoLoanDeductions(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => n > 0) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "ids required." });
    const by = auditUserName(req);

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE ${LD}
         SET deducted_at = NULL, status = 'approved', updated_by = $2, updated_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'deducted'
         RETURNING id, loan_id, to_char(month,'YYYY-MM') AS month, type, amount, status, deducted_at`,
        [ids, by]
      );
      return result.rows;
    });

    if (!updated.length) return res.status(409).json({ success: false, message: "No deducted rows to undo." });
    logDeduction(req, "update", updated[0].loan_id, {
      stage: "deduct_undo",
      ids: updated.map((r) => r.id),
      old_values: { status: "deducted" },
      new_values: { status: "approved" },
    });
    return res.json({ success: true, message: "Deduction undone.", data: updated });
  } catch (err) {
    console.error("[HRMS] undoLoanDeductions:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function approveLoanDeductions(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => n > 0) : [];
    const id = Number(req.body?.id);
    const target = ids.length ? ids : id ? [id] : [];
    if (!target.length) return res.status(400).json({ success: false, message: "id is required." });
    const remarks = requireRemark(req.body);
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });
    const by = auditUserName(req);

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE ${LD}
         SET approved_by = $2, approved_at = NOW(), approved_remarks = $3, status = 'approved',
             updated_by = $2, updated_at = NOW()
         WHERE id = ANY($1::int[]) AND ${EXTRA_SQL} AND status = 'pending'
         RETURNING id, loan_id, emp_dcode, type, amount, remarks, status`,
        [target, by, remarks]
      );
      return result.rows;
    });

    if (!updated.length) return res.status(409).json({ success: false, message: "Only pending extra deduction can be approved." });
    logDeduction(req, "approve", updated[0].loan_id || updated[0].id, { stage: "approve", ids: updated.map((r) => r.id) }, updated[0]);
    return res.json({ success: true, message: "Approved.", data: updated });
  } catch (err) {
    console.error("[HRMS] approveLoanDeductions:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

/** Extra / other types only — loan and advance come from Loan module. */
export async function addLoanExtraDeduction(req, res) {
  try {
    const type = String(req.body?.type || "extra").trim().toLowerCase();
    if (type === "loan" || type === "advance") {
      return res.status(400).json({ success: false, message: "Loan / advance is created from Loan module." });
    }
    const loanId = Number(req.body?.loan_id) || null;
    const month = monthDate(req.body?.month);
    const amount = fromPaise(toPaise(req.body?.amount));
    const remarks = String(req.body?.remarks || req.body?.remark || "").trim();

    if (!month) return res.status(400).json({ success: false, message: "Month is required." });
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "Valid amount is required." });
    if (amount > HRMS_LOAN_AMOUNT.MAX) return res.status(400).json({ success: false, message: "Amount too large." });
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });

    const map = await empMap();
    let dcode = empDcode(req.body?.emp_dcode);
    if (loanId) {
      const loan = await getById(loanId, map);
      if (!loan) return res.status(404).json({ success: false, message: "Loan not found." });
      dcode = dcode || empDcode(loan.emp_dcode);
    }
    if (!dcode) return res.status(400).json({ success: false, message: "Employee is required." });
    if (!map.has(dcode)) return res.status(404).json({ success: false, message: "Employee not found." });
    const by = auditUserName(req);

    const row = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${LD} (loan_id, emp_dcode, month, type, amount, remarks, created_by, status)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        [loanId, dcode, month, type || "extra", amount, remarks, by]
      );
      const full = await client.query(`SELECT ${DEDUCTION_COLS} FROM ${LD} d WHERE d.id = $1`, [result.rows[0].id]);
      return full.rows[0];
    });

    logDeduction(req, "create", loanId || row.id, { stage: "extra", id: row.id, emp_dcode: dcode, amount }, row);
    return res.status(201).json({ success: true, message: "Deduction added.", data: formatDeduction(row, map) });
  } catch (err) {
    console.error("[HRMS] addLoanExtraDeduction:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteLoanExtraDeduction(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });

    const deleted = await withTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM ${LD}
         WHERE id = $1 AND ${EXTRA_SQL} AND status = 'pending'
         RETURNING id, loan_id, emp_dcode, to_char(month,'YYYY-MM') AS month, type, amount, remarks`,
        [id]
      );
      return result.rows[0] || null;
    });

    if (!deleted) return res.status(409).json({ success: false, message: "Only pending extra deduction can be deleted." });
    logDeduction(req, "delete", deleted.loan_id || deleted.id, { stage: "extra_delete", id: deleted.id, old_values: deleted }, deleted);
    return res.json({ success: true, message: "Extra deduction deleted.", data: deleted });
  } catch (err) {
    console.error("[HRMS] deleteLoanExtraDeduction:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateLoanExtraDeduction(req, res) {
  try {
    const id = Number(req.body?.id);
    const month = monthDate(req.body?.month);
    const amount = fromPaise(toPaise(req.body?.amount));
    const remarks = String(req.body?.remarks || req.body?.remark || "").trim();

    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    if (!month) return res.status(400).json({ success: false, message: "Month is required." });
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "Valid amount is required." });
    if (amount > HRMS_LOAN_AMOUNT.MAX) return res.status(400).json({ success: false, message: "Amount too large." });
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });

    const map = await empMap();
    const by = auditUserName(req);
    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE ${LD}
         SET month = $2::date, amount = $3, remarks = $4, updated_by = $5, updated_at = NOW()
         WHERE id = $1 AND ${EXTRA_SQL} AND status = 'pending'
         RETURNING id`,
        [id, month, amount, remarks, by]
      );
      if (!result.rows[0]) return null;
      const full = await client.query(`SELECT ${DEDUCTION_COLS} FROM ${LD} d WHERE d.id = $1`, [result.rows[0].id]);
      return full.rows[0];
    });

    if (!updated) return res.status(409).json({ success: false, message: "Only pending extra deduction can be edited." });
    logDeduction(req, "update", updated.loan_id || updated.id, { stage: "extra_update", id: updated.id, amount }, updated);
    return res.json({ success: true, message: "Extra deduction updated.", data: formatDeduction(updated, map) });
  } catch (err) {
    console.error("[HRMS] updateLoanExtraDeduction:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
