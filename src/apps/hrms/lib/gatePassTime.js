import { addDaysYmd, istNowDate, timeKey, toIstTimestamp, ymd } from "./attendanceCommon.js";

/** Calendar: today .. today + N (0 = today only, 1 = today + tomorrow). */
export const PASS_DATE_MAX_FUTURE_DAYS = 1;

export function maxPassDateYmdIst() {
  return addDaysYmd(istNowDate(), PASS_DATE_MAX_FUTURE_DAYS);
}

export function validatePassDateYmd(passDate) {
  const d = ymd(passDate);
  if (!d) return { ok: false, message: "Pass date is required." };
  const today = istNowDate();
  if (d < today) return { ok: false, message: "Pass date cannot be before today." };
  const max = maxPassDateYmdIst();
  if (d > max) {
    return {
      ok: false,
      message: PASS_DATE_MAX_FUTURE_DAYS ? `Pass date cannot be after ${max}.` : "Only today is allowed.",
    };
  }
  return { ok: true, passDate: d };
}

function isFullTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(String(value ?? "").trim());
}

function ymdFromTimestamp(ts) {
  const s = String(ts ?? "").trim();
  if (!s) return "";
  return ymd(s) || ymd(new Date(Date.parse(s)).toISOString());
}

/** Same-day out/in, or overnight → in on pass date + 1 day only. */
export function resolveGatePassOutIn(passDate, outRaw, inRaw) {
  const dateCheck = validatePassDateYmd(passDate);
  if (!dateCheck.ok) return dateCheck;
  const date = dateCheck.passDate;

  const outFull = isFullTimestamp(outRaw);
  const inFull = isFullTimestamp(inRaw);

  let outTs = outFull ? String(outRaw).trim() : toIstTimestamp(date, outRaw);
  let inTs = inFull ? String(inRaw).trim() : toIstTimestamp(date, inRaw);

  if (!outTs) return { ok: false, message: "Out time is required." };
  if (!inTs) return { ok: false, message: "In time is required." };

  if (!outFull && !inFull && timeKey(inTs) <= timeKey(outTs)) {
    inTs = toIstTimestamp(addDaysYmd(date, 1), inRaw);
  }

  const outMs = Date.parse(outTs);
  const inMs = Date.parse(inTs);
  if (!Number.isFinite(outMs) || !Number.isFinite(inMs) || inMs <= outMs) {
    return { ok: false, message: "In time must be after out time." };
  }

  const inDay = ymdFromTimestamp(inTs);
  if (inDay > addDaysYmd(date, 1)) {
    return { ok: false, message: "In time must be same day or next day only." };
  }

  return {
    ok: true,
    passDate: date,
    outTime: new Date(outMs).toISOString(),
    inTime: new Date(inMs).toISOString(),
  };
}
