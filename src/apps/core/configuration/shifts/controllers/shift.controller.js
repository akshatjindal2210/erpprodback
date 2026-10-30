import { findShifts, findShift, insertShift, updateShift, deleteShift } from "../models/shift.model.js";
import { extractListParams } from "../../../lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../lib/utils/helper/helper.js";
import { isShiftLunch, netShiftHours } from "../../../lib/utils/shift/shiftHours.util.js";

function parseTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:00`;
  }
  const s = String(value ?? "").trim();
  const iso = s.match(/T(\d{2}):(\d{2})/);
  const m = iso || s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

function enrichShift(row) {
  if (!row) return row;
  const { lunch, overnight, hours } = netShiftHours(row.start_time, row.end_time, row.lunch);
  return { ...row, lunch, overnight, hours };
}

function normalizeCode(raw) {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!code || code.length > 20) return null;
  if (!/^[A-Z0-9_-]+$/.test(code)) return null;
  return code;
}

export const getShifts = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "code",
      order: "ASC",
    });

    const result = await findShifts({
      filters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
    });

    return res.json({
      success: true,
      ...result,
      data: (result.data || []).map(enrichShift),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getShiftById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const shift = await findShift({ id });
    if (!shift) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data: enrichShift(shift) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createShift = async (req, res) => {
  try {
    const code = normalizeCode(req.body.code);
    const start_time = parseTime(req.body.start_time);
    const end_time = parseTime(req.body.end_time);

    if (!code) return res.status(400).json({ success: false, message: "Code required" });
    if (!start_time) return res.status(400).json({ success: false, message: "Start time required" });
    if (!end_time) return res.status(400).json({ success: false, message: "End time required" });
    if (start_time === end_time) {
      return res.status(400).json({ success: false, message: "Times cannot be same" });
    }

    const shift = await insertShift({
      code,
      start_time,
      end_time,
      lunch: isShiftLunch(req.body.lunch),
      is_active: req.body.is_active !== false && req.body.is_active !== "false",
    });

    res.status(201).json({ success: true, data: enrichShift(shift), message: "Created" });
  } catch (err) {
    const message = err?.code === "23505" ? "Code already exists" : err.message;
    res.status(err?.code === "23505" ? 400 : 500).json({ success: false, message });
  }
};

export const updateShiftData = async (req, res) => {
  try {
    const { id, code: codeRaw, start_time: startRaw, end_time: endRaw, lunch: lunchRaw, is_active } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findShift({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const fields = { updated_at: new Date() };
    if (codeRaw !== undefined) {
      const code = normalizeCode(codeRaw);
      if (!code) return res.status(400).json({ success: false, message: "Code required" });
      fields.code = code;
    }
    if (startRaw !== undefined) {
      const start_time = parseTime(startRaw);
      if (!start_time) return res.status(400).json({ success: false, message: "Invalid start time" });
      fields.start_time = start_time;
    }
    if (endRaw !== undefined) {
      const end_time = parseTime(endRaw);
      if (!end_time) return res.status(400).json({ success: false, message: "Invalid end time" });
      fields.end_time = end_time;
    }
    if (lunchRaw !== undefined) fields.lunch = isShiftLunch(lunchRaw);
    if (is_active !== undefined) {
      fields.is_active = is_active === true || is_active === "true" || is_active === 1;
    }

    const start = parseTime(fields.start_time ?? existing.start_time);
    const end = parseTime(fields.end_time ?? existing.end_time);
    if (start && end && start === end) {
      return res.status(400).json({ success: false, message: "Times cannot be same" });
    }

    const rows = await updateShift(fields, { id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data: enrichShift(rows[0]), message: "Updated" });
  } catch (err) {
    const message = err?.code === "23505" ? "Code already exists" : err.message;
    res.status(err?.code === "23505" ? 400 : 500).json({ success: false, message });
  }
};

export const toggleShiftStatus = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const existing = await findShift({ id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const rows = await updateShift({ is_active: !existing.is_active, updated_at: new Date() }, { id });

    res.json({ success: true, data: enrichShift(rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteShiftData = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const rows = await deleteShift({ id });
    if (!rows.length) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
