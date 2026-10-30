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

/** Bulk spreadsheet import supports PPC and WIP only. */
export const SHORTAGE_BULK_IMPORT_TYPES = ["PPC", "WIP"];

export { normalizeShortageMonth } from "../../../../platform/utils/date/shortageMonth.js";
