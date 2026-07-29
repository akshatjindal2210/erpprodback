/**
 * CL Task Report date-range safety limits.
 * Change REPORT_DATE_RANGE_MAX_YEARS only — days and messages derive from it.
 */
export const REPORT_DATE_YEAR_MIN = 1990;
export const REPORT_DATE_YEAR_MAX = 2100;
/** Raise/lower allowed From–To span here (e.g. 20, 30, 40). */
export const REPORT_DATE_RANGE_MAX_YEARS = 30;
export const REPORT_DATE_RANGE_MAX_DAYS = 366 * REPORT_DATE_RANGE_MAX_YEARS;
