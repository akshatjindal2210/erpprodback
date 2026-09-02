import Holiday from "../models/holiday.model.js";
import { readSpreadsheetRecords } from "../../../lib/shared/utils/excelSheet.js";
import { isValidDate } from "../../../lib/shared/index.js";
import { assertWithinEditDays, isSuperAdminReq } from "../../../../core/lib/utils/auth/permissionDays.js";
import { paramsFromReq, idFromReq, listLimit } from "../../../lib/shared/postRequest.js";

function permissionViewDays(req) {
  if (isSuperAdminReq(req)) return 0;
  return Number(req.permission?.can_view_days) || 0;
}

function pickBulkRows(body = {}) {
  return body?.data ?? body?.records ?? body?.rows ?? [];
}

function normalizeHolidayDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isValidDate(s)) return s;

  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const day = String(parseInt(dmy[1], 10)).padStart(2, "0");
    const month = String(parseInt(dmy[2], 10)).padStart(2, "0");
    const year = dmy[3];
    const iso = `${year}-${month}-${day}`;
    return isValidDate(iso) ? iso : null;
  }

  return null;
}

function readRowField(row, keys = []) {
  if (!row || typeof row !== "object") return "";
  const lower = {};
  for (const [k, v] of Object.entries(row)) {
    lower[String(k).toLowerCase().replace(/[\s_\-./]+/g, "")] = v;
  }
  for (const key of keys) {
    const norm = String(key).toLowerCase().replace(/[\s_\-./]+/g, "");
    if (lower[norm] != null && String(lower[norm]).trim() !== "") return String(lower[norm]).trim();
  }
  return "";
}

/**
 * Normalize + dedupe file rows by date.
 * Marks invalid dates and dates already in DB for the same calendar day.
 */
async function buildBulkPreviewRows(rawRows = []) {
  const grouped = new Map();

  for (const raw of rawRows || []) {
    if (!raw || typeof raw !== "object") continue;

    const name = readRowField(raw, ["name", "Name", "holiday_name", "holiday"]).trim();
    const dateRaw = readRowField(raw, ["date", "Date", "holiday_date"]);
    const date = normalizeHolidayDate(dateRaw);

    if (!name) continue;

    if (!date) {
      const key = `invalid:${name.toLowerCase()}:${dateRaw || ""}`;
      if (grouped.has(key)) continue;
      grouped.set(key, {
        key,
        name,
        date: dateRaw || "",
        valid: false,
        error: "Invalid date — use YYYY-MM-DD or DD/MM/YYYY",
      });
      continue;
    }

    const key = date;
    if (grouped.has(key)) continue;

    grouped.set(key, {
      key,
      name,
      date,
      valid: true,
      error: null,
    });
  }

  const rows = Array.from(grouped.values()).sort(
    (a, b) => (a.date || "").localeCompare(b.date || "") || a.name.localeCompare(b.name)
  );
  const existing = await Holiday.findExistingDates(rows.map((r) => r.date).filter(Boolean));

  for (const row of rows) {
    if (!row.valid) continue;
    if (existing.has(row.date)) {
      row.valid = false;
      row.already_exists = true;
      row.error = "Already in database";
    }
  }

  return rows;
}

