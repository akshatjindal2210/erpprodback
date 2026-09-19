import { extractHrmsListParams } from "../../../lib/listParams.js";
import { toEmployeePickerRow } from "../../../lib/config/views/employeeHelperViews.js";
import { attachMachineSync, fetchEmpMaster, fetchEmpMasterRaw, fetchLiveMachineMatch, filterEmployeesLocal, hikvisionAddUser, hikvisionBlockUser, mapEmployeeRecord, sortEmployeesLocal } from "../../../lib/erpApi.js";
import { createHrmsActivityLogger } from "../../../lib/utils/activity/logHrmsActivity.js";

const ENTITY = "hrms_employee";
const logEmployee = createHrmsActivityLogger(ENTITY);

function employeeRecord(row = {}) {
  return {
    emp_code: String(row.emp_code ?? row.employeeNo ?? "").trim(),
    emp_name: String(row.emp_name ?? row.name ?? "").trim(),
  };
}

function hikvisionValidWindow(enable) {
  return {
    enable,
    beginTime: "2020-01-01T00:00:00",
    endTime: "2037-12-31T23:59:59",
  };
}

export function buildEmployeeUserInfo(row = {}, enable = true) {
  return {
    UserInfo: {
      employeeNo: String(row.emp_code ?? "").trim(),
      name: String(row.emp_name ?? "").trim(),
      userType: "normal",
      onlyVerify: true,
      Valid: hikvisionValidWindow(enable),
    },
  };
}

async function saveMachineUserStatus(req, res, { enable, successMessage, failMessage, logTag }) {
  try {
    const row = req.body.employee || req.body;
    const userInfo = buildEmployeeUserInfo(row, enable);
    const { employeeNo, name } = userInfo.UserInfo;
    if (!employeeNo || !name) {
      return res.status(400).json({ success: false, message: "Employee code and name are required." });
    }

    const response = await hikvisionAddUser(userInfo);
    if (!response?.ok || response?.json?.success === false) {
      const errMsg = response?.json?.message || response?.json?.data?.errorMsg || response?.json?.data?.statusString || failMessage;
      return res.status(502).json({ success: false, message: errMsg, data: userInfo, response: response?.json ?? null, requestedData: ["add"] });
    }

    logEmployee(
      req,
      "update",
      employeeNo,
      { operation: enable ? "machine_update" : "machine_deactivate" },
      employeeRecord(row)
    );
    return res.json({ success: true, message: response?.json?.message || successMessage, data: userInfo, response: response?.json ?? null, requestedData: ["add"] });
  } catch (err) {
    console.error(logTag, err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function updateEmployeeOnMachine(req, res) {
  return saveMachineUserStatus(req, res, {
    enable: true,
    successMessage: "Machine updated.",
    failMessage: "Machine update failed.",
    logTag: "[HRMS] updateEmployeeOnMachine:",
  });
}

export async function deactivateEmployeeOnMachine(req, res) {
  try {
    const row = req.body.employee || req.body;
    const userInfo = {
      employeeNo: String(row.emp_code ?? "").trim(),
      name: String(row.emp_name ?? "").trim(),
      userType: "blackList",
    };
    if (!userInfo.employeeNo || !userInfo.name) {
      return res.status(400).json({ success: false, message: "Employee code and name are required." });
    }
    const response = await hikvisionBlockUser(userInfo);
    if (!response?.ok || response?.json?.success === false) {
      const errMsg = response?.json?.message || response?.json?.data?.errorMsg || response?.json?.data?.statusString || "Machine deactivation failed.";
      return res.status(502).json({
        success: false,
        message: errMsg,
        data: { UserInfo: userInfo },
        response: response?.json ?? null,
        requestedData: ["block"],
      });
    }
    logEmployee(req, "update", userInfo.employeeNo, { operation: "machine_deactivate" }, employeeRecord(row));
    return res.json({
      success: true,
      message: response?.json?.message || "Machine user deactivated.",
      data: { UserInfo: userInfo },
      response: response?.json ?? null,
      requestedData: ["block"],
    });
  } catch (err) {
    console.error("[HRMS] deactivateEmployeeOnMachine:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

async function listEmployeesBase(req, res, syncMachine = false) {
  try {
    const { page, limit, offset, filters, search, sortBy, order } = extractHrmsListParams(req.body);
    const { employees: mapped, matched: machineCodes } = syncMachine ? await fetchLiveMachineMatch(filters, { refreshMachine: true }) : await fetchLiveMachineMatch(filters, { cacheOnly: true });
    const filtered = filterEmployeesLocal(mapped, { search, filters });
    const sorted = sortEmployeesLocal(filtered, sortBy, order);
    const merged = attachMachineSync(sorted, machineCodes);
    const data = merged.slice(offset, offset + limit);

    if (syncMachine) {
      logEmployee(req, "update", "sync", {
        operation: "machine_sync",
        total: sorted.length,
        machine_matched: machineCodes?.length ?? 0,
      });
    }

    return res.json({ success: true, data, total: sorted.length, page, limit });
  } catch (err) {
    console.error(syncMachine ? "[HRMS] syncEmployees:" : "[HRMS] listEmployees:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}

export async function listEmployees(req, res) {
  return listEmployeesBase(req, res, false);
}

export async function syncEmployees(req, res) {
  return listEmployeesBase(req, res, true);
}

export async function getEmployee(req, res) {
  try {
    const body = req.body || {};
    const empCode = String(body.emp_code ?? "").trim();
    const empDcode = body.emp_dcode;
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

export async function getEmployeesHelper(req, res) {
  try {
    const body = req.body || {};
    const lookupId = body.id ?? body.emp_dcode;
    const empCode = String(body.emp_code ?? "").trim();

    if (lookupId != null && String(lookupId).trim() !== "" || empCode) {
      const json = await fetchEmpMasterRaw({ emp_code: empCode, emp_dcode: lookupId });
      const records = Array.isArray(json.records) ? json.records : [];
      if (!records.length) return res.json({ success: true, data: null });
      return res.json({ success: true, data: toEmployeePickerRow(mapEmployeeRecord(records[0])) });
    }

    const { page, limit, offset, filters, search, sortBy, order } = extractHrmsListParams(body);
    const mapped = await fetchEmpMaster(filters);
    const filtered = filterEmployeesLocal(mapped, { search, filters });
    const sorted = sortEmployeesLocal(filtered, sortBy, order);

    return res.json({
      success: true,
      data: sorted.slice(offset, offset + limit).map(toEmployeePickerRow),
      total: sorted.length,
      page,
      limit,
    });
  } catch (err) {
    console.error("[HRMS] getEmployeesHelper:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
}
