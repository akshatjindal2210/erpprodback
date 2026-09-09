import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDate, formatHrmsDateTime, formatHrmsTime } from "../../../lib/hrmsFormat.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { istTs, LOG_DATE_SQL, LOG_VALID_PUNCH_SQL, normalizeShift, shiftDisplay, countPunches, ymd, punchFingerprint, buildAttendanceParams, isApprovedStatus, entryTypeDisplay, resolveEntryTypeOnUpdate, normalizeEntryType, ATT_COL_IN, ATT_COL_OUT, rowInTime, rowOutTime, parseAttendanceInOut, isFutureAttendanceDate } from "../../../lib/attendanceCommon.js";

const ENTITY = "hrms_attendance";
const ATT = T.ATTENDANCE;

const ATT_RETURN = `
  id, employee_code, name, shift,
  to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
  ${istTs(ATT_COL_IN)} AS "in",
  ${istTs(ATT_COL_OUT)} AS "out",
  punch_count, entry_type, approval_status
`;

const UPSERT_ATTENDANCE_SQL = `
  WITH updated AS (
    UPDATE ${ATT}
    SET
      name = COALESCE($2, name),
      shift = $4,
      ${ATT_COL_IN} = $5::timestamptz,
      ${ATT_COL_OUT} = $6::timestamptz,
      punch_count = $7,
      entry_type = $8,
      approval_status = $9,
      created_by = COALESCE(created_by, $10),
      updated_by = $11,
      approved_by = $12,
      approved_at = $13::timestamptz,
      updated_at = NOW()
    WHERE employee_code = $1
      AND attendance_date = $3::date
    RETURNING ${ATT_RETURN}
  ),
  inserted AS (
    INSERT INTO ${ATT} (
      employee_code, name, attendance_date, shift, ${ATT_COL_IN}, ${ATT_COL_OUT}, punch_count,
      entry_type, approval_status, created_by, updated_by,
      approved_by, approved_at, updated_at
    )
    SELECT
      $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7,
      $8, $9, $10, $11, $12, $13::timestamptz, NOW()
    WHERE NOT EXISTS (SELECT 1 FROM updated)
    RETURNING ${ATT_RETURN}
  )
  SELECT * FROM updated
  UNION ALL
  SELECT * FROM inserted
`;

const INSERT_ATTENDANCE_SQL = `
  INSERT INTO ${ATT} (
    employee_code, name, attendance_date, shift, ${ATT_COL_IN}, ${ATT_COL_OUT}, punch_count,
    entry_type, approval_status, created_by, updated_by,
    approved_by, approved_at, updated_at
  ) VALUES (
    $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7,
    $8, $9, $10, $11, $12, $13::timestamptz, NOW()
  )
  RETURNING ${ATT_RETURN}
`;

const LOG_DAILY_PUNCH_SQL = `
  WITH day_logs AS (
    SELECT employee_code, name, event_timestamp
    FROM ${T.ATTENDANCE_LOG}
    WHERE ${LOG_VALID_PUNCH_SQL}
      AND ${LOG_DATE_SQL} = $1::date
  ),
  next_day_first AS (
    SELECT employee_code, MIN(event_timestamp) AS first_out
    FROM ${T.ATTENDANCE_LOG}
    WHERE ${LOG_VALID_PUNCH_SQL}
      AND ${LOG_DATE_SQL} = ($1::date + INTERVAL '1 day')::date
      AND (event_timestamp AT TIME ZONE 'Asia/Kolkata')::time <= TIME '08:30:00'
    GROUP BY employee_code
  )
  SELECT
    d.employee_code,
    MAX(d.name) FILTER (WHERE d.name IS NOT NULL AND TRIM(d.name) <> '') AS name,
    ${istTs("MIN(d.event_timestamp)")} AS "in",
    ${istTs("CASE WHEN COUNT(*) > 1 THEN MAX(d.event_timestamp) ELSE n.first_out END")} AS "out",
    (COUNT(*) + CASE WHEN COUNT(*) = 1 AND n.first_out IS NOT NULL THEN 1 ELSE 0 END)::int AS punch_count,
    CASE WHEN COUNT(*) = 1 AND n.first_out IS NOT NULL THEN 'B' ELSE 'A' END AS shift
  FROM day_logs d
  LEFT JOIN next_day_first n ON n.employee_code = d.employee_code
  GROUP BY d.employee_code, n.first_out
`;

