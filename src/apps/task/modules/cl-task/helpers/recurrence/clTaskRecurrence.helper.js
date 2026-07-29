import { getISTDateString, toYmd } from "../time/clTaskTime.helper.js";

export function parseRecurrenceArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Clamp day_offset to 0–14. */
export function clampDayOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(14, Math.floor(n));
}

/** Add calendar days to a YYYY-MM-DD string (UTC-safe, no TZ shift). */
export function addDaysYmd(ymd, days) {
  const base = toYmd(ymd) || getISTDateString();
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

/** First scheduled occurrence for a frequently task (today IST + day_offset). */
export function computeClFirstOccurrence(dayOffset = 0) {
  return addDaysYmd(getISTDateString(), clampDayOffset(dayOffset));
}

export function validateClRecurrence({ recurrence_type, recurrence_weekdays, recurrence_month_dates, recurrence_year_dates }) {
  if (recurrence_type === "weekly" && recurrence_weekdays.length === 0) {
    return "Select at least one day for weekly recurrence";
  }
  if (recurrence_type === "monthly" && recurrence_month_dates.length === 0) {
    return "Select at least one date for monthly recurrence";
  }
  if (recurrence_type === "yearly" && recurrence_year_dates.length === 0) {
    return "Select at least one date for yearly recurrence";
  }
  return null;
}

export function buildRecurrencePayload(body) {
  return {
    recurrence_weekdays: parseRecurrenceArray(body.recurrence_weekdays),
    recurrence_month_dates: parseRecurrenceArray(body.recurrence_month_dates),
    recurrence_year_dates: parseRecurrenceArray(body.recurrence_year_dates),
  };
}

function parseYmdParts(ymd) {
  const s = toYmd(ymd) || getISTDateString();
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d, ymd: s };
}

function ymdFromUtcParts(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function weekdayFromYmd(ymd) {
  const { y, m, d } = parseYmdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
}

/** Normalize FE keys "0"–"6" and names sun/mon/… → 0–6. */
function normalizeWeekdays(weekdays) {
  const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return weekdays
    .map((raw) => {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      const s = String(raw).trim().toLowerCase();
      if (/^\d+$/.test(s)) return Number(s);
      return dayMap[s] ?? -1;
    })
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => a - b);
}

/** True if ymd is a scheduled occurrence day for this recurrence (not “next after”). */
export function isClOccurrenceDay(recurrence_type, data = {}, ymd = null) {
  const day = toYmd(ymd) || getISTDateString();
  const weekdays = Array.isArray(data.recurrence_weekdays) ? data.recurrence_weekdays : [];
  const monthDates = Array.isArray(data.recurrence_month_dates) ? data.recurrence_month_dates : [];
  const yearDates = Array.isArray(data.recurrence_year_dates) ? data.recurrence_year_dates : [];

  if (recurrence_type === "daily" || !recurrence_type) return true;

  if (recurrence_type === "weekly") {
    const days = normalizeWeekdays(weekdays);
    if (!days.length) return true;
    return days.includes(weekdayFromYmd(day));
  }

  if (recurrence_type === "monthly") {
    const sorted = monthDates.map(Number).filter((n) => !Number.isNaN(n) && n >= 1 && n <= 31);
    if (!sorted.length) return true;
    const { d } = parseYmdParts(day);
    return sorted.includes(d);
  }

  if (recurrence_type === "yearly") {
    if (!yearDates.length) return true;
    const { m, d } = parseYmdParts(day);
    const mmdd = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return yearDates.map(String).includes(mmdd);
  }

  return true;
}

/**
 * Next occurrence AFTER fromDate (exclusive), using Asia/Kolkata calendar days.
 * Fixes weekly numeric keys ("0"–"6") from the frontend.
 */
export function computeClNextOccurrence(recurrence_type, data = {}, fromDate = null) {
  const from = toYmd(fromDate) || getISTDateString();
  const weekdays = Array.isArray(data.recurrence_weekdays) ? data.recurrence_weekdays : [];
  const monthDates = Array.isArray(data.recurrence_month_dates) ? data.recurrence_month_dates : [];
  const yearDates = Array.isArray(data.recurrence_year_dates) ? data.recurrence_year_dates : [];

  if (recurrence_type === "daily") {
    return addDaysYmd(from, 1);
  }

  if (recurrence_type === "weekly") {
    const days = normalizeWeekdays(weekdays);
    if (!days.length) return addDaysYmd(from, 1);
    const fromDay = weekdayFromYmd(from);
    let diff = days.find((d) => d > fromDay);
    diff = diff !== undefined ? diff - fromDay : days[0] + 7 - fromDay;
    return addDaysYmd(from, diff);
  }

  if (recurrence_type === "monthly") {
    const sorted = monthDates.map(Number).filter((n) => !Number.isNaN(n) && n >= 1 && n <= 31).sort((a, b) => a - b);
    if (!sorted.length) return addDaysYmd(from, 1);
    const { y, m, d } = parseYmdParts(from);
    const nextInMonth = sorted.find((day) => day > d);
    if (nextInMonth) {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return ymdFromUtcParts(y, m, Math.min(nextInMonth, lastDay));
    }
    let ny = y;
    let nm = m + 1;
    if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return ymdFromUtcParts(ny, nm, Math.min(sorted[0], lastDay));
  }

  if (recurrence_type === "yearly") {
    if (!yearDates.length) return addDaysYmd(from, 1);
    const sorted = [...yearDates].map(String).sort();
    const { y, m, d } = parseYmdParts(from);
    const fromMmDd = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const found = sorted.find((mmdd) => mmdd > fromMmDd) ?? sorted[0];
    const [mm, dd] = found.split("-");
    const year = found > fromMmDd ? y : y + 1;
    return `${year}-${mm}-${dd}`;
  }

  return addDaysYmd(from, 1);
}

/** Serialize DATE / Date / ISO → YYYY-MM-DD for API clients. */
export function serializeClDate(val) {
  return toYmd(val) || null;
}
