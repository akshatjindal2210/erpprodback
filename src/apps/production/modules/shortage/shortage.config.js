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

export { normalizeShortageMonth } from "../../../../platform/utils/date/shortageMonth.js";
