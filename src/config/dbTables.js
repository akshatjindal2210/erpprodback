/**
 * Central registry for PostgreSQL table names.
 *
 * Naming:
 *   mst_*  — master / shared tables (core, settings, admin, global inbox); used by every app for FK refs
 *   ims_*  — IMS app tables only
 *   task_* — Task app tables only
 *
 * Imports:
 *   Core / settings  → MST_TABLES
 *   IMS              → MST_TABLES + IMS_TABLES
 *   Task             → MST_TABLES + TASK_TABLES
 */

/** Prefix per layer (add new apps here, e.g. hr: "hr_"). */
export const TABLE_PREFIX = {
  master: "mst_",
  ims: "ims_",
  task: "task_",
};

export const DB_TABLES = {
  /** Shared master tables — users, modules, permissions, org structure. */
  master: [
    "mst_users",
    "mst_modules",
    "mst_user_permissions",
    "mst_user_app_access",
    "mst_training_videos",
    "mst_module_sops",
    "mst_departments",
    "mst_designations",
    "mst_activity_logs",
    "mst_inbox",
    // "mst_user_app_preferences",
  ],

  /** IMS application tables. */
  ims: [
    "ims_category",
    "ims_sticker_type",
    "ims_app_config",
    "ims_location_master",
    "ims_packing_standard",
    "ims_inventory_inwards",
    "ims_forwarding_note_master",
    "ims_forwarding_note_item_wise",
    "ims_out_entry",
    "ims_out_entry_scanned_box",
    "ims_stock_adjustment",
    "ims_box_table",
    "ims_box_download_log",
    "ims_box_override_request",
    "ims_dailyprod",
    "ims_transaction_box",
    "ims_audit_master",
    "ims_audit_locations",
    "ims_audit_scans",
    "ims_qc_hold_material",
  ],

  /** Task application tables. */
  task: [
    "task_categories",
    "task_holiday",
    "task_tasks",
    "task_recurring_tasks",
    "task_recurring_task_assignments",
    "task_recurring_task_chat",
    "task_assignments",
    "task_chat",
    "task_self_notes",
    "task_app_config",
    "task_cl_tasks",
    "task_cl_task_instances",
    "task_red_tickets",
    "task_mis_score_ledger",
    "task_report_reviews",
  ],
};

/** Map table stem to full name, e.g. USERS → "mst_users". */
function toKeyMap(names, stripPrefix = "") {
  const out = {};
  for (const full of names) {
    let stem = full;
    if (stripPrefix && stem.startsWith(stripPrefix)) stem = stem.slice(stripPrefix.length);
    out[stem.toUpperCase()] = full;
  }
  return out;
}

export const MST_TABLES = toKeyMap(DB_TABLES.master, TABLE_PREFIX.master);
export const IMS_TABLES = toKeyMap(DB_TABLES.ims, TABLE_PREFIX.ims);
export const TASK_TABLES = toKeyMap(DB_TABLES.task, TABLE_PREFIX.task);

export default DB_TABLES;
