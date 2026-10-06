import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams, addIn, whereSql } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDate, formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";

const LR = T.LEAVE;
const logLeave = createHrmsActivityLogger("hrms_leave");
const TYPES = { CL: "CL — Casual Leave", SL: "SL — Sick Leave", PL: "PL — Privilege Leave" };

function hasHrmsManagerPermission(user) {
  const role = String(user?.type || user?.role || "").toLowerCase().trim();
  if (role === "super_admin") return true;
  const raw = user?.special_permissions;
  const perms = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : (raw || {});
  return Boolean(perms?.hrms?.gate_pass_supervisor);
}

const COLS = `
  id, emp_dcode, leave_type,
  to_char(from_date, 'YYYY-MM-DD') AS from_date,
  to_char(to_date, 'YYYY-MM-DD') AS to_date,
  days::float AS days, reason,
  sup_by, ${istTs("sup_at")} AS sup_at, sup_remarks,
  approved_by, ${istTs("approved_at")} AS approved_at, approved_remarks,
  created_by, updated_by,
  ${istTs("created_at")} AS created_at,
  ${istTs("updated_at")} AS updated_at
`;

function requireRemark(body) {
  const remarks = String(body?.remarks || body?.sup_remarks || body?.approved_remarks || "").trim();
  return remarks || null;
}

function empDcode(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function daysBetween(from, to, dayPart = "full") {
  if (String(dayPart).toLowerCase() === "half") {
    if (from !== to) return null;
    return 0.5;
  }
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
  const status = row.sup_at && row.approved_at ? "approved" : row.sup_at ? "pending_approve" : "pending_manager";
  return {
    ...row,
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
    status,
    status_display: status === "approved" ? "Approved" : status === "pending_approve" ? "Pending Approve" : "Pending Manager",
    leave_type_display: TYPES[row.leave_type] || row.leave_type,
    from_date_display: formatHrmsDate(row.from_date),
    to_date_display: formatHrmsDate(row.to_date),
    sup_at_display: formatHrmsDateTime(row.sup_at),
    approved_at_display: formatHrmsDateTime(row.approved_at),
    created_at_display: formatHrmsDateTime(row.created_at),
    updated_at_display: formatHrmsDateTime(row.updated_at),
  };
}

async function getById(id, map) {
  const rows = await dbQuery(`SELECT ${COLS} FROM ${LR} WHERE id = $1`, [id]);
  return rows[0] ? formatRow(rows[0], map) : null;
}

/** Parse + minimal checks: required, past date, overlap. */
async function parseBody(body, excludeId = null, opts = {}) {
  const dcode = empDcode(body.emp_dcode);
  const type = String(body.leave_type ?? "").trim().toUpperCase();
  const from = String(body.from_date ?? "").slice(0, 10);
  const to = String(body.to_date ?? "").slice(0, 10);
  const reason = String(body.reason ?? "").trim();
  const dayPart = String(body.day_part ?? "").trim().toLowerCase() === "half" ? "half" : "full";
  const today = todayIst();
  const existingFrom = String(opts.existing?.from_date ?? "").slice(0, 10);
  const existingTo = String(opts.existing?.to_date ?? "").slice(0, 10);

  if (!dcode) return { error: "Employee is required." };
  if (!TYPES[type]) return { error: "Leave type is required." };
  if (!from || !to) return { error: "From and to dates are required." };
  const toDate = dayPart === "half" ? from : to;
  const unchangedPast =
    Boolean(opts.existing) && from === existingFrom && toDate === existingTo && (from < today || toDate < today);
  if ((from < today || toDate < today) && !unchangedPast) {
    return { error: "Past dates are not allowed." };
  }
  if (to < from) return { error: "To date cannot be before from date." };
  if (dayPart === "half" && from !== to) return { error: "Half day must be same from/to date." };
  if (!reason) return { error: "Reason is required." };

  const days = daysBetween(from, toDate, dayPart);
  if (days == null) return { error: "Invalid leave days." };

  const params = [dcode, from, toDate];
  let sql = `SELECT id FROM ${LR} WHERE emp_dcode = $1 AND from_date <= $3 AND to_date >= $2`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }
  if ((await dbQuery(`${sql} LIMIT 1`, params))[0]) {
    return { error: "Leave already exists for overlapping dates." };
  }

  return { dcode, type, from, to: toDate, days, reason };
}

