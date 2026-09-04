import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { saveHikvisionEventsFromBody, hikvisionWebhookAuthorized, EVENT_TS_SQL, CREATED_AT_SQL } from "../../../lib/attendanceEvents.js";
import { HRMS_ATTENDANCE_TZ } from "../../../lib/attendanceDaily.js";

const LOG_DATE_SQL = `(event_timestamp AT TIME ZONE '${HRMS_ATTENDANCE_TZ}')::date`;

function formatLogRow(row) {
  const ts = row.event_timestamp || null;
  const loggedAt = row.created_at || null;
  return {
    ...row,
    event_datetime_display: ts ? formatHrmsDateTime(ts) : null,
    created_at_display: loggedAt ? formatHrmsDateTime(loggedAt) : null,
  };
}

export async function ingestHikvisionEvents(req, res) {
  if (!hikvisionWebhookAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Invalid webhook secret." });
  }

  // Device ko turant 200 — warna retry / offline mark karega
  res.sendStatus(200);

  console.log(`\n--- [${new Date().toLocaleTimeString()}] New Event Received ---`);

  if (req.body) {
    Object.keys(req.body).forEach((key) => {
      console.log(`Field Name: ${key}`);
      console.log("Payload Data:\n", req.body[key]);
    });
  }

  if (req.files?.length > 0) {
    req.files.forEach((file) => {
      console.log(`Attachment Found: ${file.fieldname}`);
      console.log(`MimeType: ${file.mimetype} | Size: ${file.size} bytes`);
    });
  }

  try {
    const saved = await saveHikvisionEventsFromBody(req.body);
    if (saved.length) {
      console.log(`Inserted ${saved.length} attendance row(s)`);
      saved.forEach((row) => console.log(row));
    }
  } catch (err) {
    console.error("[HRMS] Insert failed:", err.message);
  }
}

export async function listAttendanceLogs(req, res) {
  try {
    const { page, limit, offset, filters, sortBy, order } = extractHrmsListParams(req.body);
    const where = [];
    const params = [];
    let p = 1;

    const employee = String(filters?.employee_code ?? filters?.employee ?? "").trim();
    if (employee) {
      where.push(`employee_code ILIKE $${p++}`);
      params.push(`%${employee}%`);
    }
    const fromDate = String(filters?.from_date ?? filters?.fromDate ?? "").trim().slice(0, 10);
    if (fromDate) {
      where.push(`${LOG_DATE_SQL} >= $${p++}::date`);
      params.push(fromDate);
    }
    const toDate = String(filters?.to_date ?? filters?.toDate ?? "").trim().slice(0, 10);
    if (toDate) {
      where.push(`${LOG_DATE_SQL} <= $${p++}::date`);
      params.push(toDate);
    }
    const search = String(filters?.search ?? req.body?.search ?? "").trim();
    if (search) {
      where.push(`(employee_code ILIKE $${p} OR name ILIKE $${p} OR status ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sortColMap = {
      id: "id",
      employee_code: "employee_code",
      name: "name",
      status: "status",
      event_timestamp: "event_timestamp",
      created_at: "created_at",
    };
    const sortCol = sortColMap[String(sortBy || "event_timestamp").toLowerCase()] || "event_timestamp";
    const sortDir = String(order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const total = (await dbQuery(`SELECT COUNT(*)::int AS total FROM ${T.ATTENDANCE_LOG} ${whereSql}`, params))[0]?.total ?? 0;
    const rows = await dbQuery(
      `SELECT id, employee_code, name, status, label, auth_method, sub_event_type, event_name,
        attendance_status, card_reader_no, device_name, source, created_by,
        ${EVENT_TS_SQL} AS event_timestamp,
        ${CREATED_AT_SQL} AS created_at
       FROM ${T.ATTENDANCE_LOG} ${whereSql}
       ORDER BY ${sortCol} ${sortDir}, id DESC LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    return res.json({ success: true, data: rows.map(formatLogRow), total, page, limit });
  } catch (err) {
    console.error("[HRMS] listAttendanceLogs:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
