import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";

const LN = T.LOAN;
const logLoan = createHrmsActivityLogger("hrms_loan");

const COLS = `
  id, emp_dcode, type, amount::float AS amount, emi_months,
  to_char(start_month, 'YYYY-MM-DD') AS start_month, reason,
  sup_by, ${istTs("sup_at")} AS sup_at,
  hr_by, ${istTs("hr_at")} AS hr_at,
  created_by, updated_by,
  ${istTs("created_at")} AS created_at,
  ${istTs("updated_at")} AS updated_at
`;

function empDcode(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function startMonth(v) {
  const m = String(v ?? "").trim().match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? `${m[1]}-${m[2]}-01` : null;
}

function emiAmt(amount, months) {
  return months > 0 ? Math.round((amount / months) * 100) / 100 : 0;
}

function schedule(amount, months, start) {
  const sm = startMonth(start);
  if (!sm || !months) return [];
  const [y0, m0] = sm.split("-").map(Number);
  const base = emiAmt(amount, months);
  let sum = 0;
  const rows = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y0, m0 - 1 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const amt = i === months - 1 ? Math.round((amount - sum) * 100) / 100 : base;
    sum = Math.round((sum + amt) * 100) / 100;
    rows.push({ month, amount: amt });
  }
  return rows;
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
  const status = row.sup_at && row.hr_at ? "approved" : row.sup_at ? "pending_hr" : "pending_manager";
  const amount = Number(row.amount) || 0;
  const months = Number(row.emi_months) || 0;
  return {
    ...row,
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
    status,
    status_display: status === "approved" ? "Approved" : status === "pending_hr" ? "Pending HR" : "Pending Supervisor",
    type_display: row.type === "advance" ? "Advance" : "Loan",
    emi_amount: emiAmt(amount, months),
    emi_schedule: schedule(amount, months, row.start_month),
    start_month_display: String(row.start_month || "").slice(0, 7),
    created_at_display: formatHrmsDateTime(row.created_at),
  };
}

async function getById(id, map) {
  const rows = await dbQuery(`SELECT ${COLS} FROM ${LN} WHERE id = $1`, [id]);
  return rows[0] ? formatRow(rows[0], map) : null;
}

async function parseBody(body, excludeId = null) {
  const dcode = empDcode(body.emp_dcode);
  const type = String(body.type ?? "").trim().toLowerCase();
  const amount = Number(body.amount);
  const months = type === "advance" ? 1 : Number(body.emi_months);
  const month = startMonth(body.start_month);
  const reason = String(body.reason ?? "").trim();

  if (!dcode) return { error: "Employee is required." };
  if (type !== "loan" && type !== "advance") return { error: "Type (loan/advance) is required." };
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Valid amount is required." };
  if (!Number.isFinite(months) || months < 1 || !Number.isInteger(months)) return { error: "EMI months is required." };
  if (!month) return { error: "Start month is required." };
  if (!reason) return { error: "Reason is required." };

  const params = [dcode];
  let sql = `SELECT id FROM ${LN} WHERE emp_dcode = $1 AND (sup_at IS NULL OR hr_at IS NULL)`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }
  if ((await dbQuery(`${sql} LIMIT 1`, params))[0]) {
    return { error: "Employee already has a pending loan/advance." };
  }

  return { dcode, type, amount: Math.round(amount * 100) / 100, months, month, reason };
}

