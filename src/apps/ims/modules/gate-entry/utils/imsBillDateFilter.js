/**
 * IMS invmnote / invfnote date filters for Gate Entry.
 * Shape (IMS-safe): billdt >= '2Apr2026' and billdt <= '6Aug2026'
 * Do NOT put billno in the SQL filter — slashes in HPF/… break IMS queries.
 */

const IMS_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatImsBilldtToken(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getDate()}${IMS_MON[dt.getMonth()]}${dt.getFullYear()}`;
}

/** Parse DocDt / billdt from QR or IMS into a local Date (00:00). */
export function parseBillDateHint(raw) {
  const s0 = String(raw ?? "").trim();
  if (!s0) return null;

  // 22/07/2026 or 22-07-2026
  const dmy = s0.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const dd = parseInt(dmy[1], 10);
    const mm = parseInt(dmy[2], 10);
    const y = parseInt(dmy[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const d = new Date(y, mm - 1, dd);
      if (d.getFullYear() === y && d.getMonth() === mm - 1 && d.getDate() === dd) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
  }

  // 2026-07-22
  const iso = s0.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const mm = parseInt(iso[2], 10);
    const dd = parseInt(iso[3], 10);
    const d = new Date(y, mm - 1, dd);
    if (d.getFullYear() === y && d.getMonth() === mm - 1 && d.getDate() === dd) {
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  // 22Jul2026 / 2Apr2026
  const monTok = /^(\d{1,2})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{4})$/i.exec(s0);
  if (monTok) {
    const dd = parseInt(monTok[1], 10);
    const y = parseInt(monTok[3], 10);
    const monIdx = IMS_MON.findIndex((x) => x.toLowerCase() === monTok[2].toLowerCase());
    if (monIdx >= 0) {
      const d = new Date(y, monIdx, dd);
      if (d.getFullYear() === y && d.getMonth() === monIdx && d.getDate() === dd) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
  }

  // 29-08-2026 16:53 (IMS display)
  const dmyTime = s0.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s|$)/);
  if (dmyTime) {
    const dd = parseInt(dmyTime[1], 10);
    const mm = parseInt(dmyTime[2], 10);
    const y = parseInt(dmyTime[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const d = new Date(y, mm - 1, dd);
      if (d.getFullYear() === y && d.getMonth() === mm - 1 && d.getDate() === dd) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
  }

  return null;
}

/** Indian FY containing `anchor` (default today): 1 Apr Y … 31 Mar Y+1 */
export function indianFinancialYearBounds(anchor = new Date()) {
  const d = anchor instanceof Date ? new Date(anchor) : new Date();
  if (Number.isNaN(d.getTime())) return indianFinancialYearBounds(new Date());
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = d.getMonth();
  const startYear = m >= 3 ? y : y - 1;
  const from = new Date(startYear, 3, 1);
  const to = new Date(startYear + 1, 2, 31);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return {
    from,
    to,
    label: `${startYear}-${startYear + 1}`,
  };
}

export function buildImsBilldtRangeFilter(from, to) {
  const a = formatImsBilldtToken(from);
  const b = formatImsBilldtToken(to);
  return `billdt >= '${a}' and billdt <= '${b}'`;
}

/**
 * Resolve IMS billdt filter for gate entry.
 * Default end = today (IMS-safe). Full FY end only when useTodayAsEnd=false.
 * Optional minFrom — clamp range start (e.g. pending only from 26 Aug 2026).
 */
export function resolveGateImsBilldtFilter(bill_dt_hint, options = {}) {
  const { useTodayAsEnd = true, minFrom = null } = options;
  const parsed = parseBillDateHint(bill_dt_hint);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const clampFrom = (from) => {
    if (!(minFrom instanceof Date) || Number.isNaN(minFrom.getTime())) return from;
    const m = new Date(minFrom);
    m.setHours(0, 0, 0, 0);
    return from < m ? m : from;
  };

  if (parsed) {
    const { from: fyFrom, to, label } = indianFinancialYearBounds(parsed);
    let from = clampFrom(fyFrom);
    let end = useTodayAsEnd ? (today < to ? today : to) : to;
    if (parsed > end) end = parsed < to ? parsed : to;
    if (end < from) end = from;
    return {
      filter: buildImsBilldtRangeFilter(from, end),
      from,
      to: end,
      label,
      source: "scan_fy",
    };
  }

  const { from: fyFrom, to, label } = indianFinancialYearBounds(today);
  let from = clampFrom(fyFrom);
  let end = useTodayAsEnd && today < to ? today : to;
  if (end < from) end = from;
  return {
    filter: buildImsBilldtRangeFilter(from, end),
    from,
    to: end,
    label,
    source: "current_fy",
  };
}

/**
 * Gate Entry Pending ONLY — bills on/after this date (inclusive).
 * Complete register (`listGateEntries` / findGateRows) does NOT use this.
 */
export const GATE_PENDING_MIN_BILL_DT = new Date(2026, 8, 1); // 1 Sep 2026 
// export const GATE_PENDING_MIN_BILL_DT = new Date(2026, 7, 30); // 26 Aug 2026
