import { readSheet } from "read-excel-file/node";

function formatCellValue(value, defval = "") {
  if (value == null || value === "") return defval;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseCsvRecords(buffer, { defval = "" } = {}) {
  const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  const records = [];

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const record = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const val = values[index] ?? defval;
      record[header] = val;
      if (val !== defval && val !== "") hasValue = true;
    });

    if (hasValue) records.push(record);
  }

  return records;
}

function rowsToRecords(rows, { defval = "" } = {}) {
  if (!rows?.length) return [];

  const headers = rows[0].map((cell) => formatCellValue(cell).trim());
  const records = [];

  for (const row of rows.slice(1)) {
    const record = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const val = formatCellValue(row[index], defval);
      record[header] = val;
      if (val !== defval && val !== "") hasValue = true;
    });

    if (hasValue) records.push(record);
  }

  return records;
}

function isCsvFile(file) {
  const name = String(file?.originalname || "").toLowerCase();
  return file?.mimetype === "text/csv" || name.endsWith(".csv");
}

function isLegacyXlsFile(file) {
  const name = String(file?.originalname || "").toLowerCase();
  return file?.mimetype === "application/vnd.ms-excel" || name.endsWith(".xls");
}

export async function readSpreadsheetRecords(file, { defval = "" } = {}) {
  if (!file?.buffer) return [];

  if (isCsvFile(file)) {
    return parseCsvRecords(file.buffer, { defval });
  }

  if (isLegacyXlsFile(file)) {
    throw new Error("Legacy .xls files are not supported. Please save the file as .xlsx or CSV.");
  }

  const rows = await readSheet(file.buffer);
  return rowsToRecords(rows, { defval });
}
