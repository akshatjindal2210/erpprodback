/** Returns current hour (0–23) in Asia/Kolkata. */
export function getISTHour() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

/** Returns current HH:MM in Asia/Kolkata. */
export function getISTTimeHM() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

export function getISTDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Normalize "11:00", "11:00:00", Date → "HH:MM". Default 11:00. */
export function normalizeDueTime(raw, fallback = "11:00") {
  if (raw == null || raw === "") return fallback;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Fill-before clock used for Due / missed checks.
 * 00:00 (12:00 AM) = end of day — otherwise the window is empty all day after midnight.
 */
export function effectiveFillDeadlineHm(dueTime) {
  const due = normalizeDueTime(dueTime);
  return due === "00:00" ? "23:59" : due;
}

/** True if current IST time is strictly before the effective fill-before time. */
export function isBeforeDueTime(dueTime) {
  return getISTTimeHM() < effectiveFillDeadlineHm(dueTime);
}

/** @deprecated Use isBeforeDueTime(task.due_time). Kept for callers expecting 11:00 AM cutoff. */
export function canSubmitPreviousTask(dueTime = "11:00") {
  return isBeforeDueTime(dueTime);
}

/**
 * Normalize DB DATE / ISO / Date → YYYY-MM-DD.
 * IMPORTANT: pg DATE often arrives as a JS Date at local-midnight. Using toISOString()
 * would shift the calendar day west of IST (classic −1 day bug). Always prefer
 * Asia/Kolkata calendar components for Date objects.
 */
export function toYmd(val) {
  if (val == null || val === "") return "";
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  const s = String(val).trim();
  // Prefer leading YYYY-MM-DD (covers "2026-07-15" and "2026-07-15T00:00:00.000Z")
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) {
    // If time component is midnight UTC, ISO prefix IS the calendar day.
    // If time is 18:30Z (IST local-midnight), prefix is wrong — recover via IST.
    if (/T18:30:00/.test(s) || /T18:30:00\.000Z$/i.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      }
    }
    return m[1];
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  return "";
}

export function getTaskDateCategory(scheduledDate) {
  const today = getISTDateString();
  const scheduled = toYmd(scheduledDate);
  if (!scheduled) return "today";
  if (scheduled === today) return "today";
  if (scheduled < today) return "previous";
  return "future";
}

/** Add N calendar days to YYYY-MM-DD (IST-safe via date parts). */
export function addDaysYmd(ymd, days) {
  const base = toYmd(ymd);
  if (!base) return "";
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function clampDayOffsetValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(14, Math.floor(n)));
}

/**
 * Fill deadline calendar day = scheduled_date + day_offset.
 * Deadline clock = due_time on that day (IST).
 */
export function getClTaskFillDeadlineYmd(task) {
  const scheduled = toYmd(task?.scheduled_date);
  if (!scheduled) return "";
  return addDaysYmd(scheduled, clampDayOffsetValue(task?.day_offset));
}

/**
 * Fill window rules:
 * - open: always allowed (multiple fills / day; no due_time / future gate)
 * - frequently: once per cycle (status gate elsewhere); must submit by
 *   scheduled_date + day_offset before due_time IST; future occurrences blocked
 */
export function getClTaskFillBlockedReason(task) {
  if (!task) return "Task not found";

  if (task.status && task.status !== "pending") {
    return task.status === "awaiting_verification"
      ? "Already submitted — awaiting verification (use History to correct)"
      : "This cycle is already completed";
  }

  // Open checklist tasks: fill anytime, as many times as needed
  if (task.task_type === "open") return null;

  if (task.task_type !== "frequently") return null;

  const scheduled = toYmd(task.scheduled_date);
  const today = getISTDateString();
  if (scheduled && scheduled > today) {
    return "Future tasks cannot be submitted yet";
  }

  const deadline = getClTaskFillDeadlineYmd(task) || scheduled;
  const due = effectiveFillDeadlineHm(task.due_time);

  if (deadline && today > deadline) {
    return `Fill window closed on ${deadline} before ${due} IST`;
  }
  if (deadline && today === deadline && !isBeforeDueTime(task.due_time)) {
    return `This task must be filled before ${due} IST (deadline ${deadline})`;
  }
  return null;
}

/** Frequently + pending + fill window closed → missed. */
export function isClTaskMissed(task) {
  if (!task || task.status !== "pending" || task.task_type !== "frequently") return false;
  const scheduled = toYmd(task.scheduled_date);
  const today = getISTDateString();
  if (scheduled && scheduled > today) return false;
  const deadline = getClTaskFillDeadlineYmd(task) || scheduled;
  if (deadline && today > deadline) return true;
  if (deadline && today === deadline && !isBeforeDueTime(task.due_time)) return true;
  return false;
}
