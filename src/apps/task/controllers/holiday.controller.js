import Holiday from "../models/holiday.model.js";
import XLSX from "xlsx";
import { isValidDate } from "../shared/index.js";
import { assertWithinEditDays, isSuperAdminReq } from "../../core/utils/permissionDays.js";
import { paramsFromReq, idFromReq, listLimit } from "../shared/postRequest.js";

function permissionViewDays(req) {
  if (isSuperAdminReq(req)) return 0;
  return Number(req.permission?.can_view_days) || 0;
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
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Holiday with this name already exists" });
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
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Holiday with this name already exists" });
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

export async function bulkUploadHolidays(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      dateNF: "yyyy-mm-dd",
      defval: "",
    });

    const validRows = [];
    const invalidRows = [];

    rows.forEach((row, index) => {
      const name = (row.name || row.Name || row.holiday_name || "").toString().trim();
      const date = (row.date || row.Date || "").toString().trim();

      if (!name || !date) {
        invalidRows.push({ rowNumber: index + 2, reason: "Name or Date missing" });
        return;
      }

      validRows.push({ name, date });
    });

    if (validRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found",
        data: { invalidRows },
      });
    }

    const result = await Holiday.bulkCreate(validRows);

    res.status(201).json({
      success: true,
      message: "Bulk upload completed",
      data: {
        total: rows.length,
        inserted: result.affectedRows,
        skipped: validRows.length - result.affectedRows,
        invalidRows,
      },
    });
  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
