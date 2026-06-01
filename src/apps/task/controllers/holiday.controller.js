import Holiday from "../models/holiday.model.js";
import XLSX from "xlsx";
import { isValidDate } from "../shared/index.js";

// GET /holidays
export async function getHolidays(req, res) {
  try {
    const { search = "", page = 1, limit = 10, sortBy = "date", order = "ASC", dateFrom, dateTo } = req.query;

    const [holidays, total] = await Promise.all([
      Holiday.getAll({ search, page, limit, sortBy, order, dateFrom, dateTo }),
      Holiday.count({ search, dateFrom, dateTo }),
    ]);

    res.json({
      success: true,
      message: "Holidays fetched successfully",
      data: {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
        data:       holidays,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /holidays/:id
export async function getHolidayById(req, res) {
  try {
    const rows = await Holiday.getById(req.params.id);

    if (!rows || rows.length === 0)
      return res.status(404).json({ success: false, message: "Holiday not found" });

    res.json({ success: true, message: "Holiday fetched successfully", data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// POST /holidays
export async function createHoliday(req, res) {
  try {
    const { name, date } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: "Holiday name is required" });
    if (!date)
      return res.status(400).json({ success: false, message: "Holiday date is required" });
    if (!isValidDate(date))
      return res.status(400).json({ success: false, message: "Invalid date format. Use YYYY-MM-DD" });

    const result = await Holiday.create({ name: name.trim(), date });

    res.status(201).json({
      success: true,
      message: "Holiday created successfully",
      data: { id: result.insertId },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ success: false, message: "Holiday with this name already exists" });

    res.status(500).json({ success: false, message: err.message });
  }
}

// PUT /holidays/:id
export async function updateHoliday(req, res) {
  try {
    const { id }         = req.params;
    const { name, date } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: "Holiday name is required" });
    if (!date)
      return res.status(400).json({ success: false, message: "Holiday date is required" });
    if (!isValidDate(date))
      return res.status(400).json({ success: false, message: "Invalid date format. Use YYYY-MM-DD" });

    const result = await Holiday.update(id, { name: name.trim(), date });

    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Holiday not found" });

    res.json({ success: true, message: "Holiday updated successfully" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ success: false, message: "Holiday with this name already exists" });

    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE /holidays/:id
export async function deleteHoliday(req, res) {
  try {
    const result = await Holiday.delete(req.params.id);

    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Holiday not found" });

    res.json({ success: true, message: "Holiday deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function bulkUploadHolidays(req, res) {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: "File is required" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    const rows = XLSX.utils.sheet_to_json(sheet, { 
      raw: false, 
      dateNF: "yyyy-mm-dd",
      defval: ""
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