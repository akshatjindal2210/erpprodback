/** ERP — `ERP_REQUESTED_DATA` + `mjcnewFilter` edit. Debug: console.log({ requestedData: ERP_REQUESTED_DATA, filter }). */
import { syncToErp } from "../../../core/lib/services/erpSync.js";
import { fetchFromIMS, parseIndianFinancialYearBounds } from "../../../ims/lib/services/ims.service.js";
import { formatPJobCardNo } from "./jobCard.config.js";
import { parseProcessPlan } from "./processPlanStatus.js";

/** IMS `requestedData` — name change sirf yahan */
export const ERP_REQUESTED_DATA = "mjcnew";
export const JC_SERIES_CODE = 30;
export const ERP_ACC_CODE = 852;

let fyCache = { at: 0, rows: null };

function erpIds(card) {
  const jobcardno = Number(card?.jobcardno);
  const fyid = Number(card?.fyid);
  if (!(jobcardno > 0 && fyid > 0)) return null;
  const jc = Number(card?.jcseriescode);
  return { jobcardno, fyid, jcseriescode: jc > 0 ? jc : JC_SERIES_CODE };
}

export const mjcnewFilter = {
  add(card, acc_code = ERP_ACC_CODE) {
    const k = erpIds(card);
    const planqty = Number(card?.planqty);
    if (!k || !Number.isFinite(planqty)) return null;
    const d = String(card?.jobcarddt ?? "").trim().slice(0, 10);
    let maccode;
    for (const st of parseProcessPlan(card.process_plan)) {
      const n = Number(st?.machines?.[0]?.machine_id);
      if (n > 0) {
        maccode = n;
        break;
      }
    }
    return {
      type: "add",
      jobcardno: k.jobcardno,
      jcseriescode: k.jcseriescode,
      pjobcardno: String(card.pjobcardno ?? "").trim() || formatPJobCardNo(card.type, k.jobcardno),
      jobcarddt: /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : undefined,
      fyid: k.fyid,
      planqty,
      itemdcode: Number(card.itemdcode),
      maccode,
      acc_code: Number(acc_code ?? ERP_ACC_CODE),
    };
  },

  update(card) {
    const k = erpIds(card);
    const planqty = Number(card?.planqty);
    if (!k || !Number.isFinite(planqty)) return null;
    return { type: "update", jobcardno: k.jobcardno, fyid: k.fyid, jcseriescode: k.jcseriescode, planqty };
  },

  /** ERP delete — jobcardno + itemdcode + fy/series (not app docno). */
  delete(card) {
    const k = erpIds(card);
    const itemdcode = Number(card?.itemdcode);
    if (!k || !(itemdcode > 0)) return null;
    return {
      type: "delete",
      jobcardno: k.jobcardno,
      itemdcode,
      fyid: k.fyid,
      jcseriescode: k.jcseriescode,
    };
  },
};

async function erpSync(filter) {
  if (!filter) return false;
  const { type, ...data } = filter;
  // DEBUG — remove when ERP add/delete verified
  if (type === "add" || type === "delete") {
    console.log(`[mjcnew ERP ${type}]`, JSON.stringify({ requestedData: ERP_REQUESTED_DATA, filter }, null, 2));
  }
  const ok = await syncToErp(type, data, ERP_REQUESTED_DATA);
  if (type === "add" || type === "delete") {
    console.log(`[mjcnew ERP ${type}] erpSynced=`, ok);
  }
  return ok;
}

export async function syncJobCardErpAdd(card, { acc_code } = {}) {
  return erpSync(mjcnewFilter.add(card, acc_code ?? ERP_ACC_CODE));
}

export async function syncJobCardErpUpdate(card) {
  return erpSync(mjcnewFilter.update(card));
}

export async function syncJobCardErpDelete(card) {
  return erpSync(mjcnewFilter.delete(card));
}

export async function resolveFyidForJobCard(jobcarddt, overrideFyid = null) {
  if (overrideFyid != null && overrideFyid !== "") {
    const n = Number(overrideFyid);
    if (!(n > 0)) throw Object.assign(new Error("fyid must be a positive integer."), { statusCode: 400 });
    return n;
  }
  const s = String(jobcarddt ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw Object.assign(new Error("jobcarddt must be YYYY-MM-DD for fyid."), { statusCode: 400 });
  }
  const [y, m, d] = s.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  day.setHours(0, 0, 0, 0);
  const now = Date.now();
  if (!fyCache.rows || now - fyCache.at > 300000) {
    const rows = await fetchFromIMS("fyid");
    if (!rows?.length) throw Object.assign(new Error("ERP financial year list empty."), { statusCode: 502 });
    fyCache = { at: now, rows };
  }
  const t = day.getTime();
  for (const row of fyCache.rows) {
    const name = String(row?.fyname ?? row?.name ?? "").trim();
    if (!name) continue;
    try {
      const { from, to } = parseIndianFinancialYearBounds(name);
      if (t >= from.getTime() && t <= to.getTime()) {
        const id = Number(row.fyid ?? row.id);
        if (id > 0) return id;
      }
    } catch { /* next FY */ }
  }
  throw Object.assign(new Error(`No fyid for jobcarddt ${s}.`), { statusCode: 400 });
}

/** Next number = ERP max (mjcnew + prdrunjc for series) + 1 — not local prod_job_card. */
export async function nextJobcardno(jcseriescode, _fyid, _client = null) {
  const series = Number(jcseriescode) || JC_SERIES_CODE;
  let max = 0;
  for (const key of [ERP_REQUESTED_DATA, "prdrunjc"]) {
    try {
      for (const r of (await fetchFromIMS(key)) || []) {
        const jc = Number(r?.jcseriescode ?? r?.JCSeriesCode);
        if (jc > 0 && jc !== series) continue;
        let n = Number(r?.jobcardno ?? r?.JobCardNo);
        if (!(n > 0)) {
          const m = String(r?.pjobcardno ?? r?.PJobCardNo ?? "").match(/(\d+)$/);
          n = m ? Number(m[1]) : 0;
        }
        if (n > 0) max = Math.max(max, n);
      }
    } catch { /* try other ERP list */ }
  }
  return max + 1;
}