export async function listLoan(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const map = await empMap();
    const where = [];
    const params = [];
    let p = 1;

    const dcode = empDcode(filters?.emp_dcode);
    if (dcode) {
      where.push(`l.emp_dcode = $${p++}`);
      params.push(dcode);
    }
    const type = String(filters?.type ?? "").trim().toLowerCase();
    if (type === "loan" || type === "advance") {
      where.push(`l.type = $${p++}`);
      params.push(type);
    }
    const status = String(filters?.status ?? "").trim().toLowerCase();
    if (status === "approved") where.push(`l.sup_at IS NOT NULL AND l.hr_at IS NOT NULL`);
    else if (status === "pending_hr") where.push(`l.sup_at IS NOT NULL AND l.hr_at IS NULL`);
    else if (status === "pending_manager") where.push(`l.sup_at IS NULL`);

    const search = String(filters?.search ?? bodySearch ?? "").trim();
    if (search) {
      const dcodes = [];
      for (const [d, emp] of map) {
        if ([emp.emp_code, emp.emp_name, emp.deptname].join(" ").toLowerCase().includes(search.toLowerCase())) dcodes.push(d);
      }
      const parts = [`l.reason ILIKE $${p}`, `l.type ILIKE $${p}`];
      params.push(`%${search}%`);
      p += 1;
      if (dcodes.length) {
        parts.push(`l.emp_dcode = ANY($${p++}::int[])`);
        params.push(dcodes);
      }
      where.push(`(${parts.join(" OR ")})`);
    }

    const whereSql = where.length ? where.join(" AND ") : "TRUE";
    const [{ total }] = await dbQuery(`SELECT COUNT(*)::int AS total FROM ${LN} l WHERE ${whereSql}`, params);
    const rows = await dbQuery(
      `SELECT ${COLS} FROM ${LN} l WHERE ${whereSql} ORDER BY l.start_month DESC, l.id DESC LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    return res.json({ success: true, data: rows.map((r) => formatRow(r, map)), total: total ?? 0, page, limit });
  } catch (err) {
    console.error("[HRMS] listLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitLoan(req, res) {
  try {
    const parsed = await parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const map = await empMap();
    if (!map.has(parsed.dcode)) return res.status(404).json({ success: false, message: "Employee not found." });

    const rows = await dbQuery(
      `INSERT INTO ${LN} (emp_dcode, type, amount, emi_months, start_month, reason, created_by)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING ${COLS}`,
      [parsed.dcode, parsed.type, parsed.amount, parsed.months, parsed.month, parsed.reason, auditUserName(req)]
    );
    const data = formatRow(rows[0], map);
    logLoan(req, "create", data.id, { type: parsed.type, emp_dcode: parsed.dcode }, data);
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
    if (existing.sup_at && existing.hr_at) return res.status(409).json({ success: false, message: "Approved loan cannot be edited." });

    const parsed = await parseBody(
      {
        emp_dcode: req.body?.emp_dcode ?? existing.emp_dcode,
        type: req.body?.type ?? existing.type,
        amount: req.body?.amount ?? existing.amount,
        emi_months: req.body?.emi_months ?? existing.emi_months,
        start_month: req.body?.start_month ?? existing.start_month,
        reason: req.body?.reason ?? existing.reason,
      },
      id
    );
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const rows = await dbQuery(
      `UPDATE ${LN} SET
         emp_dcode=$2, type=$3, amount=$4, emi_months=$5, start_month=$6::date, reason=$7,
         updated_by=$8, updated_at=NOW(), sup_by=NULL, sup_at=NULL, hr_by=NULL, hr_at=NULL
       WHERE id=$1 RETURNING ${COLS}`,
      [id, parsed.dcode, parsed.type, parsed.amount, parsed.months, parsed.month, parsed.reason, auditUserName(req)]
    );
    const data = formatRow(rows[0], map);
    logLoan(req, "update", data.id, { type: parsed.type, emp_dcode: parsed.dcode }, data);
    return res.json({ success: true, message: "Loan updated.", data });
  } catch (err) {
    console.error("[HRMS] updateLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyManagerLoan(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at) return res.status(409).json({ success: false, message: "Already approved by supervisor." });

    const rows = await dbQuery(`UPDATE ${LN} SET sup_by=$2, sup_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, auditUserName(req)]);
    const data = formatRow(rows[0], map);
    logLoan(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Supervisor approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyHrLoan(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!existing.sup_at) return res.status(409).json({ success: false, message: "Supervisor approval is required first." });
    if (existing.hr_at) return res.status(409).json({ success: false, message: "Already approved by HR." });

    const rows = await dbQuery(`UPDATE ${LN} SET hr_by=$2, hr_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, auditUserName(req)]);
    const data = formatRow(rows[0], map);
    logLoan(req, "approve", data.id, { stage: "hr_approve" }, data);
    return res.json({ success: true, message: "HR approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyHrLoan:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
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
