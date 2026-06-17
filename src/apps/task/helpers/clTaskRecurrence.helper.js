import { calculateNextOccurrence } from "../shared/utils/helper.js";

export { calculateNextOccurrence };

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

export function computeClNextOccurrence(recurrence_type, data) {
  return calculateNextOccurrence(recurrence_type, data);
}
