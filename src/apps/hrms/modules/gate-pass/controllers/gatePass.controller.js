import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T, MST_TABLES as M } from "../../../../../config/db/dbTables.js";
import { getCachedPermissions, setCachedPermissions } from "../../../../../config/auth/permissionCache.js";
import { moduleSortOrderNumericExpr } from "../../../../../platform/utils/config/moduleSortOrderSql.js";
import { extractHrmsListParams, addIn, whereSql } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDate, formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";
import { resolveGatePassOutIn } from "../../../lib/gatePassTime.js";

const MODULE_SORT_ORDER = moduleSortOrderNumericExpr("m");

const ENTITY = "hrms_gate_pass";
const GP = T.GATE_PASS;
const logGatePass = createHrmsActivityLogger(ENTITY);

function hasGatePassSupervisorPermission(user) {
  const role = String(user?.type || user?.role || "").toLowerCase().trim();
  if (role === "super_admin") return true;
  const raw = user?.special_permissions;
  const perms = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : (raw || {});
  return Boolean(perms?.hrms?.gate_pass_supervisor);
}

const GP_RETURN = `
  id, emp_dcode, pass_type, to_char(pass_date, 'YYYY-MM-DD') AS pass_date,
  ${istTs("out_time")} AS out_time,
  ${istTs("in_time")} AS in_time,
  reason,
  sup_by, ${istTs("sup_at")} AS sup_at, sup_remarks,
  approved_by, ${istTs("approved_at")} AS approved_at, approved_remarks,
  ${istTs("out_at")} AS out_at, out_by,
  ${istTs("in_at")} AS in_at, in_by,
  created_by, updated_by,
  ${istTs("created_at")} AS created_at,
  ${istTs("updated_at")} AS updated_at
`;

function requireRemark(body) {
  const remarks = String(body?.remarks || body?.sup_remarks || body?.approved_remarks || "").trim();
  return remarks || null;
}

