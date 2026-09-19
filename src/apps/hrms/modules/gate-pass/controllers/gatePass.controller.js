import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { formatHrmsDate, formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs } from "../../../lib/attendanceCommon.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";
import { resolveGatePassOutIn } from "../../../lib/gatePassTime.js";

const ENTITY = "hrms_gate_pass";
const GP = T.GATE_PASS;
const logGatePass = createHrmsActivityLogger(ENTITY);

const GP_RETURN = `
  id, emp_dcode, pass_type, to_char(pass_date, 'YYYY-MM-DD') AS pass_date,
  ${istTs("out_time")} AS out_time,
  ${istTs("in_time")} AS in_time,
  reason,
  sup_by, ${istTs("sup_at")} AS sup_at,
  hr_by, ${istTs("hr_at")} AS hr_at,
  created_by, updated_by,
  ${istTs("created_at")} AS created_at,
  ${istTs("updated_at")} AS updated_at
`;

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

/** Industry flow: Supervisor/HOD → HR → gate (both stamps = approved). */
function gatePassStatus(row) {
  if (row?.sup_at && row?.hr_at) return "approved";
  if (row?.sup_at) return "pending_hr";
  return "pending_manager";
}

function statusDisplay(status) {
  if (status === "approved") return "Approved";
  if (status === "pending_hr") return "Pending HR";
  return "Pending Supervisor";
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

function formatRow(row, byDcode) {
  if (!row) return row;
  const merged = byDcode ? attachEmp(row, byDcode) : row;
  const status = gatePassStatus(merged);
  return {
    ...merged,
    duration: formatDuration(merged.out_time, merged.in_time),
    status,
    status_display: statusDisplay(status),
    pass_type_display: passTypeDisplay(merged.pass_type),
    pass_date_display: formatHrmsDate(merged.pass_date),
    out_time_display: formatHrmsDateTime(merged.out_time),
    in_time_display: formatHrmsDateTime(merged.in_time),
    sup_at_display: formatHrmsDateTime(merged.sup_at),
    hr_at_display: formatHrmsDateTime(merged.hr_at),
    created_at_display: formatHrmsDateTime(merged.created_at),
    updated_at_display: formatHrmsDateTime(merged.updated_at),
  };
}

function normalizePassType(value, fallback = "personal") {
  const v = String(value ?? "").trim().toLowerCase();
  return v || fallback;
}

function isFullyApproved(row) {
  return Boolean(row?.sup_at && row?.hr_at);
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

    const where = [];
    const params = [];
    let p = 1;

    if (empDcode) {
      where.push(`g.emp_dcode = $${p++}`);
      params.push(empDcode);
    }
    if (fromDate) {
      where.push(`g.pass_date >= $${p++}::date`);
      params.push(fromDate);
    }
    if (toDate) {
      where.push(`g.pass_date <= $${p++}::date`);
      params.push(toDate);
    }
    if (passTypeFilter) {
      where.push(`LOWER(g.pass_type) = $${p++}`);
      params.push(passTypeFilter);
    }
    if (statusFilter === "approved") {
      where.push(`g.sup_at IS NOT NULL AND g.hr_at IS NOT NULL`);
    } else if (statusFilter === "pending_hr" || statusFilter === "pending") {
      where.push(`g.sup_at IS NOT NULL AND g.hr_at IS NULL`);
    } else if (statusFilter === "pending_manager") {
      where.push(`g.sup_at IS NULL`);
    }
    if (search) {
      const dcodes = matchingDcodes(byDcode, search);
      const parts = [
        `g.reason ILIKE $${p}`,
        `g.pass_type ILIKE $${p}`,
        `COALESCE(g.hr_by, '') ILIKE $${p}`,
        `COALESCE(g.sup_by, '') ILIKE $${p}`,
      ];
      params.push(`%${search}%`);
      p += 1;
      if (dcodes.length) {
        parts.push(`g.emp_dcode = ANY($${p++}::int[])`);
        params.push(dcodes);
      }
      where.push(`(${parts.join(" OR ")})`);
    }

    const whereSql = where.length ? where.join(" AND ") : "TRUE";
    const countRows = await dbQuery(`SELECT COUNT(*)::int AS total FROM ${GP} g WHERE ${whereSql}`, params);
    const rows = await dbQuery(
      `
      SELECT ${GP_RETURN}
      FROM ${GP} g
      WHERE ${whereSql}
      ORDER BY g.pass_date DESC, g.out_time DESC, g.id DESC
      LIMIT $${p++} OFFSET $${p++}
      `,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      data: rows.map((row) => formatRow(row, byDcode)),
      total: countRows[0]?.total ?? 0,
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
      VALUES ($1,$2,$3::date,$4::timestamptz,$5::timestamptz,$6,$7)
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
      body.in_time ?? existing.in_time
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
        pass_date = $4::date,
        out_time = $5::timestamptz,
        in_time = $6::timestamptz,
        reason = $7,
        updated_by = $8,
        updated_at = NOW(),
        sup_by = NULL,
        sup_at = NULL,
        hr_by = NULL,
        hr_at = NULL
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

export async function verifyHrGatePass(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!existing.sup_at) {
      return res.status(409).json({ success: false, message: "Supervisor approval is required first." });
    }
    if (existing.hr_at) return res.status(409).json({ success: false, message: "Already approved by HR." });
    if (isFullyApproved(existing)) return res.status(409).json({ success: false, message: "Already fully approved." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      UPDATE ${GP}
      SET hr_by = $2, hr_at = NOW()
      WHERE id = $1
      RETURNING ${GP_RETURN}
      `,
      [id, userName]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "approve", data.id, { stage: "hr_approve" }, data);
    return res.json({ success: true, message: "HR approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyHrGatePass:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function verifyManagerGatePass(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const byDcode = await loadMasterMap();
    const existing = await getGatePassById(id, byDcode);
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (existing.sup_at) {
      return res.status(409).json({ success: false, message: "Already approved by supervisor." });
    }
    if (isFullyApproved(existing)) return res.status(409).json({ success: false, message: "Already fully approved." });

    const userName = auditUserName(req);
    const rows = await dbQuery(
      `
      UPDATE ${GP}
      SET sup_by = $2, sup_at = NOW()
      WHERE id = $1
      RETURNING ${GP_RETURN}
      `,
      [id, userName]
    );

    const data = formatRow(rows[0], byDcode);
    logGatePass(req, "approve", data.id, { stage: "sup_approve" }, data);
    return res.json({ success: true, message: "Supervisor approval done.", data });
  } catch (err) {
    console.error("[HRMS] verifyManagerGatePass:", err);
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
