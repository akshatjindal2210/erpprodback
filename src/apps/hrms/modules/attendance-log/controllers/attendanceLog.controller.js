import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs, LOG_DATE_SQL } from "../../../lib/attendanceCommon.js";
import { fetchAcsEvents, fetchEmpMaster, hikvisionFetchImageBinary } from "../../../lib/erpApi.js";
import { deviceEventToRecord, extractDeviceEventImage, extractDeviceEvents } from "../../../lib/hikvisionEvents.js";

async function getMasterEmployeeCodes() {
  const employees = await fetchEmpMaster();
  const codes = new Set(employees.map((row) => String(row.emp_code ?? "").trim().toUpperCase()).filter(Boolean));
  return codes;
}

function matchesMasterEmployeeCode(code, masterCodes) {
  const normalized = String(code ?? "").trim().toUpperCase();
  return Boolean(normalized && masterCodes.has(normalized));
}

const EVENT_TS_SQL = istTs("event_timestamp");
const CREATED_AT_SQL = istTs("created_at");

const INSERT_LOG_SQL = `
  INSERT INTO ${T.ATTENDANCE_LOG} (
    employee_code, name, sub_event_type, event_name, card_reader_no,
    auth_method, status, event_timestamp
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
  RETURNING id, employee_code, name, sub_event_type, event_name, card_reader_no,
    auth_method, status,
    ${EVENT_TS_SQL} AS event_timestamp,
    ${CREATED_AT_SQL} AS created_at
`;

function formatLogRow(row) {
  const ts = row.event_timestamp || null;
  const loggedAt = row.created_at || null;
  return {
    ...row,
    event_datetime_display: ts ? formatHrmsDateTime(ts) : null,
    created_at_display: loggedAt ? formatHrmsDateTime(loggedAt) : null,
  };
}

async function insertLogRecord(record) {
  if (String(record?.source || "").toLowerCase() === "manual") return null;

  const exists = await dbQuery(
    `SELECT id FROM ${T.ATTENDANCE_LOG}
     WHERE employee_code = $1
       AND event_timestamp = $2::timestamptz
       AND COALESCE(sub_event_type, 0) = COALESCE($3, 0)
     LIMIT 1`,
    [record.employee_code, record.event_timestamp, record.sub_event_type]
  );
  if (exists.length) return null;

  const rows = await dbQuery(INSERT_LOG_SQL, [
    record.employee_code,
    record.name,
    record.sub_event_type,
    record.event_name,
    record.card_reader_no,
    record.auth_method,
    record.status,
    record.event_timestamp,
  ]);
  return rows[0] || null;
}

async function saveEventsFromBody(body) {
  const masterCodes = await getMasterEmployeeCodes();
  const saved = [];
  for (const event of extractDeviceEvents(body)) {
    const record = deviceEventToRecord(event);
    if (!record) continue;
    if (!matchesMasterEmployeeCode(record.employee_code, masterCodes)) continue;
    const row = await insertLogRecord(record);
    if (row) saved.push(row);
  }
  return saved;
}

export async function ingestHikvisionEvents(req, res) {
  if (req.headers.key !== "DUMMY_LIVE_KEY") return res.status(401).json({ success: false, message: "Invalid key." });
  res.sendStatus(200);
  saveEventsFromBody(req.body).catch(() => {});
}

export async function syncAttendanceLogs(req, res) {
  try {
    const from = req.body?.from ?? req.body?.fromDate ?? "";
    const to = req.body?.to ?? req.body?.toDate ?? "";
    const events = await fetchAcsEvents({ from, to });
    if (!events.length) return res.json({ success: true, message: "Done.", total: 0, data: [] });

    const saved = await saveEventsFromBody({ InfoList: events });
    return res.json({
      success: true,
      message: "Done.",
      total: saved.length,
      data: saved,
    });
  } catch (err) {
    console.error("[HRMS] syncAttendanceLogs:", err);
    const msg = err.message || "Server error.";
    if (msg.includes("hikconnect") || msg.includes("AcsEvent") || msg.includes("JSON message")) {
      return res.status(502).json({ success: false, message: msg });
    }
    return res.status(500).json({ success: false, message: msg });
  }
}

