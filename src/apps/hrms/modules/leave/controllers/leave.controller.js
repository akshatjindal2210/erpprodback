import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDate, formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";

const LR = T.LEAVE;
const logLeave = createHrmsActivityLogger("hrms_leave");
const TYPES = { CL: "CL — Casual Leave", SL: "SL — Sick Leave", PL: "PL — Privilege Leave" };

const COLS = `
  id, emp_dcode, leave_type,
  to_char(from_date, 'YYYY-MM-DD') AS from_date,
  to_char(to_date, 'YYYY-MM-DD') AS to_date,
  days::float AS days, reason,
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

function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
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
  return {
    ...row,
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
    status,
    status_display: status === "approved" ? "Approved" : status === "pending_hr" ? "Pending HR" : "Pending Supervisor",
    leave_type_display: TYPES[row.leave_type] || row.leave_type,
    from_date_display: formatHrmsDate(row.from_date),
    to_date_display: formatHrmsDate(row.to_date),
    created_at_display: formatHrmsDateTime(row.created_at),
  };
}

async function getById(id, map) {
  const rows = await dbQuery(`SELECT ${COLS} FROM ${LR} WHERE id = $1`, [id]);
  return rows[0] ? formatRow(rows[0], map) : null;
}

/** Parse + minimal checks: required, past date, overlap. */
async function parseBody(body, excludeId = null) {
  const dcode = empDcode(body.emp_dcode);
  const type = String(body.leave_type ?? "").trim().toUpperCase();
  const from = String(body.from_date ?? "").slice(0, 10);
  const to = String(body.to_date ?? "").slice(0, 10);
  const reason = String(body.reason ?? "").trim();
  const today = todayIst();

  if (!dcode) return { error: "Employee is required." };
  if (!TYPES[type]) return { error: "Leave type is required." };
  if (!from || !to) return { error: "From and to dates are required." };
  if (from < today || to < today) return { error: "Past dates are not allowed." };
  if (to < from) return { error: "To date cannot be before from date." };
  if (!reason) return { error: "Reason is required." };

  const params = [dcode, from, to];
  let sql = `SELECT id FROM ${LR} WHERE emp_dcode = $1 AND from_date <= $3::date AND to_date >= $2::date`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }
  if ((await dbQuery(`${sql} LIMIT 1`, params))[0]) {
    return { error: "Leave already exists for overlapping dates." };
  }

  return { dcode, type, from, to, days: daysBetween(from, to), reason };
}

export async function listLeave(req, res) {
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
    const type = String(filters?.leave_type ?? "").trim().toUpperCase();
    if (TYPES[type]) {
      where.push(`l.leave_type = $${p++}`);
      params.push(type);
    }
    const status = String(filters?.status ?? "").trim().toLowerCase();
    if (status === "approved") where.push(`l.sup_at IS NOT NULL AND l.hr_at IS NOT NULL`);
    else if (status === "pending_hr") where.push(`l.sup_at IS NOT NULL AND l.hr_at IS NULL`);
    else if (status === "pending_manager") where.push(`l.sup_at IS NULL`);

    const search = String(filters?.search ?? bodySearch ?? "").trim();
    if (search) {
      const q = `%${search}%`;
      const dcodes = [];
      for (const [d, emp] of map) {
        if ([emp.emp_code, emp.emp_name, emp.deptname].join(" ").toLowerCase().includes(search.toLowerCase())) {
          dcodes.push(d);
        }
      }
      const parts = [`l.reason ILIKE $${p}`, `l.leave_type ILIKE $${p}`];
      params.push(q);
      p += 1;
      if (dcodes.length) {
        parts.push(`l.emp_dcode = ANY($${p++}::int[])`);
        params.push(dcodes);
      }
      where.push(`(${parts.join(" OR ")})`);
    }

    const whereSql = where.length ? where.join(" AND ") : "TRUE";
    const [{ total }] = await dbQuery(`SELECT COUNT(*)::int AS total FROM ${LR} l WHERE ${whereSql}`, params);
    const rows = await dbQuery(
      `SELECT ${COLS} FROM ${LR} l WHERE ${whereSql} ORDER BY l.from_date DESC, l.id DESC LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    return res.json({ success: true, data: rows.map((r) => formatRow(r, map)), total: total ?? 0, page, limit });
  } catch (err) {
    console.error("[HRMS] listLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitLeave(req, res) {
  try {
    const parsed = await parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const map = await empMap();
    if (!map.has(parsed.dcode)) return res.status(404).json({ success: false, message: "Employee not found." });

    const rows = await dbQuery(
      `INSERT INTO ${LR} (emp_dcode, leave_type, from_date, to_date, days, reason, created_by)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7) RETURNING ${COLS}`,
      [parsed.dcode, parsed.type, parsed.from, parsed.to, parsed.days, parsed.reason, auditUserName(req)]
    );
    const data = formatRow(rows[0], map);
    logLeave(req, "create", data.id, { leave_type: parsed.type, emp_dcode: parsed.dcode }, data);
    return res.status(201).json({ success: true, message: "Leave created.", data });
  } catch (err) {
    console.error("[HRMS] submitLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateLeave(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });

    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at && existing.hr_at) {
      return res.status(409).json({ success: false, message: "Approved leave cannot be edited." });
    }

    const parsed = await parseBody(
      {
        emp_dcode: req.body?.emp_dcode ?? existing.emp_dcode,
        leave_type: req.body?.leave_type ?? existing.leave_type,
        from_date: req.body?.from_date ?? existing.from_date,
        to_date: req.body?.to_date ?? existing.to_date,
        reason: req.body?.reason ?? existing.reason,
      },
      id
    );
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const rows = await dbQuery(
      `UPDATE ${LR} SET
         emp_dcode=$2, leave_type=$3, from_date=$4::date, to_date=$5::date, days=$6, reason=$7,
         updated_by=$8, updated_at=NOW(), sup_by=NULL, sup_at=NULL, hr_by=NULL, hr_at=NULL
       WHERE id=$1 RETURNING ${COLS}`,
      [id, parsed.dcode, parsed.type, parsed.from, parsed.to, parsed.days, parsed.reason, auditUserName(req)]
    );
    const data = formatRow(rows[0], map);
    logLeave(req, "update", data.id, { leave_type: parsed.type, emp_dcode: parsed.dcode }, data);
    return res.json({ success: true, message: "Leave updated.", data });
  } catch (err) {
    console.error("[HRMS] updateLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyManagerLeave(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at) return res.status(409).json({ success: false, message: "Already approved by supervisor." });

    const rows = await dbQuery(`UPDATE ${LR} SET sup_by=$2, sup_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [
      id,
      auditUserName(req),
    ]);
    const data = formatRow(rows[0], map);
    logLeave(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Supervisor approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyHrLeave(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!existing.sup_at) return res.status(409).json({ success: false, message: "Supervisor approval is required first." });
    if (existing.hr_at) return res.status(409).json({ success: false, message: "Already approved by HR." });

    const rows = await dbQuery(`UPDATE ${LR} SET hr_by=$2, hr_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [
      id,
      auditUserName(req),
    ]);
    const data = formatRow(rows[0], map);
    logLeave(req, "approve", data.id, { stage: "hr_approve" }, data);
    return res.json({ success: true, message: "HR approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyHrLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteLeave(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const map = await empMap();
    const existing = await getById(id, map);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    await dbQuery(`DELETE FROM ${LR} WHERE id = $1`, [id]);
    logLeave(req, "delete", existing.id, null, existing);
    return res.json({ success: true, message: "Deleted.", data: existing });
  } catch (err) {
    console.error("[HRMS] deleteLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
