import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDate, formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logHrmsActivity } from "../../../lib/utils/activity/logHrmsActivity.js";
import { istTs, ATT_COL_IN, ATT_COL_OUT, ymd, parseEmpDcode, shiftDisplay, computeTotalMinutes, normalizeOtApprovedFlag, otDecisionLabel } from "../../../lib/attendanceCommon.js";

const ENTITY = "hrms_ot_approval";
const ATT = T.ATTENDANCE;
const COLS = `
  id, emp_dcode, name, shift, ot_minutes, ot_approved, ot_approved_by, ot_remarks,
  to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
  ${istTs(ATT_COL_IN)} AS "in",
  ${istTs(ATT_COL_OUT)} AS "out",
  ${istTs("ot_approved_at")} AS ot_approved_at
`;

function isSuperAdmin(user) {
  const role = String(user?.type || user?.role || "").toLowerCase().trim();
  return role === "super_admin";
}

function formatRow(row, byDcode) {
  const emp = byDcode?.get(parseEmpDcode(row.emp_dcode));
  const otApproved = normalizeOtApprovedFlag(row.ot_approved);
  return {
    id: row.id,
    emp_dcode: parseEmpDcode(row.emp_dcode),
    emp_code: emp?.emp_code || "",
    name: emp?.emp_name || row.name || "",
    attendance_date: row.attendance_date,
    attendance_date_display: formatHrmsDate(row.attendance_date),
    shift_display: shiftDisplay(row.shift) || "A",
    in_display: formatHrmsDateTime(row.in),
    out_display: formatHrmsDateTime(row.out),
    total_minutes: computeTotalMinutes(row),
    ot_minutes: row.ot_minutes != null ? Math.round(Number(row.ot_minutes)) : null,
    ot_approved: otApproved,
    ot_status: otApproved === 1 ? "approved" : otApproved === 2 ? "rejected" : "pending",
    ot_status_display: otDecisionLabel(otApproved),
    ot_approved_by_name: row.ot_approved_by || null,
    ot_approved_at: row.ot_approved_at || null,
    ot_remarks: row.ot_remarks || null,
  };
}

async function empMap() {
  const map = new Map();
  for (const emp of await fetchEmpMaster()) {
    const d = parseEmpDcode(emp.emp_dcode);
    if (d) map.set(d, emp);
  }
  return map;
}

export async function listOtApproval(req, res) {
  try {
    const { page, limit, offset, filters } = extractHrmsListParams(req.body);
    const fromDate = ymd(filters?.from_date ?? filters?.fromDate);
    const toDate = ymd(filters?.to_date ?? filters?.toDate);
    const filterDcode = parseEmpDcode(filters?.emp_dcode);
    const status = String(filters?.ot_status || "").toLowerCase();

    // Always honor filters when sent (FE "server" mode). FE "quick" mode omits them.
    const where = [`COALESCE(ot_minutes, 0) <> 0`];
    const params = [];
    if (fromDate) {
      params.push(fromDate);
      where.push(`attendance_date >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      where.push(`attendance_date <= $${params.length}::date`);
    }
    if (filterDcode) {
      params.push(filterDcode);
      where.push(`emp_dcode = $${params.length}`);
    }
    if (status === "approved") where.push(`COALESCE(ot_approved, 0) = 1`);
    else if (status === "rejected") where.push(`COALESCE(ot_approved, 0) = 2`);
    else if (status === "pending") where.push(`COALESCE(ot_minutes, 0) > 0 AND COALESCE(ot_approved, 0) = 0`);

    const rows = await dbQuery(
      `SELECT ${COLS} FROM ${ATT} WHERE ${where.join(" AND ")} ORDER BY name ASC, emp_dcode ASC, attendance_date DESC`,
      params
    );
    const byDcode = await empMap();
    const data = rows.map((r) => formatRow(r, byDcode));
    return res.json({ success: true, data: data.slice(offset, offset + limit), total: data.length, page, limit });
  } catch (err) {
    console.error("[HRMS] listOtApproval:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

async function decideOt(req, res, approved) {
  try {
    const id = Number(req.body?.id);
    const remarks = String(req.body?.ot_remarks || req.body?.remarks || "").trim();
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    if (!remarks) return res.status(400).json({ success: false, message: "Remark is required." });

    const existingRows = await dbQuery(
      `SELECT id, ot_minutes, ot_approved FROM ${ATT} WHERE id = $1`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });
    if (!(Number(existing.ot_minutes) > 0)) {
      return res.status(400).json({ success: false, message: "No overtime to decide." });
    }

    const current = normalizeOtApprovedFlag(existing.ot_approved);
    const next = approved ? 1 : 2;
    if (current === next) {
      return res.status(409).json({
        success: false,
        message: approved ? "Already approved." : "Already rejected.",
      });
    }
    if (current !== 0 && !isSuperAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only super admin can change an approved/rejected OT.",
      });
    }

    const rows = await dbQuery(
      `UPDATE ${ATT}
       SET ot_approved = $2,
           ot_approved_by = $3,
           ot_approved_at = NOW(),
           ot_remarks = $4,
           updated_by = $3,
           updated_at = NOW()
       WHERE id = $1
         AND COALESCE(ot_minutes, 0) > 0
       RETURNING ${COLS}`,
      [id, next, auditUserName(req), remarks]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: approved ? "Nothing to approve." : "Nothing to reject." });
    }

    const data = formatRow(rows[0], await empMap());
    await logHrmsActivity(req, {
      action: approved ? "approve" : "reject",
      entity: ENTITY,
      entity_id: id,
      record: data,
      details: current !== 0 ? { override: true, previous: current } : undefined,
    });
    return res.json({
      success: true,
      message: approved ? "OT approved." : "OT rejected.",
      data,
    });
  } catch (err) {
    console.error(`[HRMS] ot ${approved ? "approve" : "reject"}:`, err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export const approveOt = (req, res) => decideOt(req, res, true);
export const rejectOt = (req, res) => decideOt(req, res, false);
