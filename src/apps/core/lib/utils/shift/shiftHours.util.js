/**
 * Shift net hours + active_days helpers — Settings API + Production calendar.
 * Keep LUNCH_MIN in sync with frontend shiftTimeFormat.js (LUNCH_MIN).
 * active_days: Mon=1 … Sun=7.
 */

export const SHIFT_LUNCH_MINUTES = 30;
export const ALL_ACTIVE_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** YYYY-MM-DD → 1–7 (Mon–Sun). Local noon avoids TZ edge. */
export function ymdToActiveDay(ymd) {
  const d = new Date(`${String(ymd || "").slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

/** Empty / missing → all days. */
export function normalizeActiveDays(days) {
  if (!Array.isArray(days) || !days.length) return [...ALL_ACTIVE_DAYS];
  const out = [];
  for (const x of days) {
    const n = Number(x);
    if (Number.isFinite(n) && n >= 1 && n <= 7 && !out.includes(n)) out.push(n);
  }
  return out.length ? out.sort((a, b) => a - b) : [...ALL_ACTIVE_DAYS];
}

export function isShiftActiveOnDate(shift, ymd) {
  const day = ymdToActiveDay(ymd);
  if (day == null) return true;
  return normalizeActiveDays(shift?.active_days).includes(day);
}

export function isShiftLunch(v) {
  return v === true || v === 1 || v === "1" || v === "t";
}

function toMinutes(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getHours() * 60 + value.getMinutes();
  }
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/);
  const m = iso || s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** End − start (+ overnight); −30m if lunch. */
export function netShiftHours(start_time, end_time, lunchRaw = false) {
  const lunch = isShiftLunch(lunchRaw);
  const a = toMinutes(start_time);
  const b = toMinutes(end_time);
  if (a == null || b == null) {
    return { hours: 8, overnight: false, lunch };
  }
  let mins = b - a;
  const overnight = mins <= 0;
  if (overnight) mins += 24 * 60;
  if (lunch) mins = Math.max(0, mins - SHIFT_LUNCH_MINUTES);
  return {
    lunch,
    overnight,
    hours: Math.max(0.5, Math.round((mins / 60) * 10) / 10),
  };
}