export async function getHolidays(req, res) {
  try {
    const {
      search = "",
      page = 1,
      limit = 1000,
      sortBy = "date",
      order = "ASC",
      dateFrom,
      dateTo,
    } = paramsFromReq(req);
    const viewDays = permissionViewDays(req);
    const pageNum = Number(page) || 1;
    const lim = listLimit(limit, 1000, 5000);

    const [holidays, total] = await Promise.all([
      Holiday.getAll({
        search,
        page: pageNum,
        limit: lim,
        sortBy,
        order,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        viewDays,
      }),
      Holiday.count({
        search,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        viewDays,
      }),
    ]);

    res.json({
      success: true,
      message: "Holidays fetched successfully",
      data: {
        page: pageNum,
        limit: lim,
        total,
        totalPages: Math.ceil(total / lim) || 1,
        data: holidays,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getHolidayById(req, res) {
  try {
    const id = idFromReq(req, "id", "holiday_id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid holiday id" });

    const rows = await Holiday.getById(id);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }

    res.json({ success: true, message: "Holiday fetched successfully", data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function createHoliday(req, res) {
  try {
    const { name, date } = paramsFromReq(req);

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Holiday name is required" });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: "Holiday date is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: "Invalid date format. Use YYYY-MM-DD" });
    }

    const result = await Holiday.create({ name: name.trim(), date });

    res.status(201).json({
      success: true,
      message: "Holiday created successfully",
      data: { id: result.insertId },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" || err.code === "23505") {
      return res.status(409).json({ success: false, message: "Holiday on this date already exists" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateHoliday(req, res) {
  try {
    const id = idFromReq(req, "id", "holiday_id");
    const { name, date } = paramsFromReq(req);

    if (!id) return res.status(400).json({ success: false, message: "Invalid holiday id" });
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Holiday name is required" });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: "Holiday date is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: "Invalid date format. Use YYYY-MM-DD" });
    }

    const rows = await Holiday.getById(id);
    const existing = rows?.[0];
    if (!existing) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }

    const blocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (blocked) {
      return res.status(blocked.status).json({ success: false, message: blocked.message });
    }

    const result = await Holiday.update(id, { name: name.trim(), date });

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }

    res.json({ success: true, message: "Holiday updated successfully" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" || err.code === "23505") {
      return res.status(409).json({ success: false, message: "Holiday on this date already exists" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function deleteHoliday(req, res) {
  try {
    const id = idFromReq(req, "id", "holiday_id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid holiday id" });

    const result = await Holiday.delete(id);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found" });
    }

    res.json({ success: true, message: "Holiday deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function previewBulkHolidays(req, res) {
  try {
    const raw = pickBulkRows(req.body);
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Upload rows are required." });
    }

    const rows = await buildBulkPreviewRows(raw);
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need name and date (YYYY-MM-DD or DD/MM/YYYY).",
      });
    }

    return res.json({
      success: true,
      data: rows,
      total: rows.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Preview failed." });
  }
}

export async function bulkCreateHolidays(req, res) {
  try {
    const raw = pickBulkRows(req.body);
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Upload rows are required." });
    }

    const rows = await buildBulkPreviewRows(raw);
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows. Need name and date (YYYY-MM-DD or DD/MM/YYYY).",
      });
    }

    const toInsert = rows.filter((r) => r.valid !== false && !r.already_exists);
    const skipped = rows.length - toInsert.length;

    if (!toInsert.length) {
      return res.status(200).json({
        success: true,
        message: `Nothing to import. ${skipped} skipped (invalid or already in database).`,
        count: 0,
        skipped,
      });
    }

    const result = await Holiday.bulkCreate(
      toInsert.map((r) => ({ name: r.name, date: r.date }))
    );

    return res.status(201).json({
      success: true,
      message: `${result.affectedRows || 0} holiday${result.affectedRows === 1 ? "" : "s"} imported.${skipped ? ` ${skipped} skipped.` : ""}`,
      count: result.affectedRows || 0,
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Import failed." });
  }
}

export async function bulkUploadHolidays(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }

    const records = await readSpreadsheetRecords(req.file, { defval: "" });
    const rows = await buildBulkPreviewRows(records);

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found. Use name and date columns (see Excel format).",
      });
    }

    const toInsert = rows.filter((r) => r.valid !== false && !r.already_exists);
    const skipped = rows.length - toInsert.length;

    if (!toInsert.length) {
      return res.status(400).json({
        success: false,
        message: `Nothing to import. ${skipped} skipped (invalid or already in database).`,
        data: { total: rows.length, inserted: 0, skipped },
      });
    }

    const result = await Holiday.bulkCreate(
      toInsert.map((r) => ({ name: r.name, date: r.date }))
    );

    res.status(201).json({
      success: true,
      message: `${result.affectedRows || 0} holiday${result.affectedRows === 1 ? "" : "s"} imported.${skipped ? ` ${skipped} skipped.` : ""}`,
      data: {
        total: rows.length,
        inserted: result.affectedRows || 0,
        skipped,
      },
    });
  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
