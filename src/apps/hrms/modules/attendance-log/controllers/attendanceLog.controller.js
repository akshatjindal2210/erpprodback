import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { saveHikvisionEventsFromBody, EVENT_TS_SQL, CREATED_AT_SQL } from "../../../lib/attendanceEvents.js";
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
  if (req.headers.key !== "DUMMY_LIVE_KEY") return res.status(401).json({ success: false, message: "Invalid key." });
  res.sendStatus(200);
  console.log("[HRMS LIVE]", req.body);
  saveHikvisionEventsFromBody(req.body)
    .then((saved) => console.log("[HRMS LIVE] saved", saved))
    .catch((err) => console.log("[HRMS LIVE] fail", err.message));
}

export async function syncAttendanceLogs(req, res) {
  try {
    const from = req.body?.from || "";
    const to = req.body?.to || "";
    const pull = await fetch("http://192.168.1.100:3200/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    const json = await pull.json();
    console.log("[HRMS SYNC]", json);
    if (json?.success === false) return res.status(502).json({ success: false, message: json?.message || "request failed." });

    const events = json?.data?.AcsEvent?.InfoList || [];
    if (!events.length) return res.json({ success: true, message: "No live events.", total: 0, data: [] });

    const saved = await saveHikvisionEventsFromBody({ EventList: events });
    console.log("[HRMS SYNC] saved", saved);
    return res.json({
      success: true,
      message: `Synced ${saved.length} new, skipped ${events.length - saved.length} existing.`,
      total: saved.length,
      data: saved,
    });
  } catch (err) {
    console.error("[HRMS] syncAttendanceLogs:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
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
