import fetch from "node-fetch";
import config from "../../../config/app/config.js";
import { formatHrmsTime } from "./hrmsFormat.js";

const ERP = config.hrmsErpApi;
const IMS_URL = ERP.url;
// Hikvision endpoint for machine APIs like add/list.
const HIK_URL = ERP.hikconnectUrl;
const HIK_USER_SEARCH = { searchID: "1", maxResults: 500 };
const MACHINE_CACHE_MS = 2 * 60 * 1000;
let machineCodesCache = { at: 0, codes: null, pull: null };

async function postJson(url, requestedData, filter = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ERP.timeoutMs);
  try {
    const body = { requestedData };
    if (filter != null && String(filter).trim() !== "") body.filter = filter;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, json: text?.trim() ? JSON.parse(text) : {} };
    } catch {
      return { ok: res.ok, json: { success: false, message: "Non-JSON API response" } };
    }
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : err?.message || "fetch failed";
    return {
      ok: false,
      json: { success: false, message: `Cannot reach Hikvision API (${url}): ${reason}`, messagesystem: reason },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function toRecords(data) {
  const rec = data?.records;
  if (Array.isArray(rec)) return rec;
  if (rec && typeof rec === "object") return [rec];
  return [];
}

export async function fetchFromHrms(requestedData, filter = null) {
  try {
    const { json } = await postHrmsErpApi(requestedData, filter);
    return json?.success ? toRecords(json) : [];
  } catch {
    return [];
  }
}

export async function fetchHrmsDataRaw(requestedData, filter = null) {
  try {
    const { ok, json } = await postHrmsErpApi(requestedData, filter);
    return ok ? json : { success: false, records: json?.records ?? [], message: json?.message || "ERP failed" };
  } catch (err) {
    return { success: false, records: [], message: err.message };
  }
}

// Final public API functions
export async function postHrmsErpApi(requestedData, filter = null) {
  return postJson(IMS_URL, requestedData, filter);
}

export async function postHikconnectApi(requestedData, filter = null) {
  const payload = { requestedData, ...(filter != null && String(filter).trim() !== "" ? { filter } : {}) };
  // console.log("[HRMS][Hikvision][Request]", JSON.stringify(payload));
  const response = await postJson(HIK_URL, requestedData, filter);
  // console.log("[HRMS][Hikvision][Response]", JSON.stringify(response?.json ?? {}));
  return response;
}

// Hikvision: add one employee/user to machine.
export async function hikvisionAddUser(userInfo) {
  return postHikconnectApi("add", userInfo);
}

// Hikvision: block/deactivate one user on machine.
export async function hikvisionBlockUser(userInfo) {
  return postHikconnectApi("blacklist", { UserInfo: userInfo });
}

// Hikvision: list/search users from machine.
export async function hikvisionListUsers(userInfoSearchCond) {
  return postHikconnectApi("list", { UserInfoSearchCond: userInfoSearchCond });
}

// Hikvision: list attendance log events from machine.
export async function hikvisionListLogs(acsEventCond) {
  return postHikconnectApi("sync", { AcsEventCond: acsEventCond });
}

function normalizeHikvisionImageString(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s.startsWith("data:image/")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 80) return `data:image/jpeg;base64,${compact}`;
  return `data:image/jpeg;base64,${Buffer.from(s, "latin1").toString("base64")}`;
}

function bufferFromImageField(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (s.startsWith("data:image/")) {
    const b64 = s.split(",")[1] || "";
    if (!b64) return null;
    try {
      return Buffer.from(b64, "base64");
    } catch {
      return null;
    }
  }
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 80) {
    try {
      return Buffer.from(compact, "base64");
    } catch {
      return null;
    }
  }
  return Buffer.from(s, "latin1");
}

