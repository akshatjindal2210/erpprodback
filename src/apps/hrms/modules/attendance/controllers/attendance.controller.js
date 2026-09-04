import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDate, formatHrmsTime } from "../../../lib/hrmsFormat.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { manualMarkToRecord, insertAttendanceLogRecord } from "../../../lib/attendanceEvents.js";
import { upsertAttendanceRow, normalizeShift, shiftDisplay } from "../../../lib/attendanceDaily.js";
import { ingestHikvisionEvents } from "../../attendance-log/controllers/attendanceLog.controller.js";

const TZ = "Asia/Kolkata";
const ENTITY = "hrms_attendance";

function ymd(value) {
  const s = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function timeKey(value) {
  if (value == null || String(value).trim() === "") return "";
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/i);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const plain = s.match(/^(\d{1,2}):(\d{2})/);
  if (plain) return `${String(plain[1]).padStart(2, "0")}:${plain[2]}`;
  return s;
}

function toIstTimestamp(date, time) {
  if (time == null || String(time).trim() === "") return null;
  const raw = String(time).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!hm || !date) return null;
  return `${date}T${String(hm[1]).padStart(2, "0")}:${hm[2]}:00+05:30`;
}

function fingerprint(row) {
  return [timeKey(row?.check_in), timeKey(row?.check_out), String(row?.status ?? "Present").trim().toLowerCase()].join("|");
}

