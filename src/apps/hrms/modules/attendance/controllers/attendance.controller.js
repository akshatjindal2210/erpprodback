import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { getHrmsOvertimeBufferMinutes } from "../../../../core/configuration/models/appConfig.model.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDate, formatHrmsDateTime, formatHrmsTime } from "../../../lib/hrmsFormat.js";
import { fetchEmpMaster } from "../../../lib/erpApi.js";
import { applyApprovalUpdateFields, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { logHrmsActivity } from "../../../lib/utils/activity/logHrmsActivity.js";
import { istTs, normalizeShift, shiftDisplay, ymd, punchFingerprint, buildAttendanceParams, isApprovedStatus, entryTypeDisplay, resolveEntryTypeOnUpdate, normalizeEntryType, normalizeDayType, dayTypeDisplay, dayTypeValue, computeAttendanceDerived, buildLogDailyPunchSql, applyNightDefaultOut, buildDefaultInOutTimestamps, ATT_COL_IN, ATT_COL_OUT, rowInTime, rowOutTime, parseAttendanceInOut, isFutureAttendanceDate, parseEmpDcode, NIGHT_SHIFT_END, addDaysYmd, normalizeOtApprovedFlag, otDecisionLabel } from "../../../lib/attendanceCommon.js";

const ENTITY = "hrms_attendance";
const ATT = T.ATTENDANCE;
const LOG_DAILY_PUNCH_SQL = buildLogDailyPunchSql(T.ATTENDANCE_LOG);

const ATT_RETURN = `
  id, emp_dcode, name, shift, day_type, day_value,
  ${istTs("default_in")} AS default_in,
  ${istTs("default_out")} AS default_out,
  total_minutes, lunch, worked_minutes,
  ot_minutes, ot_approved, ot_approved_by, ot_remarks,
  to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
  ${istTs(ATT_COL_IN)} AS "in",
  ${istTs(ATT_COL_OUT)} AS "out",
  entry_type, approval_status, approval_remarks,
  created_by, updated_by, approved_by,
  ${istTs("created_at")} AS created_at,
  ${istTs("updated_at")} AS updated_at,
  ${istTs("approved_at")} AS approved_at,
  ${istTs("ot_approved_at")} AS ot_approved_at
`;

const UPSERT_ATTENDANCE_SQL = `
  WITH updated AS (
    UPDATE ${ATT}
    SET
      name = COALESCE($2, name),
      shift = $4,
      ${ATT_COL_IN} = $5::timestamptz,
      ${ATT_COL_OUT} = $6::timestamptz,
      entry_type = $7,
      approval_status = $8,
      created_by = COALESCE(created_by, $9),
      updated_by = $10,
      approved_by = $11,
      approved_at = $12::timestamptz,
      day_type = $13,
      day_value = $14,
      default_in = $15::timestamptz,
      default_out = $16::timestamptz,
      worked_minutes = $17,
      total_minutes = $18,
      lunch = $19,
      ot_minutes = $20,
      ot_approved = $21,
      ot_approved_by = $22,
      ot_approved_at = $23::timestamptz,
      ot_remarks = $24,
      updated_at = NOW()
    WHERE emp_dcode = $1
      AND attendance_date = $3::date
    RETURNING ${ATT_RETURN}
  ),
  inserted AS (
    INSERT INTO ${ATT} (
      emp_dcode, name, attendance_date, shift, ${ATT_COL_IN}, ${ATT_COL_OUT},
      entry_type, approval_status, created_by, updated_by,
      approved_by, approved_at, day_type, day_value, default_in, default_out,
      worked_minutes, total_minutes, lunch,
      ot_minutes, ot_approved, ot_approved_by, ot_approved_at, ot_remarks, updated_at
    )
    SELECT
      $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz,
      $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15::timestamptz, $16::timestamptz,
      $17, $18, $19,
      $20, $21, $22, $23::timestamptz, $24, NOW()
    WHERE NOT EXISTS (SELECT 1 FROM updated)
    RETURNING ${ATT_RETURN}
  )
  SELECT * FROM updated
  UNION ALL
  SELECT * FROM inserted
`;

const INSERT_ATTENDANCE_SQL = `
  INSERT INTO ${ATT} (
    emp_dcode, name, attendance_date, shift, ${ATT_COL_IN}, ${ATT_COL_OUT},
    entry_type, approval_status, created_by, updated_by,
    approved_by, approved_at, day_type, day_value, default_in, default_out,
    worked_minutes, total_minutes, lunch,
    ot_minutes, ot_approved, ot_approved_by, ot_approved_at, ot_remarks, updated_at
  ) VALUES (
    $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz,
    $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15::timestamptz, $16::timestamptz,
    $17, $18, $19,
    $20, $21, $22, $23::timestamptz, $24, NOW()
  )
  RETURNING ${ATT_RETURN}
`;

function titleCase(value, fallback = "") {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Emp master time → HH:mm */
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

function buildMasterMaps(employees) {
  const byDcode = new Map();
  const codeToDcode = new Map();
  for (const emp of employees) {
    const dcode = parseEmpDcode(emp.emp_dcode);
    const code = String(emp.emp_code || "").trim();
    if (dcode) byDcode.set(dcode, emp);
    if (code && dcode) codeToDcode.set(code, dcode);
  }
  return { byDcode, codeToDcode };
}

function attachEmp(row, byDcode) {
  const emp = byDcode?.get(parseEmpDcode(row.emp_dcode));
  const date = ymd(row.attendance_date);
  const shift = normalizeShift(row.shift) || "A";
  const inHm = toHHmm24(row.default_in) || toHHmm24(emp?.emp_intime) || toHHmm24(emp?.emp_intime_display);
  const outHm = toHHmm24(row.default_out) || toHHmm24(emp?.emp_outtime) || toHHmm24(emp?.emp_outtime_display);
  const defaults = buildDefaultInOutTimestamps(date, shift, inHm, outHm);
  return {
    ...row,
    emp_dcode: parseEmpDcode(row.emp_dcode),
    emp_code: emp?.emp_code ?? row.emp_code ?? "",
    default_in: defaults.default_in,
    default_out: defaults.default_out,
  };
}

function resolveSubmitEmpDcode(raw, codeToDcode) {
  const fromBody = parseEmpDcode(raw.emp_dcode);
  if (fromBody) return fromBody;
  const legacyCode = String(raw.employee_code ?? "").trim();
  if (legacyCode && codeToDcode.has(legacyCode)) return codeToDcode.get(legacyCode);
  return null;
}

function formatRow(row, byDcode, overtimeBufferMinutes) {
  const merged = byDcode ? attachEmp(row, byDcode) : row;
  const approval = String(merged.approval_status ?? "").trim();
  const inTs = rowInTime(merged);
  const outTs = rowOutTime(merged);
  const derived = computeAttendanceDerived({ ...merged, in: inTs, out: outTs }, overtimeBufferMinutes);
  const otApproved = normalizeOtApprovedFlag(merged.ot_approved);
  const otMinutes = derived.ot_minutes;
  return {
    ...merged,
    in: inTs,
    out: outTs,
    day_type: derived.day_type,
    day_type_display: dayTypeDisplay(derived.day_type),
    day_value: derived.day_value,
    default_in: derived.default_in || null,
    default_out: derived.default_out || null,
    default_in_display: formatHrmsDateTime(derived.default_in),
    default_out_display: formatHrmsDateTime(derived.default_out),
    default_minutes: derived.default_minutes,
    full_default_minutes: derived.full_default_minutes,
    normal_minutes: derived.normal_minutes,
    lunch_minutes: derived.lunch_minutes,
    adjust_minutes: derived.adjust_minutes,
    total_minutes: derived.total_minutes,
    lunch: derived.lunch,
    lunch_display: derived.total_minutes == null ? "—" : derived.lunch ? "Yes" : "No",
    worked_minutes: derived.worked_minutes,
    ot_minutes: otMinutes,
    ot_approved: otApproved,
    ot_status_display: otMinutes == null || otMinutes === 0 ? "—" : otDecisionLabel(otApproved),
    attendance_date_display: formatHrmsDate(merged.attendance_date),
    in_display: formatHrmsDateTime(inTs),
    out_display: formatHrmsDateTime(outTs),
    shift_display: shiftDisplay(merged.shift) || merged.shift_display || "",
    entry_type_display: entryTypeDisplay(merged.entry_type),
    approval_status_display: approval ? titleCase(approval) : "Pending",
    created_by_name: merged.created_by_name ?? merged.created_by ?? null,
    updated_by_name: merged.updated_by_name ?? merged.updated_by ?? null,
    approved_by_name: merged.approved_by_name ?? merged.approved_by ?? null,
    ot_approved_by_name: merged.ot_approved_by_name ?? merged.ot_approved_by ?? null,
    overtime_buffer_minutes: overtimeBufferMinutes,
  };
}

function logAttendance(req, payload) {
  return logHrmsActivity(req, { ...payload, entity: ENTITY });
}

function addOneDayYmd(date) {
  return addDaysYmd(date, 1);
}

function isDateTimeAllowedForAttendanceDate(attendanceDate, inTime, outTime) {
  const date = ymd(attendanceDate);
  if (!date) return false;
  const start = Date.parse(`${date}T00:00:00+05:30`);
  const dayEnd = Date.parse(`${date}T23:59:59+05:30`);
  const nextDayCutoff = Date.parse(`${addOneDayYmd(date)}T${NIGHT_SHIFT_END}:00+05:30`);

  const inMs = inTime ? Date.parse(inTime) : NaN;
  const outMs = outTime ? Date.parse(outTime) : NaN;

  if (inTime && (!Number.isFinite(inMs) || inMs < start || inMs > dayEnd)) return false;
  if (outTime && (!Number.isFinite(outMs) || outMs < start || outMs > nextDayCutoff)) return false;
  if (inTime && outTime && Number.isFinite(inMs) && Number.isFinite(outMs) && outMs < inMs) return false;
  return true;
}

function withOtFields(row, byDcode, overtimeBufferMinutes) {
  const attached = byDcode ? attachEmp(row, byDcode) : row;
  return computeAttendanceDerived(attached, overtimeBufferMinutes);
}

async function saveAttendanceRow(client, row, manual = false, byDcode = null, overtimeBufferMinutes = null) {
  const enriched = withOtFields(row, byDcode, overtimeBufferMinutes);
  const params = buildAttendanceParams(enriched);
  if (!params) return null;
  const sql = manual ? INSERT_ATTENDANCE_SQL : UPSERT_ATTENDANCE_SQL;
  const result = client ? await client.query(sql, params) : await dbQuery(sql, params);
  const saved = client ? result.rows[0] : result[0];
  return saved ? formatRow(saved, byDcode, overtimeBufferMinutes) : null;
}

/** Map Location Master `approved` boolean helpers onto attendance `approval_status`. */
function applyAttendanceApprovalFields({ req, fields, incomingApproved, hasBusinessChanges, alreadyApproved }) {
  applyApprovalUpdateFields({
    req,
    fields,
    incomingApproved,
    hasBusinessChanges,
    alreadyApproved,
    auditAsName: true,
  });
  if (Object.prototype.hasOwnProperty.call(fields, "approved")) {
    fields.approval_status = fields.approved ? "approved" : "unapproved";
    delete fields.approved;
  }
}

export async function listAttendance(req, res) {
  try {
    const { page, limit, offset, filters, search: bodySearch } = extractHrmsListParams(req.body);
    const filterDcode = parseEmpDcode(filters?.emp_dcode);
    const fromDate = ymd(filters?.from_date ?? filters?.fromDate);
    const toDate = ymd(filters?.to_date ?? filters?.toDate);
    const search = String(filters?.search ?? bodySearch ?? "").trim();
    const shiftRaw = String(filters?.shift ?? "").trim().toUpperCase();
    const shift = shiftRaw === "A" || shiftRaw === "B" ? shiftRaw : "";
    const approvalRaw = String(filters?.approval_status ?? filters?.approval ?? "").trim().toLowerCase();
    const approval =
      approvalRaw === "approved" || approvalRaw === "unapproved" || approvalRaw === "pending"
        ? approvalRaw === "pending" ? "unapproved" : approvalRaw
        : "";

    // Always honor filters when sent (FE "server" mode). FE "quick" mode omits them.
    const where = [];
    const params = [];
    let p = 1;

    if (filterDcode) {
      where.push(`a.emp_dcode = $${p++}`);
      params.push(filterDcode);
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
        CAST(a.emp_dcode AS TEXT) ILIKE $${p}
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
        a.id, a.emp_dcode, a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(`a.${ATT_COL_IN}`)} AS "in",
        ${istTs(`a.${ATT_COL_OUT}`)} AS "out",
        a.shift, a.day_type, a.day_value,
        ${istTs("a.default_in")} AS default_in,
        ${istTs("a.default_out")} AS default_out,
        a.total_minutes, a.lunch, a.worked_minutes, a.ot_minutes, a.ot_approved,
        a.ot_approved_by, a.ot_remarks, a.entry_type, a.approval_status, a.approval_remarks,
        a.created_by, a.updated_by, a.approved_by,
        ${istTs("a.approved_at")} AS approved_at,
        ${istTs("a.ot_approved_at")} AS ot_approved_at,
        ${istTs("a.created_at")} AS created_at,
        ${istTs("a.updated_at")} AS updated_at
      FROM ${T.ATTENDANCE} a
      WHERE ${whereSql}
      ORDER BY a.attendance_date DESC, a.emp_dcode ASC
      LIMIT $${p++} OFFSET $${p++}
      `,
      [...params, limit, offset]
    );

    const { byDcode } = buildMasterMaps(await fetchEmpMaster());
    const overtime_buffer_minutes = await getHrmsOvertimeBufferMinutes();

    return res.json({
      success: true,
      data: rows.map((row) => formatRow(row, byDcode, overtime_buffer_minutes)),
      overtime_buffer_minutes,
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
      SELECT a.id, a.emp_dcode, a.name,
        to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(`a.${ATT_COL_IN}`)} AS "in",
        ${istTs(`a.${ATT_COL_OUT}`)} AS "out",
        a.shift, a.day_type, a.day_value, a.ot_minutes, a.ot_approved,
        a.entry_type, a.approval_status,
        ${istTs("a.default_in")} AS default_in,
        ${istTs("a.default_out")} AS default_out
      FROM ${T.ATTENDANCE} a
      WHERE a.attendance_date = $1::date
      `,
      [date]
    );

    const employees = await fetchEmpMaster();
    const { byDcode, codeToDcode } = buildMasterMaps(employees);
    const overtime_buffer_minutes = await getHrmsOvertimeBufferMinutes();

    if (previewType === "manual") {
      const data = savedRows
        .map((saved) =>
          formatRow(
            {
              id: saved.id,
              emp_dcode: saved.emp_dcode,
              name: saved.name || "",
              attendance_date: date,
              in: rowInTime(saved),
              out: rowOutTime(saved),
              shift: saved.shift === "B" || saved.shift === "A" ? saved.shift : "A",
              day_type: normalizeDayType(saved.day_type),
              day_value: saved.day_value,
              ot_minutes: saved.ot_minutes,
              ot_approved: saved.ot_approved,
              entry_type: saved.entry_type || "manual",
              approval_status: saved.approval_status || null,
              default_in: saved.default_in,
              default_out: saved.default_out,
            },
            byDcode,
            overtime_buffer_minutes
          )
        )
        .sort((a, b) => String(a.emp_code || "").localeCompare(String(b.emp_code || ""), undefined, { numeric: true }));
      return res.json({ success: true, date, data, total: data.length, overtime_buffer_minutes });
    }

    const punches = await dbQuery(
      `
      SELECT
        employee_code, name, "in", "out", shift,
        'device' AS source
      FROM (${LOG_DAILY_PUNCH_SQL}) p
      `,
      [date]
    );

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
    const savedMap = new Map(savedRows.map((row) => [parseEmpDcode(row.emp_dcode), row]));
    const data = punches
      .map((punch) => {
        const key = String(punch.employee_code || "").trim();
        if (!key) return null;
        if (!masterCodes.has(key)) return null;
        const empDcode = codeToDcode.get(key);
        if (!empDcode) return null;
        const saved = savedMap.get(empDcode);
        const alreadyExists = Boolean(saved?.id);
        const times = empTimeMap.get(key) || {};
        const resolved = applyNightDefaultOut(punch, date);
        return formatRow(
          {
            id: saved?.id || null,
            emp_dcode: empDcode,
            name: saved?.name || resolved.name || empNameMap.get(key) || "",
            attendance_date: date,
            in: rowInTime(resolved) || null,
            out: rowOutTime(resolved) || null,
            // Already saved → show/store DB shift; new punch rows may suggest from log.
            shift: alreadyExists
              ? (normalizeShift(saved?.shift) || "A")
              : (normalizeShift(resolved?.shift) || "A"),
            day_type: alreadyExists ? normalizeDayType(saved?.day_type) : "FD",
            day_value: alreadyExists ? saved?.day_value : dayTypeValue("FD"),
            ot_minutes: alreadyExists ? saved?.ot_minutes : null,
            ot_approved: alreadyExists ? saved?.ot_approved : 0,
            entry_type: saved?.entry_type || "automatic",
            approval_status: saved?.approval_status || null,
            already_exists: alreadyExists,
            default_in: alreadyExists ? saved?.default_in : times.default_in || null,
            default_out: alreadyExists ? saved?.default_out : times.default_out || null,
            out_defaulted: Boolean(resolved.out_defaulted),
          },
          byDcode,
          overtime_buffer_minutes
        );
      })
      .filter(Boolean)
      .sort((a, b) => String(a.emp_code || "").localeCompare(String(b.emp_code || ""), undefined, { numeric: true }));

    return res.json({ success: true, date, data, total: data.length, overtime_buffer_minutes });
  } catch (err) {
    console.error("[HRMS] previewAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

function hoursFieldsFromDerived(derived, overtimeBufferMinutes) {
  return {
    total_minutes: derived.total_minutes,
    lunch: derived.lunch,
    lunch_minutes: derived.lunch_minutes,
    worked_minutes: derived.worked_minutes,
    default_minutes: derived.default_minutes,
    full_default_minutes: derived.full_default_minutes,
    normal_minutes: derived.normal_minutes,
    ot_minutes: derived.ot_minutes,
    adjust_minutes: derived.adjust_minutes,
    overtime_buffer_minutes: overtimeBufferMinutes,
  };
}

/** Live hours while Add/Edit typing — same formulas as save/list. */
export async function calcAttendance(req, res) {
  try {
    const overtime_buffer_minutes = await getHrmsOvertimeBufferMinutes();
    const rawList = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
    const data = rawList.map((raw) => {
      const date = ymd(raw.attendance_date ?? raw.date);
      const times = parseAttendanceInOut(raw, {}, date);
      const derived = computeAttendanceDerived(
        {
          attendance_date: date,
          in: times.in,
          out: times.out,
          shift: raw.shift,
          day_type: raw.day_type,
          default_in: raw.default_in,
          default_out: raw.default_out,
        },
        overtime_buffer_minutes
      );
      return hoursFieldsFromDerived(derived, overtime_buffer_minutes);
    });
    const one = !Array.isArray(req.body?.rows);
    return res.json({ success: true, overtime_buffer_minutes, data: one ? data[0] : data });
  } catch (err) {
    console.error("[HRMS] calcAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function submitAttendance(req, res) {
  try {
    const body = req.body || {};
    const date = ymd(body.date ?? body.attendance_date);
    const entryType = String(body.entry_type ?? body.type ?? "automatic").toLowerCase() === "manual" ? "manual" : "automatic";
    const list = Array.isArray(body.rows) ? body.rows : body.emp_dcode || body.employee_code ? [body] : [];
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });
    if (isFutureAttendanceDate(date)) {
      return res.status(400).json({ success: false, message: "Future date is not allowed." });
    }
    if (!list.length) return res.status(400).json({ success: false, message: "Rows required." });

    const userName = auditUserName(req);
    const employees = await fetchEmpMaster();
    const { byDcode, codeToDcode } = buildMasterMaps(employees);
    const dcodeToCode = new Map([...codeToDcode.entries()].map(([code, dcode]) => [dcode, code]));
    let baselineMap = new Map();

    if (entryType === "automatic") {
      const punches = await dbQuery(`SELECT employee_code, "in", "out", shift FROM (${LOG_DAILY_PUNCH_SQL}) p`, [date]);
      baselineMap = new Map(
        punches.map((row) => {
          const code = String(row.employee_code || "").trim();
          const resolved = applyNightDefaultOut(row, date);
          return [
            code,
            punchFingerprint({
              in: rowInTime(resolved),
              out: rowOutTime(resolved),
              shift: normalizeShift(resolved?.shift) || "A",
            }),
          ];
        })
      );
    }

    const normalizedRows = [];
    const seenKeys = new Set();
    let skippedExisting = 0;

    let existingSet = new Set();
    if (entryType === "automatic") {
      const dcodes = list.map((raw) => resolveSubmitEmpDcode(raw, codeToDcode)).filter(Boolean);
      if (dcodes.length) {
        const existingRows = await dbQuery(
          `SELECT emp_dcode FROM ${T.ATTENDANCE} WHERE attendance_date = $1::date AND emp_dcode = ANY($2::int[])`,
          [date, dcodes]
        );
        existingSet = new Set(existingRows.map((row) => parseEmpDcode(row.emp_dcode)).filter(Boolean));
      }
    }

    for (const raw of list) {
      const empDcode = resolveSubmitEmpDcode(raw, codeToDcode);
      const empCode = dcodeToCode.get(empDcode) || String(raw.emp_code ?? raw.employee_code ?? "").trim();
      if (!empDcode || !normalizeShift(raw.shift) || seenKeys.has(empDcode)) continue;
      if (!byDcode.has(empDcode)) continue;
      seenKeys.add(empDcode);

      const exists = existingSet.has(empDcode);
      const override = raw.override === true || raw.override === 1 || raw.override === "true" || raw.override === "1";
      if (entryType === "automatic" && exists && !override) {
        skippedExisting += 1;
        continue;
      }

      const { in: inTime, out: outTime } = parseAttendanceInOut(raw, null, date);
      if (!inTime || !outTime) {
        return res.status(400).json({ success: false, message: `In and Out both required for ${empCode || empDcode}.` });
      }
      if (!isDateTimeAllowedForAttendanceDate(date, inTime, outTime)) {
        return res.status(400).json({ success: false, message: `Invalid in/out datetime for ${empCode || empDcode}.` });
      }
      const clientChanged = raw.edited === true || raw.edited === 1 || raw.edited === "true" || raw.edited === "1";

      const logFp = baselineMap.get(empCode);
      const submittedFp = punchFingerprint({ in: inTime, out: outTime, shift: raw.shift });
      const matchesLog = logFp != null && logFp === submittedFp;
      const rowEntryType =
        entryType === "manual" ? "manual" : clientChanged ? "automatic_edit" : "automatic";
      const needsApproval = entryType === "manual" || !matchesLog || clientChanged;
      const approvalStatus = needsApproval ? "unapproved" : "approved";

      normalizedRows.push({
        emp_dcode: empDcode,
        name: String(raw.name ?? "").trim() || byDcode.get(empDcode)?.emp_name || null,
        attendance_date: date,
        shift: normalizeShift(raw.shift),
        day_type: normalizeDayType(raw.day_type),
        in: inTime,
        out: outTime,
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
        `SELECT emp_dcode FROM ${T.ATTENDANCE}
         WHERE attendance_date = $1::date AND emp_dcode = ANY($2::int[])`,
        [date, normalizedRows.map((row) => row.emp_dcode)]
      );
      if (existingRows.length) {
        const existingDcodes = existingRows.map((row) => parseEmpDcode(row.emp_dcode)).filter(Boolean);
        const labels = existingDcodes.map((d) => dcodeToCode.get(d) || d);
        return res.status(409).json({ success: false, message: `Already exists: ${labels.join(", ")}`, existing_dcodes: existingDcodes });
      }
    }

    const overtime_buffer_minutes = await getHrmsOvertimeBufferMinutes();

    const result = await withTransaction(async (client) => {
      const saved = [];
      for (const row of normalizedRows) {
        const stored = await saveAttendanceRow(client, row, entryType === "manual", byDcode, overtime_buffer_minutes);
        if (stored) saved.push({ ...stored, needs_approval: row.needsApproval });
      }
      return saved;
    });

    if (!result.length) return res.status(400).json({ success: false, message: "Save failed." });

    const firstRow = result[0] || null;
    await logAttendance(req, {
      action: "create",
      entity_id: date,
      record: firstRow
        ? {
            attendance_date: date,
            entry_type: entryType,
            emp_dcode: firstRow.emp_dcode,
            emp_code: firstRow.emp_code,
            name: firstRow.name,
          }
        : { attendance_date: date, entry_type: entryType },
      details: { total: result.length, skipped_existing: skippedExisting },
    });

    const skipMsg = skippedExisting > 0 ? ` Skipped ${skippedExisting} existing (no override).` : "";
    return res.status(201).json({
      success: true,
      message: `Saved.${skipMsg}`,
      date,
      entry_type: entryType,
      data: result,
      overtime_buffer_minutes,
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
      SELECT id, emp_dcode, name, shift, day_type, day_value, ot_minutes, ot_approved,
        ot_approved_by, ot_remarks,
        to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
        ${istTs(ATT_COL_IN)} AS "in",
        ${istTs(ATT_COL_OUT)} AS "out",
        ${istTs("default_in")} AS default_in,
        ${istTs("default_out")} AS default_out,
        ${istTs("ot_approved_at")} AS ot_approved_at,
        entry_type, approval_status,
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
    const dayType = Object.prototype.hasOwnProperty.call(req.body, "day_type")
      ? normalizeDayType(req.body.day_type)
      : normalizeDayType(previous.day_type);
    const { in: inTime, out: outTime } = parseAttendanceInOut(req.body, previous, date);
    if (!inTime || !outTime) {
      return res.status(400).json({ success: false, message: "In and Out both are required." });
    }
    if (!isDateTimeAllowedForAttendanceDate(date, inTime, outTime)) {
      return res.status(400).json({ success: false, message: "Invalid in/out datetime for selected date." });
    }
    const changed =
      punchFingerprint(previous) !== punchFingerprint({ in: inTime, out: outTime, shift }) ||
      normalizeShift(previous.shift) !== shift ||
      normalizeDayType(previous.day_type) !== dayType;
    const canEdit = Boolean(req.permission?.can_edit) || String(req.user?.type || req.user?.role || "").toLowerCase().trim() === "super_admin";
    if (changed && !canEdit) {
      return res.status(403).json({ success: false, message: "You do not have edit permission." });
    }
    const incomingApproved = normalizeApprovedInput(req.body?.approved ?? req.body?.approval_status);
    const approvalRemarks = String(req.body?.approval_remarks || req.body?.remarks || "").trim();
    if (incomingApproved === true && !approvalRemarks) {
      return res.status(400).json({ success: false, message: "Remark is required." });
    }
    const nextEntryType = resolveEntryTypeOnUpdate(previous, changed);

    const { byDcode } = buildMasterMaps(await fetchEmpMaster());
    const overtime_buffer_minutes = await getHrmsOvertimeBufferMinutes();
    const otRow = withOtFields(
      {
        ...previous,
        name: String(req.body.name ?? previous.name ?? "").trim() || null,
        shift,
        day_type: dayType,
        attendance_date: date,
        in: inTime,
        out: outTime,
      },
      byDcode,
      overtime_buffer_minutes
    );

    const fields = {
      name: otRow.name,
      shift,
      day_type: dayType,
      day_value: otRow.day_value,
      default_in: otRow.default_in,
      default_out: otRow.default_out,
      total_minutes: otRow.total_minutes,
      lunch: otRow.lunch,
      worked_minutes: otRow.worked_minutes,
      ot_minutes: otRow.ot_minutes,
      ot_approved: changed ? otRow.ot_approved : normalizeOtApprovedFlag(previous.ot_approved),
      ot_approved_by: changed ? otRow.ot_approved_by : previous.ot_approved_by ?? null,
      ot_approved_at: changed ? otRow.ot_approved_at : previous.ot_approved_at ?? null,
      ot_remarks: changed ? otRow.ot_remarks : previous.ot_remarks ?? null,
      in: inTime,
      out: outTime,
      entry_type: nextEntryType,
      approval_status: previous.approval_status || "unapproved",
    };

    applyAttendanceApprovalFields({
      req,
      fields,
      incomingApproved,
      hasBusinessChanges: changed,
      alreadyApproved: isApprovedStatus(previous.approval_status),
    });

    if (incomingApproved === true) {
      fields.approval_remarks = approvalRemarks;
    } else if (!isApprovedStatus(fields.approval_status) && isApprovedStatus(previous.approval_status)) {
      fields.approval_remarks = null;
    }

    const params = [
      id,
      fields.name,
      fields.shift,
      fields.in,
      fields.out,
      fields.entry_type,
      fields.approval_status,
      fields.day_type,
      fields.day_value,
      fields.default_in,
      fields.default_out,
      fields.worked_minutes,
      fields.total_minutes,
      fields.lunch,
      fields.ot_minutes,
      fields.ot_approved,
      fields.ot_approved_by,
      fields.ot_approved_at,
      fields.ot_remarks,
    ];
    const setParts = [
      "name = COALESCE($2, name)",
      "shift = $3",
      `${ATT_COL_IN} = $4::timestamptz`,
      `${ATT_COL_OUT} = $5::timestamptz`,
      "entry_type = $6",
      "approval_status = $7",
      "day_type = $8",
      "day_value = $9",
      "default_in = $10::timestamptz",
      "default_out = $11::timestamptz",
      "worked_minutes = $12",
      "total_minutes = $13",
      "lunch = $14",
      "ot_minutes = $15",
      "ot_approved = $16",
      "ot_approved_by = $17",
      "ot_approved_at = $18::timestamptz",
      "ot_remarks = $19",
    ];

    // Edit → updated_* only; approve → approved_* only (Location Master pattern).
    if (fields.updated_by !== undefined) {
      params.push(fields.updated_by);
      setParts.push(`updated_by = $${params.length}`);
    }
    if (fields.updated_at !== undefined) {
      params.push(fields.updated_at);
      setParts.push(`updated_at = $${params.length}`);
    }
    if (fields.approved_by !== undefined) {
      params.push(fields.approved_by);
      setParts.push(`approved_by = $${params.length}`);
    }
    if (fields.approved_at !== undefined) {
      params.push(fields.approved_at);
      setParts.push(`approved_at = $${params.length}::timestamptz`);
    }
    if (fields.approval_remarks !== undefined) {
      params.push(fields.approval_remarks);
      setParts.push(`approval_remarks = $${params.length}`);
    }

    const rows = await dbQuery(
      `
      UPDATE ${ATT}
      SET ${setParts.join(",\n        ")}
      WHERE id = $1
      RETURNING ${ATT_RETURN}
      `,
      params
    );

    const data = formatRow(rows[0] || previous, byDcode, overtime_buffer_minutes);
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
      overtime_buffer_minutes,
    });
  } catch (err) {
    console.error("[HRMS] updateAttendance:", err);
    if (err.statusCode === 403 || err.statusCode === 409) {
      return res.status(err.statusCode).json({ success: false, message: err.message || "Forbidden." });
    }
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function deleteAttendance(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: "id is required." });

    const found = await dbQuery(
      `SELECT id, emp_dcode, name, shift,
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