export async function hikvisionFetchImageBinary(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ERP.timeoutMs);
  try {
    const payload = { requestedData: "image", filter: imageUrl };
    console.log("[HRMS][Hikvision][Request]", JSON.stringify(payload));
    const res = await fetch(HIK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const utf8 = bytes.toString("utf8");
    let json = null;
    try {
      const t = utf8.trim();
      if (t.startsWith("{") || t.startsWith("[")) json = JSON.parse(t);
    } catch {
      json = null;
    }
    if (json) {
      const rawField = json?.data ?? json?.image ?? json?.imageBase64 ?? json?.base64 ?? "";
      const fromField = bufferFromImageField(rawField);
      if (fromField?.length) {
        console.log("[HRMS][Hikvision][Response]", JSON.stringify({ success: json?.success, hasImage: true, mode: "json-field" }));
        return { ok: res.ok, buffer: fromField, contentType: "image/jpeg", raw: json };
      }
    }
    console.log("[HRMS][Hikvision][Response]", JSON.stringify({ success: res.ok, hasImage: bytes.length > 0, mode: "binary" }));
    return { ok: res.ok, buffer: bytes, contentType: "image/jpeg", raw: json || { success: res.ok } };
  } finally {
    clearTimeout(timer);
  }
}

export async function hikvisionFetchImage(imageUrl) {
  const result = await hikvisionFetchImageBinary(imageUrl);
  const imageSrc = result?.buffer?.length ? `data:image/jpeg;base64,${result.buffer.toString("base64")}` : normalizeHikvisionImageString("");
  return { ok: result.ok, imageSrc, raw: result.raw };
}

function hikIstRange(from, to) {
  const f = String(from ?? "").trim().slice(0, 10);
  const t = String(to ?? "").trim().slice(0, 10);
  const out = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) out.startTime = `${f}T00:00:00+05:30`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out.endTime = `${t}T23:59:59+05:30`;
  return out;
}

function hikEventFilter(searchResultPosition, from, to) {
  return { searchID: "1", searchResultPosition, maxResults: 30, major: 5, minor: 75, ...hikIstRange(from, to) };
}

function hikReadAcs(json) {
  return json?.data?.AcsEvent ?? json?.AcsEvent ?? null;
}

// Hikvision: fetch attendance log events by date range.
export async function fetchAcsEvents({ from = "", to = "" } = {}) {
  const events = [];
  const first = await hikvisionListLogs(hikEventFilter(0, from, to));
  if (!first.ok || !first.json?.success) {
    const sys = first.json?.messagesystem ? ` (${first.json.messagesystem})` : "";
    const msg =
      first.json?.data?.errorMsg ||
      first.json?.message ||
      "hikconnect AcsEvent list failed";
    throw new Error(`${msg}${sys}`);
  }
  const acs0 = hikReadAcs(first.json);
  if (acs0?.InfoList?.length) events.push(...acs0.InfoList);
  const step = Number(acs0?.numOfMatches) || 30;
  const total = Number(acs0?.totalMatches) || 0;
  if (total > step) {
    const pages = [];
    for (let pos = step; pos < total; pos += step) pages.push(pos);
    const rows = await Promise.all(pages.map((pos) => hikvisionListLogs(hikEventFilter(pos, from, to)).then((r) => r.json)));
    for (const json of rows) {
      if (!json?.success) continue;
      const acs = hikReadAcs(json);
      if (acs?.InfoList?.length) events.push(...acs.InfoList);
    }
  }
  return events;
}

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
    eqString("EmpCode", filters.emp_code),
    eqNumber("deptcode", filters.deptcode),
    eqNumber("brcode", filters.brcode),
  ]);
}
function buildEmpGetFilter({ emp_code, emp_dcode } = {}) {
  const code = String(emp_code ?? "").trim();
  if (code) return eqString("EmpCode", code);
  const dcode = emp_dcode;
  return dcode != null && String(dcode).trim() !== "" ? eqNumber("EmpDcode", dcode) : null;
}
function collectUserInfoCodes(payload, into) {
  const search = payload?.UserInfoSearch ?? payload?.data?.UserInfoSearch;
  if (!search) return;
  const users = search.UserInfo;
  const list = Array.isArray(users) ? users : users ? [users] : [];
  for (const u of list) {
    const code = String(u?.employeeNo ?? u?.employeeNoString ?? "").trim().toUpperCase();
    if (code) into.add(code);
  }
}