function ymd(value) {
  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseEmpDcode(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatDuration(outTime, inTime) {
  const out = Date.parse(outTime);
  const inn = Date.parse(inTime);
  if (!Number.isFinite(out) || !Number.isFinite(inn) || inn <= out) return null;
  const mins = Math.round((inn - out) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Team head / manager → Approve → gate (both stamps = approved). */
function gatePassStatus(row) {
  if (row?.sup_at && row?.approved_at) return "approved";
  if (row?.sup_at) return "pending_approve";
  return "pending_manager";
}

function statusDisplay(status) {
  if (status === "approved") return "Approved";
  if (status === "pending_approve") return "Pending Approve";
  return "Pending Manager";
}

function passTypeDisplay(value) {
  const s = String(value ?? "").trim();
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function loadMasterMap() {
  const rows = await fetchEmpMaster({});
  const byDcode = new Map();
  for (const row of rows) {
    const dcode = parseEmpDcode(row.emp_dcode);
    if (dcode) byDcode.set(dcode, row);
  }
  return byDcode;
}

function attachEmp(row, byDcode) {
  const emp = byDcode.get(parseEmpDcode(row.emp_dcode));
  return {
    ...row,
    emp_code: emp?.emp_code ?? "",
    emp_name: emp?.emp_name ?? "",
    deptname: emp?.deptname ?? "",
  };
}

function parseGatePassId(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatRow(row, byDcode) {
  if (!row) return row;
  const merged = byDcode ? attachEmp(row, byDcode) : row;
  const pk = parseGatePassId(merged?.id);
  const status = gatePassStatus(merged);
  const movement = merged.in_at ? "returned" : merged.out_at ? "out" : "";
  return {
    ...merged,
    id: pk,
    gate_pass_id: pk,
    duration: formatDuration(merged.out_time, merged.in_time),
    status,
    status_display: statusDisplay(status),
    movement,
    movement_display: movement === "returned" ? "Returned" : movement === "out" ? "Out" : "—",
    pass_type_display: passTypeDisplay(merged.pass_type),
    pass_date_display: formatHrmsDate(merged.pass_date),
    out_time_display: formatHrmsDateTime(merged.out_time),
    in_time_display: formatHrmsDateTime(merged.in_time),
    gone_at_display: formatHrmsDateTime(merged.out_at),
    returned_at_display: formatHrmsDateTime(merged.in_at),
    sup_at_display: formatHrmsDateTime(merged.sup_at),
    approved_at_display: formatHrmsDateTime(merged.approved_at),
    created_at_display: formatHrmsDateTime(merged.created_at),
    updated_at_display: formatHrmsDateTime(merged.updated_at),
  };
}

function normalizePassType(value, fallback = "personal") {
  const v = String(value ?? "").trim().toLowerCase();
  return v || fallback;
}

function isFullyApproved(row) {
  return Boolean(row?.sup_at && row?.approved_at);
}

async function loadUserPermissions(userId) {
  let permissions = getCachedPermissions(userId);
  if (!permissions) {
    permissions = await dbQuery(
      `SELECT up.can_view, up.can_authorize, m.name AS module_name
       FROM ${M.USER_PERMISSIONS} up
       JOIN ${M.MODULES} m ON m.id = up.module_id
       WHERE up.user_id = $1 AND up.is_deleted = false AND m.is_active = true
       ORDER BY ${MODULE_SORT_ORDER} ASC`,
      [userId]
    );
    setCachedPermissions(userId, permissions || []);
  }
  return permissions || [];
}

function moduleCan(permissions, moduleName, action) {
  const row = permissions.find((p) => p.module_name === moduleName);
  if (!row) return false;
  if (action === "view") return Boolean(row.can_view);
  if (action === "authorize") return Boolean(row.can_authorize);
  return false;
}

function isPassEmployee(req, pass, byDcode) {
  const emp = byDcode.get(parseEmpDcode(pass?.emp_dcode));
  const code = String(emp?.emp_code ?? "").trim().toLowerCase();
  if (!code) return false;
  const u = req.user || {};
  const keys = [u.usercode, u.username, u.name].map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
  return keys.includes(code);
}

async function canViewGatePass(req, pass, byDcode) {
  const role = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
  if (role === "super_admin") return true;
  if (hasGatePassSupervisorPermission(req.user)) return true;

  const perms = await loadUserPermissions(req.user.id);
  if (moduleCan(perms, "gate_entry", "view")) return true;
  if (moduleCan(perms, "hrms_gate_pass", "authorize")) return true;

  const actor = String(auditUserName(req) || "").trim();
  if (actor && (actor === String(pass?.sup_by || "").trim() || actor === String(pass?.approved_by || "").trim())) {
    return true;
  }
  return isPassEmployee(req, pass, byDcode);
}

function matchingDcodes(byDcode, search) {
  const q = String(search ?? "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const [dcode, emp] of byDcode) {
    const hay = [emp.emp_code, emp.emp_name, emp.deptname].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(q)) out.push(dcode);
  }
  return out;
}

async function getGatePassById(id, byDcode = null) {
  const master = byDcode || (await loadMasterMap());
  const rows = await dbQuery(`SELECT ${GP_RETURN} FROM ${GP} WHERE id = $1`, [id]);
  return rows[0] ? formatRow(rows[0], master) : null;
}

export async function listGatePass(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const empDcode = parseEmpDcode(filters?.emp_dcode);
    const fromDate = ymd(filters?.from_date ?? filters?.fromDate);
    const toDate = ymd(filters?.to_date ?? filters?.toDate);
    const search = String(filters?.search ?? bodySearch ?? "").trim();
    const passTypeFilter = String(filters?.pass_type ?? "").trim().toLowerCase();
    const statusFilter = String(filters?.status ?? filters?.approval_status ?? "").trim().toLowerCase();
    const byDcode = await loadMasterMap();

    const parts = [];
    const params = [];

    if (empDcode) {
      params.push(empDcode);
      parts.push(`emp_dcode = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      parts.push(`pass_date >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      parts.push(`pass_date <= $${params.length}`);
    }
    if (passTypeFilter) {
      params.push(passTypeFilter);
      parts.push(`LOWER(pass_type) = $${params.length}`);
    }
    if (statusFilter === "approved") {
      parts.push(`sup_at IS NOT NULL AND approved_at IS NOT NULL`);
    } else if (statusFilter === "pending_approve" || statusFilter === "pending_hr" || statusFilter === "pending") {
      parts.push(`sup_at IS NOT NULL AND approved_at IS NULL`);
    } else if (statusFilter === "pending_manager") {
      parts.push(`sup_at IS NULL`);
    }
    if (search) {
      params.push(`%${search}%`);
      const searchParts = [`reason ILIKE $${params.length}`];
      addIn(searchParts, params, "emp_dcode", matchingDcodes(byDcode, search));
      parts.push(`(${searchParts.join(" OR ")})`);
    }

    const where = whereSql(parts);
    const countRows = await dbQuery(`SELECT COUNT(*) AS total FROM ${GP} ${where}`, params);
    params.push(limit, offset);
    const rows = await dbQuery(
      `SELECT ${GP_RETURN} FROM ${GP} ${where} ORDER BY pass_date DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: rows.map((row) => formatRow(row, byDcode)),
      total: Number(countRows[0]?.total ?? 0),
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] listGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitGatePass(req, res) {
  try {
    const body = req.body || {};
    const empDcode = parseEmpDcode(body.emp_dcode);
    const reason = String(body.reason ?? "").trim();
    const passType = normalizePassType(body.pass_type);
    const timeResolved = resolveGatePassOutIn(body.pass_date, body.out_time, body.in_time);
    if (!timeResolved.ok) {
      return res.status(400).json({ success: false, message: timeResolved.message });
    }
    const { passDate, outTime, inTime } = timeResolved;

    if (!empDcode) return res.status(400).json({ success: false, message: "Employee is required." });
    if (!reason) return res.status(400).json({ success: false, message: "Reason is required." });

    const byDcode = await loadMasterMap();
    if (!byDcode.has(empDcode)) return res.status(404).json({ success: false, message: "Employee not found." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      INSERT INTO ${GP} (emp_dcode, pass_type, pass_date, out_time, in_time, reason, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING ${GP_RETURN}
      `,
      [empDcode, passType, passDate, outTime, inTime, reason, userName]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "create", data.id, { pass_type: passType, emp_dcode: empDcode }, data);
    return res.status(201).json({ success: true, message: "Gate pass created.", data });
  } catch (err) {
    console.error("[HRMS] submitGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateGatePass(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (isFullyApproved(existing)) {
      return res.status(409).json({ success: false, message: "Approved gate pass cannot be edited." });
    }

    const body = req.body || {};
    const empDcode = parseEmpDcode(body.emp_dcode ?? existing.emp_dcode);
    const reason = String(body.reason ?? existing.reason ?? "").trim();
    const passType = normalizePassType(body.pass_type ?? existing.pass_type);
    const timeResolved = resolveGatePassOutIn(
      body.pass_date ?? existing.pass_date,
      body.out_time ?? existing.out_time,
      body.in_time ?? existing.in_time,
      { existingPassDate: existing.pass_date }
    );
    if (!timeResolved.ok) {
      return res.status(400).json({ success: false, message: timeResolved.message });
    }
    const { passDate, outTime, inTime } = timeResolved;

    if (!empDcode) return res.status(400).json({ success: false, message: "Employee is required." });
    if (!byDcode.has(empDcode)) return res.status(404).json({ success: false, message: "Employee not found." });
    if (!reason) return res.status(400).json({ success: false, message: "Reason is required." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      UPDATE ${GP}
      SET
        emp_dcode = $2,
        pass_type = $3,
        pass_date = $4,
        out_time = $5,
        in_time = $6,
        reason = $7,
        updated_by = $8,
        updated_at = NOW(),
        sup_by = NULL,
        sup_at = NULL,
        sup_remarks = NULL,
        approved_by = NULL,
        approved_at = NULL,
        approved_remarks = NULL
      WHERE id = $1
      RETURNING ${GP_RETURN}
      `,
      [id, empDcode, passType, passDate, outTime, inTime, reason, userName]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "update", data.id, { pass_type: passType, emp_dcode: empDcode }, data);
    return res.json({ success: true, message: "Gate pass updated.", data });
  } catch (err) {
    console.error("[HRMS] updateGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyApproveGatePass(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });
    const remarks = requireRemark(req.body);
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!existing.sup_at) {
      return res.status(409).json({ success: false, message: "Manager approval is required first." });
    }
    if (existing.approved_at) return res.status(409).json({ success: false, message: "Already approved." });
    if (isFullyApproved(existing)) return res.status(409).json({ success: false, message: "Already fully approved." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      UPDATE ${GP}
      SET approved_by = $2, approved_at = NOW(), approved_remarks = $3
      WHERE id = $1
      RETURNING ${GP_RETURN}
      `,
      [id, userName, remarks]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "approve", data.id, { stage: "approve" }, data);
    return res.json({ success: true, message: "Approved.", data });
  } catch (err) {
    console.error("[HRMS] verifyApproveGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyManagerGatePass(req, res) {
  try {
    if (!hasGatePassSupervisorPermission(req.user)) {
      return res.status(403).json({ success: false, message: "Manager permission required." });
    }
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });
    const remarks = requireRemark(req.body);
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at) {
      return res.status(409).json({ success: false, message: "Already approved by manager." });
    }
    if (isFullyApproved(existing)) return res.status(409).json({ success: false, message: "Already fully approved." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      UPDATE ${GP}
      SET sup_by = $2, sup_at = NOW(), sup_remarks = $3
      WHERE id = $1
      RETURNING ${GP_RETURN}
      `,
      [id, userName, remarks]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Manager approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

/** IMS gate scan: QR / input = gate pass id. 1st = OUT, 2nd = IN, 3rd = reject. */
export async function scanGatePass(req, res) {
  try {
    const id = parseGatePassId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid QR." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Invalid QR." });
    if (!isFullyApproved(existing)) {
      return res.status(409).json({ success: false, message: "Gate pass is not approved." });
    }
    if (existing.in_at) {
      return res.status(409).json({ success: false, message: "Gate pass already completed." });
    }

    const userName = auditUserName(req);
    const isOut = !existing.out_at;
    const updated = await dbQuery(
      isOut
        ? `UPDATE ${GP} SET out_at = NOW(), out_by = $2 WHERE id = $1 RETURNING ${GP_RETURN}`
        : `UPDATE ${GP} SET in_at = NOW(), in_by = $2 WHERE id = $1 RETURNING ${GP_RETURN}`,
      [existing.id, userName]
    );

    const data = formatRow(updated[0], byDcode);
    logGatePass(req, "update", data.id, { stage: isOut ? "gate_out" : "gate_in" }, data);
    return res.json({
      success: true,
      message: isOut ? "OUT recorded." : "IN recorded.",
      scan: isOut ? "out" : "in",
      data,
    });
  } catch (err) {
    console.error("[HRMS] scanGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function viewGatePass(req, res) {
  try {
    const id = parseGatePassId(req.body?.id ?? req.params?.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid gate pass." });

    const byDcode = await loadMasterMap();
    const pass = await getGatePassById(id, byDcode);
    if (!pass) return res.status(404).json({ success: false, message: "Gate pass not found." });

    if (!(await canViewGatePass(req, pass, byDcode))) {
      return res.status(403).json({ success: false, message: "You do not have access to view this gate pass." });
    }

    return res.json({ success: true, data: pass });
  } catch (err) {
    console.error("[HRMS] viewGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteGatePass(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    await dbQuery(`DELETE FROM ${GP} WHERE id = $1`, [id]);
    logGatePass(req, "delete", existing.id, null, existing);
    return res.json({ success: true, message: "Deleted.", data: existing });
  } catch (err) {
    console.error("[HRMS] deleteGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