function titleCase(value, fallback = "") {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Employee master time → HH:mm 24h (avoids "05:00 PM" being read as 05:00). */
function toHHmm24(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  const iso = s.match(/(?:T|\s)(\d{2}):(\d{2})(?::\d{2})?/);
  if (iso && !/\b(AM|PM)\b/i.test(s)) return `${iso[1]}:${iso[2]}`;
  const display = formatHrmsTime(value) || s;
  const ampm = String(display).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2];
    const mer = ampm[3].toUpperCase();
    if (mer === "AM") {
      if (h === 12) h = 0;
    } else if (h !== 12) {
      h += 12;
    }
    return `${String(h).padStart(2, "0")}:${m}`;
  }
  const plain = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (plain) return `${String(parseInt(plain[1], 10)).padStart(2, "0")}:${plain[2]}`;
  return null;
}

function formatRow(row) {
  const approval = String(row.approval_status ?? "").trim();
  const inTs = rowInTime(row);
  const outTs = rowOutTime(row);
  return {
    ...row,
    in: inTs,
    out: outTs,
    punch_count: row.punch_count != null ? Number(row.punch_count) : undefined,
    attendance_date_display: formatHrmsDate(row.attendance_date),
    in_display: formatHrmsDateTime(inTs),
    out_display: formatHrmsDateTime(outTs),
    shift_display: shiftDisplay(row.shift) || row.shift_display || "",
    entry_type_display: entryTypeDisplay(row.entry_type),
    approval_status_display: approval ? titleCase(approval) : "Pending",
  };
}

function logAttendance(req, payload) {
  return logActivity(req, { ...payload, entity: ENTITY, appType: "hrms" });
}

