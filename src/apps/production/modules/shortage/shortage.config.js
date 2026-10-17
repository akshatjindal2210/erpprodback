/**
 * Shortage constants + month normalizer.
 *
 * CRUD schema (list SQL, filters, sort, etc.) lives in:
 *   - models/shortage.model.js   (DB layer + DEFAULT_FIELDS)
 *   - controllers/shortage.controller.js  (validation + approval workflow)
 *   - core/lib/config/crud/crudModules.js  (shared filter fields)
 */

/** Allowed shortage types — validated on save. Must match frontend shortage.js. */
export const SHORTAGE_TYPES = ["PPC", "WIP", "Deviation", "Additional"];

/** Production shortage list — only these types (no WIP / Deviation). */
export const SHORTAGE_LIST_TYPES = ["PPC", "Additional"];

/**
 * Production Shortage shows only entries created ON / AFTER this date (all tabs + Maintain Job Card).
 * Change the date here to hide older entries. Format YYYY-MM-DD.
 */
export const SHORTAGE_FROM_DATE = "2026-09-01";

/** SQL condition for SHORTAGE_FROM_DATE, e.g. fromDateSql("s") → "s.created_at::date >= '2026-09-01'::date". */
export const fromDateSql = (alias = "s") => `${alias ? `${alias}.` : ""}created_at::date >= '${SHORTAGE_FROM_DATE}'::date`;

/** Bulk spreadsheet import supports PPC and WIP only. */
export const SHORTAGE_BULK_IMPORT_TYPES = ["PPC", "WIP"];

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Store as DATE (calendar day). Accepts YYYY-MM-DD, YYYY-MM, or ISO datetime.
 * YYYY-MM → that month's 1st; missing → today's date.
 */
export function normalizeShortageMonth(value, fallbackDate) {
  const pick = (rawIn) => {
    if (rawIn == null) return null;
    if (rawIn instanceof Date && !Number.isNaN(rawIn.getTime())) {
      const y = rawIn.getUTCFullYear();
      const m = String(rawIn.getUTCMonth() + 1).padStart(2, "0");
      const d = String(rawIn.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const raw = String(rawIn).trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
    return null;
  };

  return pick(value) || pick(fallbackDate) || todayYmd();
}
