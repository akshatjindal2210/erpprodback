import dbQuery from "../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { extractHrmsListParams } from "../../../lib/listParams.js";
import { formatHrmsDateTime } from "../../../lib/hrmsFormat.js";
import { istTs, LOG_DATE_SQL } from "../../../lib/attendanceCommon.js";
import { fetchAcsEvents, fetchEmpMaster, hikvisionFetchImageBinary } from "../../../lib/erpApi.js";
import { deviceEventToRecord, extractDeviceEventImage, extractDeviceEvents } from "../../../lib/hikvisionEvents.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logHrmsActivity } from "../../../lib/utils/activity/logHrmsActivity.js";
import { createBoundedTtlCache, startCacheSweep } from "../../../lib/boundedTtlCache.js";

const ENTITY = "hrms_attendance_log";
const LOG_ACTIVE_SQL = "deleted_at IS NULL";
const ACS_CACHE_TTL_MS = 3 * 60 * 1000;
const IMAGE_MATCH_MAX_DIFF_MS = 5 * 60 * 1000;

/** Max calendar days indexed in RAM (visible scroll ≪ month). */
const acsSnapIndexByDay = createBoundedTtlCache({ ttlMs: ACS_CACHE_TTL_MS, maxEntries: 7, label: "acsSnapDay" });
const imageLookupCache = createBoundedTtlCache({ ttlMs: ACS_CACHE_TTL_MS, maxEntries: 512, label: "attLogImg" });
const acsDayInflight = new Map();

startCacheSweep(acsSnapIndexByDay);
startCacheSweep(imageLookupCache);

function buildSnapIndex(events) {
  const byCode = new Map();
  for (const event of events) {
    const record = deviceEventToRecord(event);
    const imageUrl = extractDeviceEventImage(event);
    if (!record || !imageUrl) continue;
    const code = String(record.employee_code ?? "").trim().toUpperCase();
    if (!code) continue;
    const rowMs = Date.parse(String(record.event_timestamp ?? ""));
    if (!Number.isFinite(rowMs)) continue;
    const sub = record.sub_event_type != null ? Number(record.sub_event_type) : null;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      imageUrl,
      rowMs,
      sub,
      employee_code: record.employee_code,
      event_timestamp: record.event_timestamp,
      sub_event_type: record.sub_event_type,
    });
  }
  for (const list of byCode.values()) list.sort((a, b) => a.rowMs - b.rowMs);
  return byCode;
}