function addOneDayYmd(date) {
  const d = new Date(`${date}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isDateTimeAllowedForAttendanceDate(attendanceDate, inTime, outTime) {
  const date = ymd(attendanceDate);
  if (!date) return false;
  const start = Date.parse(`${date}T00:00:00+05:30`);
  const dayEnd = Date.parse(`${date}T23:59:59+05:30`);
  const nextDayCutoff = Date.parse(`${addOneDayYmd(date)}T08:30:00+05:30`);

  const inMs = inTime ? Date.parse(inTime) : NaN;
  const outMs = outTime ? Date.parse(outTime) : NaN;

  if (inTime && (!Number.isFinite(inMs) || inMs < start || inMs > dayEnd)) return false;
  if (outTime && (!Number.isFinite(outMs) || outMs < start || outMs > nextDayCutoff)) return false;
  if (inTime && outTime && Number.isFinite(inMs) && Number.isFinite(outMs) && outMs < inMs) return false;
  return true;
}

async function saveAttendanceRow(client, row, manual = false) {
  const params = buildAttendanceParams(row);
  if (!params) return null;
  const sql = manual ? INSERT_ATTENDANCE_SQL : UPSERT_ATTENDANCE_SQL;
  const result = client ? await client.query(sql, params) : await dbQuery(sql, params);
  const saved = client ? result.rows[0] : result[0];
  return saved ? formatRow(saved) : null;
}

function resolveApproval({ req, previous, hasBusinessChanges, incomingApproved }) {
  const canAuthorize = Boolean(req?.permission?.can_authorize) || req?.user?.type === "super_admin";
  const userName = auditUserName(req);

  if (incomingApproved === true) {
    if (!canAuthorize) {
      const err = new Error("Forbidden.");
      err.statusCode = 403;
      throw err;
    }
    return { approval_status: "approved", approved_by: userName, approved_at: new Date() };
  }

  if (incomingApproved === false || hasBusinessChanges) {
    return { approval_status: "unapproved", approved_by: null, approved_at: null };
  }

  return {
    approval_status: previous.approval_status || "unapproved",
    approved_by: isApprovedStatus(previous.approval_status) ? previous.approved_by ?? null : null,
    approved_at: isApprovedStatus(previous.approval_status) ? previous.approved_at ?? null : null,
  };
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
        OR a.shift ILIKE $${p}
        OR a.entry_type ILIKE $${p}
        OR COALESCE(a.approval_status, '') ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p += 1;
    }

    const whereSql = where.length ? where.join(" AND ") : "TRUE";
    const countRows = await dbQuery(`SELECT COUNT(*)::int AS total FROM ${T.ATTENDANCE} a WHERE ${whereSql}`, params);
    const rows = await dbQuery(
      `
      SELECT
        a.id, a.employee_code, a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(`a.${ATT_COL_IN}`)} AS "in",
        ${istTs(`a.${ATT_COL_OUT}`)} AS "out",
        a.punch_count, a.shift, a.entry_type, a.approval_status,
        a.created_by, a.updated_by, a.approved_by,
        ${istTs("a.approved_at")} AS approved_at,
        ${istTs("a.created_at")} AS created_at,
        ${istTs("a.updated_at")} AS updated_at
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

export async function previewAttendance(req, res) {
  try {
    const date = ymd(req.body?.date ?? req.body?.attendance_date);
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });
    if (isFutureAttendanceDate(date)) {
      return res.status(400).json({ success: false, message: "Future date is not allowed." });
    }

    const previewType = normalizeEntryType(req.body?.entry_type ?? req.body?.type ?? "automatic") === "manual" ? "manual" : "automatic";

    const savedRows = await dbQuery(
      `
      SELECT a.id, a.employee_code, a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(`a.${ATT_COL_IN}`)} AS "in",
        ${istTs(`a.${ATT_COL_OUT}`)} AS "out",
        a.punch_count, a.shift, a.entry_type, a.approval_status
      FROM ${T.ATTENDANCE} a
      WHERE a.attendance_date = $1::date
      `,
      [date]
    );

    if (previewType === "manual") {
      const data = savedRows
        .map((saved) =>
          formatRow({
            id: saved.id,
            employee_code: saved.employee_code,
            name: saved.name || "",
            attendance_date: date,
            in: rowInTime(saved),
            out: rowOutTime(saved),
            punch_count: saved.punch_count ?? 0,
            shift: saved.shift === "B" || saved.shift === "A" ? saved.shift : "A",
            entry_type: saved.entry_type || "manual",
            approval_status: saved.approval_status || null,
          })
        )
        .sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code)));
      return res.json({ success: true, date, data, total: data.length });
    }

    const punches = await dbQuery(
      `
      SELECT
        employee_code, name, "in", "out", punch_count, shift,
        'device' AS source
      FROM (${LOG_DAILY_PUNCH_SQL}) p
      `,
      [date]
    );

    const employees = await fetchEmpMaster();
    const empNameMap = new Map(employees.map((row) => [String(row.emp_code || "").trim(), row.emp_name]));
    const empTimeMap = new Map(
      employees.map((row) => [
        String(row.emp_code || "").trim(),
        {
          default_in: toHHmm24(row.emp_intime) || toHHmm24(row.emp_intime_display),
          default_out: toHHmm24(row.emp_outtime) || toHHmm24(row.emp_outtime_display),
        },
      ])
    );
    const masterCodes = new Set(employees.map((row) => String(row.emp_code || "").trim()).filter(Boolean));
    const savedMap = new Map(savedRows.map((row) => [String(row.employee_code || "").trim(), row]));
    const data = punches
      .map((punch) => {
        const key = String(punch.employee_code || "").trim();
        if (!key) return null;
        if (!masterCodes.has(key)) return null;
        const saved = savedMap.get(key);
        const alreadyExists = Boolean(saved?.id);
        const times = empTimeMap.get(key) || {};
        return formatRow({
          id: saved?.id || null,
          employee_code: key,
          name: saved?.name || punch.name || empNameMap.get(key) || "",
          attendance_date: date,
          in: rowInTime(punch) || null,
          out: rowOutTime(punch) || null,
          punch_count: punch.punch_count ?? 0,
          shift: normalizeShift(punch?.shift) || (saved?.shift === "B" ? "B" : "A"),
          entry_type: saved?.entry_type || "automatic",
          approval_status: saved?.approval_status || null,
          already_exists: alreadyExists,
          default_in: times.default_in || null,
          default_out: times.default_out || null,
        });
      })
      .filter(Boolean)
      .sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code)));

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
    if (isFutureAttendanceDate(date)) {
      return res.status(400).json({ success: false, message: "Future date is not allowed." });
    }
    if (!list.length) return res.status(400).json({ success: false, message: "Rows required." });

    const userName = auditUserName(req);
    const employees = await fetchEmpMaster();
    const masterCodes = new Set(employees.map((row) => String(row.emp_code || "").trim()).filter(Boolean));
    let baselineMap = new Map();

    if (entryType === "automatic") {
      const punches = await dbQuery(`SELECT employee_code, "in", "out", shift FROM (${LOG_DAILY_PUNCH_SQL}) p`, [date]);
      baselineMap = new Map(
        punches.map((row) => [
          String(row.employee_code || "").trim(),
          punchFingerprint({ in: rowInTime(row), out: rowOutTime(row), shift: normalizeShift(row?.shift) || "A" }),
        ])
      );
    }

    const normalizedRows = [];
    const seenKeys = new Set();
    let skippedExisting = 0;

    let existingSet = new Set();
    if (entryType === "automatic") {
      const codes = list.map((raw) => String(raw.employee_code ?? "").trim()).filter(Boolean);
      if (codes.length) {
        const existingRows = await dbQuery(`SELECT employee_code FROM ${T.ATTENDANCE} WHERE attendance_date = $1::date AND employee_code = ANY($2::text[])`, [date, codes]);
        existingSet = new Set(existingRows.map((row) => String(row.employee_code || "").trim()).filter(Boolean));
      }
    }

    for (const raw of list) {
      const code = String(raw.employee_code ?? "").trim();
      if (!code || !normalizeShift(raw.shift) || seenKeys.has(code)) continue;
      if (!masterCodes.has(code)) continue;
      seenKeys.add(code);

      const exists = existingSet.has(code);
      const override = raw.override === true || raw.override === 1 || raw.override === "true" || raw.override === "1";
      if (entryType === "automatic" && exists && !override) {
        skippedExisting += 1;
        continue;
      }

      const { in: inTime, out: outTime } = parseAttendanceInOut(raw, null, date);
      if (!inTime || !outTime) {
        return res.status(400).json({ success: false, message: `In and Out both required for ${code}.` });
      }
      if (!isDateTimeAllowedForAttendanceDate(date, inTime, outTime)) {
        return res.status(400).json({ success: false, message: `Invalid in/out datetime for ${code}.` });
      }
      const clientChanged = raw.edited === true || raw.edited === 1 || raw.edited === "true" || raw.edited === "1";

      const logFp = baselineMap.get(code);
      const submittedFp = punchFingerprint({ in: inTime, out: outTime, shift: raw.shift });
      const matchesLog = logFp != null && logFp === submittedFp;
      const rowEntryType =
        entryType === "manual" ? "manual" : clientChanged ? "automatic_edit" : "automatic";
      const needsApproval = entryType === "manual" || !matchesLog || clientChanged;
      const approvalStatus = needsApproval ? "unapproved" : "approved";

      normalizedRows.push({
        employee_code: code,
        name: String(raw.name ?? "").trim() || null,
        attendance_date: date,
        shift: normalizeShift(raw.shift),
        in: inTime,
        out: outTime,
        punch_count: Number(raw.punch_count) > 0 ? Number(raw.punch_count) : countPunches(inTime, outTime),
        entry_type: rowEntryType,
        approval_status: approvalStatus,
        created_by: userName,
        updated_by: userName,
        approved_by: approvalStatus === "approved" ? userName : null,
        approved_at: approvalStatus === "approved" ? new Date() : null,
        needsApproval,
      });
    }

    if (!normalizedRows.length) {
      return res.status(400).json({
        success: false,
        message:
          skippedExisting > 0
            ? `Nothing to save — ${skippedExisting} already exist (tick Override to replace).`
            : entryType === "automatic"
              ? "No present records to save."
              : "Nothing to save.",
        skipped_existing: skippedExisting,
      });
    }

    if (entryType === "manual") {
      const existingRows = await dbQuery(
        `SELECT employee_code FROM ${T.ATTENDANCE}
         WHERE attendance_date = $1::date AND employee_code = ANY($2::text[])`,
        [date, normalizedRows.map((row) => row.employee_code)]
      );
      if (existingRows.length) {
        const existingCodes = existingRows.map((row) => String(row.employee_code || "").trim()).filter(Boolean);
        return res.status(409).json({ success: false, message: `Already exists: ${existingCodes.join(", ")}`, existing_codes: existingCodes });
      }
    }

    const result = await withTransaction(async (client) => {
      const saved = [];
      for (const row of normalizedRows) {
        const stored = await saveAttendanceRow(client, row, entryType === "manual");
        if (stored) saved.push({ ...stored, needs_approval: row.needsApproval });
      }
      return saved;
    });

    if (!result.length) return res.status(400).json({ success: false, message: "Save failed." });

    await logAttendance(req, {
      action: "create",
      entity_id: date,
      record: { attendance_date: date, entry_type: entryType },
      details: { total: result.length, skipped_existing: skippedExisting },
    });

    const skipMsg = skippedExisting > 0 ? ` Skipped ${skippedExisting} existing (no override).` : "";
    return res.status(201).json({
      success: true,
      message: `Saved.${skipMsg}`,
      date,
      entry_type: entryType,
      data: result,
      total: result.length,
      skipped_existing: skippedExisting,
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
      SELECT id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(ATT_COL_IN)} AS "in",
        ${istTs(ATT_COL_OUT)} AS "out",
        punch_count, entry_type, approval_status,
        approved_by, ${istTs("approved_at")} AS approved_at
      FROM ${ATT}
      WHERE id = $1
      `,
      [id]
    );
    const previous = found[0];
    if (!previous) return res.status(404).json({ success: false, message: "Not found." });

    const date = ymd(req.body.attendance_date) || previous.attendance_date;
    if (isFutureAttendanceDate(date)) {
      return res.status(400).json({ success: false, message: "Future date is not allowed." });
    }
    const shift = normalizeShift(req.body.shift) || normalizeShift(previous.shift) || "A";
    const { in: inTime, out: outTime } = parseAttendanceInOut(req.body, previous, date);
    if (!inTime || !outTime) {
      return res.status(400).json({ success: false, message: "In and Out both are required." });
    }
    if (!isDateTimeAllowedForAttendanceDate(date, inTime, outTime)) {
      return res.status(400).json({ success: false, message: "Invalid in/out datetime for selected date." });
    }
    const changed =
      punchFingerprint(previous) !== punchFingerprint({ in: inTime, out: outTime, shift }) ||
      normalizeShift(previous.shift) !== shift;
    const incomingApproved = normalizeApprovedInput(req.body?.approved ?? req.body?.approval_status);
    const approval = resolveApproval({ req, previous, hasBusinessChanges: changed, incomingApproved });
    const userName = auditUserName(req);
    const nextEntryType = resolveEntryTypeOnUpdate(previous, changed);

    const rows = await dbQuery(
      `
      UPDATE ${ATT}
      SET
        name = COALESCE($2, name),
        shift = $3,
        ${ATT_COL_IN} = $4::timestamptz,
        ${ATT_COL_OUT} = $5::timestamptz,
        punch_count = $6,
        entry_type = $7,
        approval_status = $8,
        updated_by = $9,
        approved_by = $10,
        approved_at = $11::timestamptz,
        updated_at = NOW()
      WHERE id = $1
      RETURNING ${ATT_RETURN}, updated_by, approved_by
      `,
      [
        id,
        String(req.body.name ?? previous.name ?? "").trim() || null,
        shift,
        inTime,
        outTime,
        countPunches(inTime, outTime),
        nextEntryType,
        approval.approval_status,
        userName,
        approval.approved_by,
        approval.approved_at,
      ]
    );

    const data = formatRow(rows[0] || previous);
    await logAttendance(req, {
      action: incomingApproved === true ? "approve" : "update",
      entity_id: data.id,
      record: data,
      details: { changed },
    });

    return res.json({
      success: true,
      message: "Saved.",
      data,
    });
  } catch (err) {
    console.error("[HRMS] updateAttendance:", err);
    if (err.statusCode === 403) return res.status(403).json({ success: false, message: err.message || "Forbidden." });
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteAttendance(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const found = await dbQuery(
      `SELECT id, employee_code, name, shift,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        entry_type, approval_status
       FROM ${T.ATTENDANCE} WHERE id = $1`,
      [id]
    );
    const existing = found[0];
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    await dbQuery(`DELETE FROM ${T.ATTENDANCE} WHERE id = $1`, [id]);
    await logAttendance(req, { action: "delete", entity_id: existing.id, record: existing });
    return res.json({ success: true, message: "Deleted.", data: existing });
  } catch (err) {
    console.error("[HRMS] deleteAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