export async function listLeave(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const map = await empMap();
    const parts = [];
    const params = [];

    const dcode = empDcode(filters?.emp_dcode);
    if (dcode) {
      params.push(dcode);
      parts.push(`emp_dcode = $${params.length}`);
    }
    const type = String(filters?.leave_type ?? "").trim().toUpperCase();
    if (TYPES[type]) {
      params.push(type);
      parts.push(`leave_type = $${params.length}`);
    }
    const status = String(filters?.status ?? "").trim().toLowerCase();
    if (status === "approved") parts.push(`sup_at IS NOT NULL AND approved_at IS NOT NULL`);
    else if (status === "pending_approve" || status === "pending_hr") parts.push(`sup_at IS NOT NULL AND approved_at IS NULL`);
    else if (status === "pending_manager") parts.push(`sup_at IS NULL`);

    const search = String(filters?.search ?? bodySearch ?? "").trim();
    if (search) {
      params.push(`%${search}%`);
      const searchParts = [`reason ILIKE $${params.length}`];
      const dcodes = [];
      for (const [d, emp] of map) {
        if ([emp.emp_code, emp.emp_name, emp.deptname].join(" ").toLowerCase().includes(search.toLowerCase())) {
          dcodes.push(d);
        }
      }
      addIn(searchParts, params, "emp_dcode", dcodes);
      parts.push(`(${searchParts.join(" OR ")})`);
    }

    const where = whereSql(parts);
    const countRows = await dbQuery(`SELECT COUNT(*) AS total FROM ${LR} ${where}`, params);
    params.push(limit, offset);
    const rows = await dbQuery(
      `SELECT ${COLS} FROM ${LR} ${where} ORDER BY from_date DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({
      success: true,
      data: rows.map((r) => formatRow(r, map)),
      total: Number(countRows[0]?.total ?? 0),
      page,
      limit,
    });
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
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
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
    if (existing.sup_at && existing.approved_at) {
      return res.status(409).json({ success: false, message: "Approved leave cannot be edited." });
    }

    const parsed = await parseBody(
      {
        emp_dcode: req.body?.emp_dcode ?? existing.emp_dcode,
        leave_type: req.body?.leave_type ?? existing.leave_type,
        from_date: req.body?.from_date ?? existing.from_date,
        to_date: req.body?.to_date ?? existing.to_date,
        reason: req.body?.reason ?? existing.reason,
        day_part: req.body?.day_part ?? (Number(existing.days) === 0.5 ? "half" : "full"),
      },
      id,
      { existing }
    );
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const rows = await dbQuery(
      `UPDATE ${LR} SET
         emp_dcode=$2, leave_type=$3, from_date=$4, to_date=$5, days=$6, reason=$7,
         updated_by=$8, updated_at=NOW(),
         sup_by=NULL, sup_at=NULL, sup_remarks=NULL,
         approved_by=NULL, approved_at=NULL, approved_remarks=NULL
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
      `UPDATE ${LR} SET sup_by=$2, sup_at=NOW(), sup_remarks=$3 WHERE id=$1 RETURNING ${COLS}`,
      [id, auditUserName(req), remarks]
    );
    const data = formatRow(rows[0], map);
    logLeave(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Manager approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerLeave:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyApproveLeave(req, res) {
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

    const rows = await dbQuery(
      `UPDATE ${LR} SET approved_by=$2, approved_at=NOW(), approved_remarks=$3 WHERE id=$1 RETURNING ${COLS}`,
      [id, auditUserName(req), remarks]
    );
    const data = formatRow(rows[0], map);
    logLeave(req, "approve", data.id, { stage: "approve" }, data);
    return res.json({ success: true, message: "Approved.", data });
  } catch (err) {
    console.error("[HRMS] verifyApproveLeave:", err);
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
