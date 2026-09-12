/**
 * Paste into backend/src/apps/core/lib/config/crud/crudModules.js when going live.
 * Rename template_record after find-replace.
 */
export const TEMPLATE_CRUD_MODULE = {
  template_record: {
    idField: "record_id",
    listFields: [],
    filterFields: ["record_id", "name", "approved", "from_date", "to_date"],
    searchFields: ["name", "notes"],
  },
};
