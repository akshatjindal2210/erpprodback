import { extractHrmsListParams } from "../../../lib/listParams.js";
import { toEmployeePickerRow } from "../../../lib/config/views/employeeHelperViews.js";
import { fetchEmpMaster, fetchEmpMasterRaw, filterEmployeesLocal, mapEmployeeRecord, sortEmployeesLocal } from "../../../lib/erpApi.js";

export async function listEmployees(req, res) {
  try {
    const { page, limit, offset, filters, search, sortBy, order } = extractHrmsListParams(req.body);
    const mapped = await fetchEmpMaster(filters);
    const filtered = filterEmployeesLocal(mapped, { search, filters });
    const sorted = sortEmployeesLocal(filtered, sortBy, order);
    return res.json({
      success: true,
      data: sorted.slice(offset, offset + limit),
      total: sorted.length,
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] listEmployees:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function getEmployee(req, res) {
  try {
    const body = req.body || {};
    const empCode = String(body.emp_code ?? body.EmpCode ?? "").trim();
    const empDcode = body.emp_dcode ?? body.EmpDcode;
    if (!empCode && (empDcode == null || String(empDcode).trim() === "")) {
      return res.status(400).json({ success: false, message: "emp_code or emp_dcode is required." });
    }
    const json = await fetchEmpMasterRaw({ emp_code: empCode, emp_dcode: empDcode });
    const records = Array.isArray(json.records) ? json.records : [];
    if (!records.length) return res.status(404).json({ success: false, message: "Employee not found." });
    return res.json({ success: true, data: mapEmployeeRecord(records[0]) });
  } catch (err) {
    console.error("[HRMS] getEmployee:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

/** Compact employee picker — permission checked on calling page (not hrms_employee). */
export async function getEmployeesHelper(req, res) {
  try {
    const body = req.body || {};
    const lookupId = body.id ?? body.emp_dcode;
    const empCode = String(body.emp_code ?? body.EmpCode ?? "").trim();

    if (lookupId != null && String(lookupId).trim() !== "" || empCode) {
      const json = await fetchEmpMasterRaw({
        emp_code: empCode,
        emp_dcode: lookupId,
      });
      const records = Array.isArray(json.records) ? json.records : [];
      if (!records.length) return res.json({ success: true, data: null });
      return res.json({ success: true, data: toEmployeePickerRow(mapEmployeeRecord(records[0])) });
    }

    const { page, limit, offset, filters, search, sortBy, order } = extractHrmsListParams(body);
    const mapped = await fetchEmpMaster(filters);
    const filtered = filterEmployeesLocal(mapped, { search, filters });
    const sorted = sortEmployeesLocal(filtered, sortBy, order);
    const slice = sorted.slice(offset, offset + limit).map(toEmployeePickerRow);

    return res.json({
      success: true,
      data: slice,
      total: sorted.length,
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] getEmployeesHelper:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