function titleCase(value, fallback = "") {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Display fields only — formulas stay in the handler below. */
function formatRow(row) {
  const approval = String(row.approval_status ?? "").trim();
  return {
    ...row,
    punch_count: row.punch_count != null ? Number(row.punch_count) : undefined,
    attendance_date_display: formatHrmsDate(row.attendance_date),
    check_in_display: row.check_in ? formatHrmsTime(row.check_in) : null,
    check_out_display: row.check_out ? formatHrmsTime(row.check_out) : null,
    shift_display: shiftDisplay(row.shift) || row.shift_display || "",
    entry_type_display: titleCase(row.entry_type, "Automatic"),
    approval_status_display: approval ? titleCase(approval) : "Pending",
  };
}

function logAttendance(req, payload) {
  return logActivity(req, { ...payload, entity: ENTITY, appType: "hrms" });
}

export async function ingestDeviceEvents(req, res) {
  return ingestHikvisionEvents(req, res);
}

export async function listAttendance(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const employee = String(filters?.employee_code ?? filters?.employee ?? "").trim();
    const fromDate = ymd(filters?.from_date ?? filters?.fromDate);
    const toDate = ymd(filters?.to_date ?? filters?.toDate);
    const search = String(filters?.search ?? bodySearch ?? "").trim();
    const shiftRaw = String(filters?.shift ?? "").trim().toUpperCase();
    const shift = shiftRaw === "A" || shiftRaw === "B" ? shiftRaw : "";
    const statusRaw = String(filters?.status ?? "").trim();
    const status =
      /^(present|absent)$/i.test(statusRaw)
        ? statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1).toLowerCase()
        : "";
    const approvalRaw = String(filters?.approval_status ?? filters?.approval ?? "").trim().toLowerCase();
    const approval =
      approvalRaw === "approved" || approvalRaw === "unapproved" || approvalRaw === "pending"
        ? approvalRaw === "pending"
          ? "unapproved"
          : approvalRaw
        : "";

    const where = [];
    const params = [];
    let p = 1;

    if (employee) {
      where.push(`a.employee_code ILIKE $${p++}`);
      params.push(`%${employee}%`);
    }
    if (fromDate) {
      where.push(`a.attendance_date >= $${p++}::date`);
      params.push(fromDate);
    }
    if (toDate) {
      where.push(`a.attendance_date <= $${p++}::date`);
      params.push(toDate);
    }
    if (shift) {
      where.push(`a.shift = $${p++}`);
      params.push(shift);
    }
    if (status) {
      where.push(`a.status ILIKE $${p++}`);
      params.push(status);
    }
    if (approval === "approved") {
      where.push(`LOWER(COALESCE(a.approval_status, '')) = $${p++}`);
      params.push("approved");
    } else if (approval === "unapproved") {
      where.push(`(a.approval_status IS NULL OR LOWER(a.approval_status) = $${p++})`);
      params.push("unapproved");
    }
    if (search) {
      where.push(`(
        a.employee_code ILIKE $${p}
        OR a.name ILIKE $${p}
        OR a.status ILIKE $${p}
        OR a.shift ILIKE $${p}
        OR a.entry_type ILIKE $${p}
        OR COALESCE(a.approval_status, '') ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p += 1;
    }

    const whereSql = where.length ? where.join(" AND ") : "TRUE";

    const countRows = await dbQuery(
      `SELECT COUNT(*)::int AS total FROM ${T.ATTENDANCE} a WHERE ${whereSql}`,
      params
    );

    const rows = await dbQuery(
      `
      SELECT
        a.id,
        a.employee_code,
        a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(a.check_in AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(a.check_out AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
        a.punch_count,
        a.status,
        a.shift,
        a.entry_type,
        a.approval_status,
        a.created_by,
        a.updated_by,
        a.approved_by,
        (to_char(a.approved_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS approved_at,
        (to_char(a.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS created_at,
        (to_char(a.updated_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS updated_at
      FROM ${T.ATTENDANCE} a
      WHERE ${whereSql}
      ORDER BY a.attendance_date DESC, a.employee_code ASC
      LIMIT $${p++} OFFSET $${p++}
      `,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      data: rows.map(formatRow),
      total: countRows[0]?.total ?? 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] listAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function markAttendance(req, res) {
  try {
    const body = req.body || {};
    const employee_code = String(body.employee_code ?? "").trim();
    const mark_type = String(body.mark_type ?? body.type ?? "in").trim();
    if (!employee_code) return res.status(400).json({ success: false, message: "Employee code is required." });
    if (!["in", "out", "checkin", "checkout"].includes(mark_type.toLowerCase())) {
      return res.status(400).json({ success: false, message: "mark_type must be in or out." });
    }
    const record = manualMarkToRecord({
      employee_code,
      name: body.name != null ? String(body.name).trim() : "",
      mark_type,
      device_name: body.device_name,
      marked_by: auditUserName(req),
    });
    if (!record) return res.status(400).json({ success: false, message: "Could not build attendance record." });
    const data = await insertAttendanceLogRecord(record);
    return res.status(201).json({ success: true, message: `${record.status} marked for ${employee_code}.`, data });
  } catch (err) {
    console.error("[HRMS] markAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function previewAttendance(req, res) {
  try {
    const date = ymd(req.body?.date ?? req.body?.attendance_date);
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });

    const punches = await dbQuery(
      `
      SELECT
        employee_code,
        MAX(name) FILTER (WHERE name IS NOT NULL AND TRIM(name) <> '') AS name,
        to_char((event_timestamp AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(MIN(event_timestamp) AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(
          CASE WHEN COUNT(*) > 1 THEN MAX(event_timestamp) ELSE NULL END
          AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS'
        ) || '+05:30') AS check_out,
        COUNT(*)::int AS punch_count,
        CASE WHEN COUNT(DISTINCT source) > 1 THEN 'mixed' ELSE MAX(source) END AS source
      FROM ${T.ATTENDANCE_LOG}
      WHERE employee_code IS NOT NULL AND TRIM(employee_code) <> ''
        AND event_timestamp IS NOT NULL
        AND COALESCE(status, '') NOT ILIKE '%failed%'
        AND COALESCE(status, '') NOT ILIKE '%mismatch%'
        AND COALESCE(event_name, '') NOT ILIKE '%failed%'
        AND COALESCE(event_name, '') NOT ILIKE '%mismatch%'
        AND (event_timestamp AT TIME ZONE '${TZ}')::date = $1::date
      GROUP BY employee_code, (event_timestamp AT TIME ZONE '${TZ}')::date
      `,
      [date]
    );

    const savedRows = await dbQuery(
      `
      SELECT
        a.id,
        a.employee_code,
        a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(a.check_in AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(a.check_out AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
        a.punch_count,
        a.status,
        a.shift,
        a.entry_type,
        a.approval_status
      FROM ${T.ATTENDANCE} a
      WHERE a.attendance_date = $1::date
      `,
      [date]
    );

    const employees = await fetchEmpMaster();
    const punchMap = new Map(punches.map((row) => [String(row.employee_code || "").trim(), row]));
    const savedMap = new Map(savedRows.map((row) => [String(row.employee_code || "").trim(), row]));
    const seen = new Set();
    const data = [];

    const addRow = (code, name) => {
      const key = String(code || "").trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const punch = punchMap.get(key);
      const saved = savedMap.get(key);
      const hasPunch = Boolean(punch);
      const status = saved?.status || (hasPunch ? "Present" : "Absent");
      data.push(
        formatRow({
          id: saved?.id || null,
          employee_code: key,
          name: saved?.name || name || punch?.name || "",
          attendance_date: date,
          check_in: saved?.check_in || punch?.check_in || null,
          check_out: saved?.check_out || punch?.check_out || null,
          punch_count: saved?.punch_count ?? punch?.punch_count ?? 0,
          status,
          shift: saved?.shift === "B" || saved?.shift === "A" ? saved.shift : "A",
          entry_type: saved?.entry_type || (hasPunch ? "automatic" : "manual"),
          approval_status: saved?.approval_status || null,
        })
      );
    };

    for (const emp of employees) addRow(emp.emp_code, emp.emp_name);
    for (const punch of punches) addRow(punch.employee_code, punch.name);

    data.sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code)));
    return res.json({ success: true, date, data, total: data.length });
  } catch (err) {
    console.error("[HRMS] previewAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitAttendance(req, res) {
  try {
    const body = req.body || {};
    const date = ymd(body.date ?? body.attendance_date);
    const entryType = String(body.entry_type ?? body.type ?? "automatic").toLowerCase() === "manual" ? "manual" : "automatic";
    const list = Array.isArray(body.rows) ? body.rows : body.employee_code ? [body] : [];
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });
    if (!list.length) return res.status(400).json({ success: false, message: "At least one attendance row is required." });

    const userName = auditUserName(req);
    const saved = [];
    const editedCodes = [];
    let approvedCount = 0;
    let unapprovedCount = 0;
    let skippedNoShift = 0;

    let baselineMap = new Map();
    if (entryType === "automatic") {
      const punches = await dbQuery(
        `
        SELECT
          employee_code,
          (to_char(MIN(event_timestamp) AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
          (to_char(
            CASE WHEN COUNT(*) > 1 THEN MAX(event_timestamp) ELSE NULL END
            AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS'
          ) || '+05:30') AS check_out,
          CASE WHEN COUNT(*) > 0 THEN 'Present' ELSE 'Absent' END AS status
        FROM ${T.ATTENDANCE_LOG}
        WHERE employee_code IS NOT NULL AND TRIM(employee_code) <> ''
          AND event_timestamp IS NOT NULL
          AND COALESCE(status, '') NOT ILIKE '%failed%'
          AND COALESCE(status, '') NOT ILIKE '%mismatch%'
          AND COALESCE(event_name, '') NOT ILIKE '%failed%'
          AND COALESCE(event_name, '') NOT ILIKE '%mismatch%'
          AND (event_timestamp AT TIME ZONE '${TZ}')::date = $1::date
        GROUP BY employee_code
        `,
        [date]
      );
      baselineMap = new Map(
        punches.map((row) => [
          String(row.employee_code || "").trim(),
          fingerprint({ check_in: row.check_in, check_out: row.check_out, status: "Present" }),
        ])
      );
    }

    for (const raw of list) {
      const code = String(raw.employee_code ?? "").trim();
      if (!code) continue;
      const checkIn = toIstTimestamp(date, raw.check_in ?? raw.check_in_time);
      const checkOut = toIstTimestamp(date, raw.check_out ?? raw.check_out_time);
      const status = String(raw.status ?? "").trim() || (checkIn ? "Present" : "Absent");
      const rowShift = normalizeShift(raw.shift);
      if (!rowShift) {
        skippedNoShift += 1;
        continue;
      }

      // Automatic from device/log:
      // - unchanged vs attendance-log → approved
      // - any change (time / status / shift / absent with no punch) → unapproved (needs Approve)
      // Manual always needs Approve.
      const logFingerprint = baselineMap.has(code) ? baselineMap.get(code) : null;
      const submittedFingerprint = fingerprint({ check_in: checkIn, check_out: checkOut, status });
      const matchesDeviceLog = logFingerprint != null && logFingerprint === submittedFingerprint;
      const clientChanged = raw.edited === true || raw.edited === 1 || raw.edited === "true" || raw.edited === "1";
      const needsApproval =
        entryType === "manual" ||
        !matchesDeviceLog ||
        clientChanged;
      const approvalStatus = needsApproval ? "unapproved" : "approved";

      if (needsApproval) editedCodes.push(code);
      if (approvalStatus === "approved") approvedCount += 1;
      else unapprovedCount += 1;

      const row = await upsertAttendanceRow({
        employee_code: code,
        name: String(raw.name ?? "").trim() || null,
        attendance_date: date,
        shift: rowShift,
        check_in: checkIn,
        check_out: checkOut,
        punch_count: Number(raw.punch_count) || 0,
        status,
        entry_type: entryType,
        approval_status: approvalStatus,
        created_by: userName,
        updated_by: userName,
        approved_by: approvalStatus === "approved" ? userName : null,
        approved_at: approvalStatus === "approved" ? new Date() : null,
      });
      if (row) saved.push({ ...formatRow(row), edited: needsApproval, needs_approval: needsApproval });
    }

    if (!saved.length && skippedNoShift > 0) {
      return res.status(400).json({
        success: false,
        message: "Shift is required for each employee (A = Day, B = Night).",
      });
    }

    await logAttendance(req, {
      action: "create",
      entity_id: date,
      record: { attendance_date: date, entry_type: entryType },
      details: {
        entry_type: entryType,
        attendance_date: date,
        total: saved.length,
        approved_count: approvedCount,
        unapproved_count: unapprovedCount,
        edited_codes: editedCodes,
        skipped_no_shift: skippedNoShift,
      },
    });

    return res.status(201).json({
      success: true,
      message:
        entryType === "manual"
          ? "Manual attendance submitted for approval."
          : `Saved ${saved.length} row(s) — ${approvedCount} approved (unchanged device/log), ${unapprovedCount} pending approval (changed / absent / manual).`,
      date,
      entry_type: entryType,
      data: saved,
      total: saved.length,
      approved_count: approvedCount,
      unapproved_count: unapprovedCount,
      edited_codes: editedCodes,
    });
  } catch (err) {
    console.error("[HRMS] submitAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateAttendance(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const found = await dbQuery(
      `
      SELECT
        id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(check_in AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(check_out AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
        punch_count, status, entry_type, approval_status
      FROM ${T.ATTENDANCE}
      WHERE id = $1
      `,
      [id]
    );
    const previous = found[0];
    if (!previous) return res.status(404).json({ success: false, message: "Attendance row not found." });

    const date = ymd(req.body.attendance_date) || previous.attendance_date;
    const shift = normalizeShift(req.body.shift) || normalizeShift(previous.shift) || "A";
    const checkIn = toIstTimestamp(date, req.body.check_in ?? req.body.check_in_time ?? previous.check_in);
    const checkOut = toIstTimestamp(date, req.body.check_out ?? req.body.check_out_time ?? previous.check_out);
    const status = String(req.body.status ?? previous.status ?? "").trim() || (checkIn ? "Present" : "Absent");
    const changed = fingerprint(previous) !== fingerprint({ check_in: checkIn, check_out: checkOut, status }) || normalizeShift(previous.shift) !== shift;
    const approvalStatus = changed ? "unapproved" : previous.approval_status || "unapproved";
    const userName = auditUserName(req);

    const rows = await dbQuery(
      `
      UPDATE ${T.ATTENDANCE}
      SET
        name = COALESCE($2, name),
        shift = $3,
        check_in = $4::timestamptz,
        check_out = $5::timestamptz,
        status = $6,
        entry_type = CASE WHEN $7 THEN 'manual' ELSE COALESCE(entry_type, 'manual') END,
        approval_status = $8,
        updated_by = $9,
        approved_by = CASE WHEN $8 = 'approved' THEN approved_by ELSE NULL END,
        approved_at = CASE WHEN $8 = 'approved' THEN approved_at ELSE NULL END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(check_in AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(check_out AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
        punch_count, status, entry_type, approval_status, updated_by
      `,
      [id, String(req.body.name ?? previous.name ?? "").trim() || null, shift, checkIn, checkOut, status, changed, approvalStatus, userName]
    );

    const data = formatRow(rows[0] || previous);
    await logAttendance(req, {
      action: "update",
      entity_id: data.id,
      record: data,
      details: {
        changed,
        previous: {
          check_in: previous.check_in,
          check_out: previous.check_out,
          status: previous.status,
          approval_status: previous.approval_status,
        },
      },
    });

    return res.json({
      success: true,
      message: changed ? "Attendance updated and marked unapproved." : "No changes saved.",
      data,
    });
  } catch (err) {
    console.error("[HRMS] updateAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteAttendance(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const found = await dbQuery(
      `
      SELECT
        id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        status, entry_type, approval_status
      FROM ${T.ATTENDANCE}
      WHERE id = $1
      `,
      [id]
    );
    const existing = found[0];
    if (!existing) return res.status(404).json({ success: false, message: "Attendance row not found." });

    await dbQuery(`DELETE FROM ${T.ATTENDANCE} WHERE id = $1`, [id]);
    await logAttendance(req, { action: "delete", entity_id: existing.id, record: existing });
    return res.json({ success: true, message: "Attendance row deleted.", data: existing });
  } catch (err) {
    console.error("[HRMS] deleteAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function approveAttendance(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });
    const userName = auditUserName(req);

    const rows = await dbQuery(
      `
      UPDATE ${T.ATTENDANCE}
      SET
        approval_status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        updated_by = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        (to_char(check_in AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_in,
        (to_char(check_out AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30') AS check_out,
        punch_count, status, entry_type, approval_status, approved_by
      `,
      [id, userName]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Attendance row not found." });

    const data = formatRow(rows[0]);
    await logAttendance(req, { action: "approve", entity_id: data.id, record: data });
    return res.json({ success: true, message: "Attendance approved.", data });
  } catch (err) {
    console.error("[HRMS] approveAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