/** One Hikvision fetch per calendar day (deduped while in flight). */
async function getSnapIndexForDay(ymd) {
  const day = String(ymd ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Map();
  const hit = acsSnapIndexByDay.get(day);
  if (hit) return hit;
  if (acsDayInflight.has(day)) return acsDayInflight.get(day);

  const load = fetchAcsEvents({ from: day, to: day })
    .then((events) => {
      const index = buildSnapIndex(events);
      acsSnapIndexByDay.set(day, index);
      return index;
    })
    .finally(() => {
      acsDayInflight.delete(day);
    });

  acsDayInflight.set(day, load);
  return load;
}

function attendanceImageJson(imageUrl, extra = {}) {
  const proxyPath = `/hrms/attendance-log/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  return {
    success: true,
    data: { image_url: proxyPath, image_proxy_url: proxyPath, source_image_url: imageUrl, ...extra },
  };
}

function pickFromSnapIndex(index, employeeCode, eventTs, subEventType) {
  const list = index.get(String(employeeCode ?? "").trim().toUpperCase());
  if (!list?.length) return null;
  const targetMs = Date.parse(String(eventTs ?? ""));
  if (!Number.isFinite(targetMs)) return null;
  const sub = subEventType != null && subEventType !== "" ? Number(subEventType) : null;

  let best = null;
  const consider = (snap) => {
    const diff = Math.abs(snap.rowMs - targetMs);
    if (diff > IMAGE_MATCH_MAX_DIFF_MS) return;
    if (!best || diff < best.diff) best = { imageUrl: snap.imageUrl, diff, snap };
  };

  if (Number.isFinite(sub)) {
    for (const snap of list) {
      if (snap.sub === sub) consider(snap);
    }
  }
  if (!best) {
    for (const snap of list) consider(snap);
  }
  return best;
}

async function findAttendanceEventImageUrl(employeeCode, eventTs, subEventType) {
  const lk = `${String(employeeCode ?? "").trim().toUpperCase()}|${String(eventTs ?? "").trim()}|${subEventType ?? ""}`;
  if (imageLookupCache.has(lk)) return imageLookupCache.get(lk);

  let index = new Map();
  let indexLoaded = false;
  try {
    index = await getSnapIndexForDay(String(eventTs ?? "").slice(0, 10));
    indexLoaded = true;
  } catch (err) {
    console.warn("[HRMS] findAttendanceEventImageUrl:", err?.message || err);
    throw err;
  }

  const best = pickFromSnapIndex(index, employeeCode, eventTs, subEventType);
  const match = best
    ? {
        url: best.imageUrl,
        record: {
          employee_code: best.snap.employee_code,
          event_timestamp: best.snap.event_timestamp,
          sub_event_type: best.snap.sub_event_type,
        },
      }
    : null;
  if (indexLoaded) imageLookupCache.set(lk, match);
  return match;
}

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

  // Includes soft-deleted rows — sync must not re-insert device events user removed.
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
    if (!events.length) {
      return res.json({ success: true, message: "No machine events.", total: 0, data: [] });
    }

    const saved = await saveEventsFromBody({ InfoList: events });
    const data = saved.map(formatLogRow);
    if (data.length) {
      await logHrmsActivity(req, {
        action: "create",
        entity: ENTITY,
        entity_id: from || to || "sync",
        record: { from: from || null, to: to || null },
        details: { total: data.length, fetched: events.length },
      });
    }
    return res.json({
      success: true,
      message: data.length ? `Synced ${data.length} new log(s).` : "No new logs (already synced).",
      total: data.length,
      data,
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
      return res.json(
        attendanceImageJson(directImageUrl, {
          employee_code: employeeCode || null,
          event_timestamp: eventTs || null,
          sub_event_type: Number.isFinite(subEventType) ? subEventType : null,
        })
      );
    }
    if (!employeeCode || !eventTs || !/^\d{4}-\d{2}-\d{2}/.test(eventTs)) {
      return res.status(400).json({ success: false, message: "employee_code and valid event_timestamp are required." });
    }

    let match;
    try {
      match = await findAttendanceEventImageUrl(employeeCode, eventTs, subEventType);
    } catch (err) {
      console.error("[HRMS] getAttendanceLogImage:", err?.message || err);
      return res.status(502).json({ success: false, message: err?.message || "Image fetch failed." });
    }
    if (!match?.url) return res.json({ success: true, data: null, message: "Image not found." });
    return res.json(
      attendanceImageJson(match.url, {
        employee_code: match.record.employee_code,
        event_timestamp: match.record.event_timestamp,
        sub_event_type: match.record.sub_event_type,
      })
    );
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
    res.setHeader("Cache-Control", "private, max-age=86400");
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

    where.push(LOG_ACTIVE_SQL);

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

export async function deleteAttendanceLog(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "id is required." });
    }

    const found = await dbQuery(`SELECT id, employee_code, name, ${EVENT_TS_SQL} AS event_timestamp FROM ${T.ATTENDANCE_LOG} WHERE id = $1 AND ${LOG_ACTIVE_SQL}`, [id]);
    const existing = found[0];
    if (!existing) return res.status(404).json({ success: false, message: "Not found." });

    const deletedBy = auditUserName(req);
    await dbQuery(`UPDATE ${T.ATTENDANCE_LOG} SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [id, deletedBy]);

    const data = { ...existing, deleted_by: deletedBy };
    await logHrmsActivity(req, {
      action: "delete",
      entity: ENTITY,
      entity_id: id,
      record: data,
      details: { deleted_by: deletedBy },
    });

    return res.json({ success: true, message: "Deleted.", data });
  } catch (err) {
    console.error("[HRMS] deleteAttendanceLog:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
