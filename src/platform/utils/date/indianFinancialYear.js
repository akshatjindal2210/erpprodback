/**
 * Indian financial year (FY): 1 April → 31 March (not calendar Jan–Dec).
 *
 * FY is named by its start year. Example: FY 2026-2027 runs 1 Apr 2026 – 31 Mar 2027.
 *
 * @example Date → FY start year (`getCurrentIndianFinancialYearStartYear`)
 * | Today (calendar)   | FY label      | Start year returned |
 * |--------------------|---------------|---------------------|
 * | 15 May 2026        | 2026-2027     | 2026                |
 * | 31 Mar 2027        | 2026-2027     | 2026                |
 * | 1 Apr 2027         | 2027-2028     | 2027                |
 * | 10 Feb 2026        | 2025-2026     | 2025 (before 1 Apr) |
 *
 * @example Sticker `box_no_uid` prefix (`getBoxNoUidPrefixFromFinancialYear`)
 * Prefix = last 2 digits of FY start year (auto changes on 1 Apr each year).
 * | FY        | Prefix | Full UID example (packing 30637, 50 boxes, #3) |
 * |-----------|--------|--------------------------------------------------|
 * | 2026-2027 | "26"   | 26_30637_50_3                                    |
 * | 2027-2028 | "27"   | 27_30637_50_3                                    |
 *
 * No env/config — always uses real current date (or the `date` argument you pass).
 */

function toDate(value) {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Calendar date → Indian FY start year.
 * Month index 0=Jan … 3=Apr: on/after April use calendar year, before April use year−1.
 *
 * @example new Date(2026, 4, 15)  → 2026   // 15 May 2026, FY 2026-2027
 * @example new Date(2026, 1, 10)  → 2025   // 10 Feb 2026, still FY 2025-2026
 * @example new Date(2027, 3, 1)   → 2027   // 1 Apr 2027, FY 2027-2028 starts
 */
export function getCurrentIndianFinancialYearStartYear(date = new Date()) {
  const d = toDate(date);
  const y = d.getFullYear();
  const m = d.getMonth();
  return m >= 3 ? y : y - 1;
}

/**
 * Human-readable FY label for a date.
 *
 * @example new Date(2026, 4, 15) → "2026-2027"
 * @example new Date(2027, 3, 1)  → "2027-2028"
 */
export function getCurrentIndianFinancialYearLabel(date = new Date()) {
  const y = getCurrentIndianFinancialYearStartYear(date);
  return `${y}-${y + 1}`;
}

/**
 * Sticker `box_no_uid` prefix: last two digits of FY start year.
 *
 * @example new Date(2026, 4, 15) → "26"
 * @example new Date(2027, 3, 1)  → "27"
 */
export function getBoxNoUidPrefixFromFinancialYear(date = new Date()) {
  const y = getCurrentIndianFinancialYearStartYear(date);
  return String(y % 100).padStart(2, "0");
}