export function mapEmployeeRecord(r) {
  const empIn = r.empintime;
  const empOut = r.empouttime;
  return {
    emp_code: r.EmpCode,
    emp_dcode: r.EmpDcode,
    emp_name: r.EmpName,
    brcode: r.brcode,
    deptcode: r.deptcode,
    deptname: r.deptname,
    emp_intime: empIn,
    emp_outtime: empOut,
    emp_intime_display: formatHrmsTime(empIn),
    emp_outtime_display: formatHrmsTime(empOut),
    calc_ot_alw1: r.calcotalw1,
    ot_alw2_less: r.otalw2_less,
    lrdcode: r.lrdcode,
    ot_allow: r.otallow,
    pauthorise: r.pauthorise,
    authorise: r.authorise,
    stop_ot_calc_except_sund: r.StopOTCalcExceptSund,
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
    [row.emp_code, row.emp_name, row.deptcode, row.deptname]
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

export function attachMachineSync(rows, machineCodes) {
  if (!machineCodes?.size) return rows.map((row) => ({ ...row, machine_sync_display: "" }));
  const codes = machineCodes instanceof Set ? machineCodes : new Set(machineCodes);
  return rows.map((row) => {
    const code = String(row.emp_code ?? "").trim().toUpperCase();
    return { ...row, machine_sync_display: code && codes.has(code) ? "Synced" : "" };
  });
}

async function pullMachineEmployeeCodesFresh() {
  // Reads employee codes from Hikvision user list for sync matching.
  const codes = new Set();
  const first = await hikvisionListUsers({ ...HIK_USER_SEARCH, searchResultPosition: 0 });
  if (!first.ok || !first.json?.success) return codes;
  collectUserInfoCodes(first.json, codes);
  collectUserInfoCodes(first.json?.data, codes);
  const search = first.json?.data?.UserInfoSearch ?? first.json?.UserInfoSearch;
  const step = Number(search?.numOfMatches) || 30;
  const total = Number(search?.totalMatches) || 0;
  if (total > step) {
    const positions = [];
    for (let pos = step; pos < total; pos += step) positions.push(pos);
    const pages = await Promise.all(
      positions.map((pos) => hikvisionListUsers({ ...HIK_USER_SEARCH, searchResultPosition: pos }).then((r) => r.json))
    );
    for (const json of pages) {
      if (json?.success) {
        collectUserInfoCodes(json, codes);
        collectUserInfoCodes(json?.data, codes);
      }
    }
  }
  return codes;
}

async function pullMachineEmployeeCodes({ refresh = false, cacheOnly = false } = {}) {
  const now = Date.now();
  if (!refresh && machineCodesCache.codes && now - machineCodesCache.at < MACHINE_CACHE_MS) return machineCodesCache.codes;
  if (cacheOnly) return new Set();
  if (!refresh && machineCodesCache.pull) return machineCodesCache.pull;
  machineCodesCache.pull = pullMachineEmployeeCodesFresh()
    .then((codes) => {
      machineCodesCache = { at: Date.now(), codes, pull: null };
      return codes;
    })
    .catch((err) => {
      machineCodesCache.pull = null;
      throw err;
    });
  return machineCodesCache.pull;
}

export async function fetchLiveMachineMatch(filters = {}, options = {}) {
  // Employee master + Hikvision list match by employee code.
  const [employees, machineCodes] = await Promise.all([
    fetchEmpMaster(filters),
    pullMachineEmployeeCodes({ refresh: options.refreshMachine === true, cacheOnly: options.cacheOnly === true }),
  ]);
  const masterCodes = new Set(employees.map((row) => String(row.emp_code ?? "").trim().toUpperCase()).filter(Boolean));
  return { employees, matched: new Set([...machineCodes].filter((code) => masterCodes.has(code))) };
}