export async function getAttendanceLogImage(req, res) {
  try {
    const employeeCode = String(req.body?.employee_code ?? "").trim();
    const eventTs = String(req.body?.event_timestamp ?? "").trim();
    const subEventType = req.body?.sub_event_type != null ? Number(req.body.sub_event_type) : null;
    const directImageUrl = String(req.body?.image_url ?? req.body?.source_image_url ?? "").trim();
    if (directImageUrl) {
      const fetched = await hikvisionFetchImageBinary(directImageUrl);
      const imageDataUrl = fetched?.buffer?.length ? `data:${fetched.contentType || "image/jpeg"};base64,${fetched.buffer.toString("base64")}` : "";
      const proxyPath = `/api/hrms/attendance-log/image-proxy?url=${encodeURIComponent(directImageUrl)}`;
      return res.json({
        success: true,
        data: {
          image_url: imageDataUrl || proxyPath,
          image_data_url: imageDataUrl,
          image_proxy_url: proxyPath,
          source_image_url: directImageUrl,
          employee_code: employeeCode || null,
          event_timestamp: eventTs || null,
          sub_event_type: Number.isFinite(subEventType) ? subEventType : null,
        },
      });
    }

    if (!employeeCode || !eventTs) {
      return res.status(400).json({ success: false, message: "employee_code and event_timestamp are required." });
    }

    const date = eventTs.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: "Valid event_timestamp is required." });
    }
    const targetMs = Date.parse(eventTs);
    let events = [];
    try {
      events = await fetchAcsEvents({ from: date, to: date });
    } catch (firstErr) {
      console.warn("[HRMS] getAttendanceLogImage: date-range fetch failed, retrying without date.", firstErr?.message || firstErr);
      try {
        events = await fetchAcsEvents({});
      } catch (retryErr) {
        console.error("[HRMS] getAttendanceLogImage: fallback fetch failed.", retryErr?.message || retryErr);
        return res.status(502).json({ success: false, message: retryErr?.message || "Image fetch failed." });
      }
    }
    let best = null;

    for (const event of events) {
      const record = deviceEventToRecord(event);
      if (!record) continue;
      if (String(record.employee_code ?? "").trim().toUpperCase() !== employeeCode.toUpperCase()) continue;
      if (Number.isFinite(subEventType) && record.sub_event_type != null && Number(record.sub_event_type) !== subEventType) continue;
      const imageUrl = extractDeviceEventImage(event);
      if (!imageUrl) continue;
      const rowMs = Date.parse(String(record.event_timestamp ?? ""));
      const diff = Number.isFinite(targetMs) && Number.isFinite(rowMs) ? Math.abs(rowMs - targetMs) : Number.MAX_SAFE_INTEGER;
      if (!best || diff < best.diff) best = { imageUrl, diff, record };
    }

    if (!best) return res.json({ success: true, data: null, message: "Image not found." });

    const fetched = await hikvisionFetchImageBinary(best.imageUrl);
    const imageDataUrl = fetched?.buffer?.length ? `data:${fetched.contentType || "image/jpeg"};base64,${fetched.buffer.toString("base64")}` : "";
    const proxyPath = `/api/hrms/attendance-log/image-proxy?url=${encodeURIComponent(best.imageUrl)}`;

    return res.json({
      success: true,
      data: {
        image_url: imageDataUrl || proxyPath,
        image_data_url: imageDataUrl,
        image_proxy_url: proxyPath,
        source_image_url: best.imageUrl,
        employee_code: best.record.employee_code,
        event_timestamp: best.record.event_timestamp,
        sub_event_type: best.record.sub_event_type,
      },
    });
  } catch (err) {
    console.error("[HRMS] getAttendanceLogImage:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function getAttendanceLogImageProxy(req, res) {
  try {
    const imageUrl = String(req.query?.url ?? "").trim();
    if (!imageUrl) return res.status(400).send("Missing image url.");
    const fetched = await hikvisionFetchImageBinary(imageUrl);
    if (!fetched?.buffer?.length) return res.status(404).send("Image not found.");
    res.setHeader("Content-Type", fetched.contentType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(fetched.buffer);
  } catch (err) {
    console.error("[HRMS] getAttendanceLogImageProxy:", err);
    return res.status(502).send("Image fetch failed.");
  }
}

export async function listAttendanceLogs(req, res) {
  try {
    const { page, limit, offset, filters, sortBy, order } = extractHrmsListParams(req.body);
    const where = [];
    const params = [];
    let p = 1;

    const masterCodes = await getMasterEmployeeCodes();
    if (masterCodes.size) {
      where.push(`UPPER(TRIM(employee_code)) = ANY($${p++}::text[])`);
      params.push([...masterCodes]);
    }

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
      `SELECT id, employee_code, name, status, auth_method, sub_event_type, event_name,
        card_reader_no,
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
