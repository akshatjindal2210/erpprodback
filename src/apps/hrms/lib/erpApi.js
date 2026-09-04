/** HRMS internal ERP gateway + employee master helpers. POST config.hrmsErpApi.url → { requestedData, filter? } */
import fetch from "node-fetch";
import config from "../../../config/app/config.js";
import { formatHrmsTime } from "./hrmsFormat.js";

const ERP = config.hrmsErpApi;

function sqlQuote(v) {
  return `'${String(v ?? "").replace(/'/g, "''")}'`;
}
function eqString(col, value) {
  const v = String(value ?? "").trim();
  return v ? `${col}=${sqlQuote(v)}` : null;
}
function eqNumber(col, value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${col}=${n}` : null;
}
function andFilter(parts = []) {
  const list = parts.filter(Boolean);
  return list.length ? list.join(" AND ") : null;
}

function buildEmpFilter(filters = {}) {
  return andFilter([
    eqString("EmpCode", filters.emp_code ?? filters.employee_code),
    eqNumber("deptcode", filters.deptcode),
    eqNumber("brcode", filters.brcode),
  ]);
}
function buildEmpGetFilter({ emp_code, emp_dcode, EmpCode, EmpDcode } = {}) {
  const code = String(emp_code ?? EmpCode ?? "").trim();
  if (code) return eqString("EmpCode", code);
  const dcode = emp_dcode ?? EmpDcode;
  return dcode != null && String(dcode).trim() !== "" ? eqNumber("EmpDcode", dcode) : null;
}

async function erpPost(requestedData, filter) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ERP.timeoutMs);
  let norm = filter;
  if (norm != null && typeof norm !== "object") {
    const t = String(norm).trim();
    if (!t) norm = undefined;
    else {
      const n = Number(t);
      norm = Number.isFinite(n) && String(n) === t ? n : t;
    }
  }
  try {
    const res = await fetch(ERP.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedData, ...(norm != null ? { filter: norm } : {}) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = {};
    try {
      json = text?.trim() ? JSON.parse(text) : {};
    } catch {
      json = { success: false, message: "Non-JSON ERP response" };
    }
    return { ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFromHrms(requestedData, filter = null) {
  try {
    const { json } = await erpPost(requestedData, filter);
    if (!json?.success) return [];
    const rec = json.records;
    if (Array.isArray(rec)) return rec;
    if (rec != null && typeof rec === "object") return [rec];
    return [];
  } catch (err) {
    console.warn("[HRMS ERP]", requestedData, err.message);
    return [];
  }
}

export async function fetchHrmsDataRaw(requestedData, filter = null) {
  try {
    const { ok, json } = await erpPost(requestedData, filter);
    if (!ok) return { success: false, records: json?.records ?? [], message: json?.message || "ERP failed" };
    return json;
  } catch (err) {
    return { success: false, records: [], message: err.message };
  }
}

export function mapEmployeeRecord(r) {
  const empIn = r.empintime ?? r.EmpInTime;
  const empOut = r.empouttime ?? r.EmpOutTime;
  const lunchIn = r.emplintime ?? r.EmpLInTime;
  const lunchOut = r.emplouttime ?? r.EmpLOutTime;
  return {
    emp_code: r.EmpCode ?? r.emp_code ?? r.empcode,
    emp_dcode: r.EmpDcode ?? r.emp_dcode ?? r.empdcode,
    emp_name: r.EmpName ?? r.emp_name ?? r.empname,
    emp_fname: r.empfname ?? r.EmpFname ?? r.emp_fname,
    brcode: r.brcode ?? r.BrCode,
    deptcode: r.deptcode ?? r.DeptCode,
    deptname: r.deptname ?? r.DeptName,
    emp_intime: empIn,
    emp_outtime: empOut,
    emp_lintime: lunchIn,
    emp_louttime: lunchOut,
    emp_intime_display: formatHrmsTime(empIn),
    emp_outtime_display: formatHrmsTime(empOut),
    emp_lintime_display: formatHrmsTime(lunchIn),
    emp_louttime_display: formatHrmsTime(lunchOut),
    calc_ot_alw1: r.calcotalw1 ?? r.CalcOtAlw1,
    ot_alw2_less: r.otalw2_less ?? r.OtAlw2Less,
    lrdcode: r.lrdcode ?? r.LrdCode,
    ot_allow: r.otallow ?? r.OtAllow,
    pauthorise: r.pauthorise ?? r.PAuthorise,
    authorise: r.authorise ?? r.Authorise,
    stop_ot_calc_except_sund: r.StopOTCalcExceptSund ?? r.stop_ot_calc_except_sund,
  };
}

export async function fetchEmpMaster(filters = {}) {
  return (await fetchFromHrms("hrmsempmaster", buildEmpFilter(filters))).map(mapEmployeeRecord);
}

export async function fetchEmpMasterRaw(params = {}) {
  return fetchHrmsDataRaw("hrmsempmaster", buildEmpGetFilter(params));
}

export function filterEmployeesLocal(rows, { search, filters } = {}) {
  const q = String(search ?? filters?.search ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    [row.emp_code, row.emp_name, row.emp_fname, row.deptcode, row.deptname]
      .filter((v) => v != null && String(v).trim())
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

export function sortEmployeesLocal(rows, sortBy = "emp_code", order = "ASC") {
  const key = String(sortBy || "emp_code").toLowerCase();
  const mul = String(order || "ASC").toUpperCase() === "DESC" ? -1 : 1;
  const pick = (row) => {
    const v = row[key];
    return v == null ? "" : typeof v === "number" ? v : String(v).toLowerCase();
  };
  return [...rows].sort((a, b) => (pick(a) < pick(b) ? -1 : pick(a) > pick(b) ? 1 : 0) * mul);
}
