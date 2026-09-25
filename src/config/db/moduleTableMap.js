import { DB_TABLES, TABLE_PREFIX } from "./dbTables.js";

/**
 * Maps each IMS table to its permission module name (`mst_modules.name`).
 * Child and log tables use the same module as their parent screen.
 */
export const IMS_TABLE_TO_MODULE = {
  ims_category: "category",
  ims_sticker_type: "sticker_type",
  ims_app_config: "ims_app_config",
  ims_location_master: "location_master",
  ims_tray_batch: "tray_batch",
  ims_tray_master: "tray_master",
  ims_tray_manage: "manage_tray",
  ims_packing_standard: "packing_standard",
  ims_inventory_inwards: "inventory_inwards",
  ims_forwarding_note_master: "forwarding_note_master",
  ims_forwarding_note_item_wise: "forwarding_note_master",
  ims_out_entry: "out_entry",
  ims_out_entry_scanned_box: "out_entry",
  ims_gate_entry: "gate_entry",
  ims_stock_adjustment: "stock_adjustment",
  ims_box_table: "boxes",
  ims_box_download_log: "sticker_download_logs",
  ims_box_override_request: "change_override_customer",
  ims_dailyprod: "packing_entry",
  ims_schedule_plan: "schedule_planning",
  ims_schedule_plan_transaction: "schedule_planning",
  ims_transaction_box: "box_transaction_logs",
  ims_audit_master: "audit",
  ims_audit_locations: "audit",
  ims_audit_scans: "audit",
  ims_qc_hold_material: "qc_hold_material",
  ims_shortage: "shortage",
};

/** Maps each RM Store table to its permission module name. */
export const RMSTORE_TABLE_TO_MODULE = {
  rmstore_master_production: "rm_production_master",
  rmstore_spec_master: "rm_spec_master",
  rmstore_spec_detail: "rm_spec_master",
  rmstore_mrn: "rm_mrn_portal",
  rmstore_coil_table: "rm_coils",
  rmstore_inventory_inwards: "rm_inventory_inwards",
  rmstore_qc_check: "rm_qc_check",
  rmstore_rejection: "rm_rejection",
  rmstore_issue_request: "rm_issue_request",
  rmstore_issue_request_job_card: "rm_issue_request",
  rmstore_in_process_request: "rm_in_process_request",
  rmstore_out_entry: "rm_out_entry",
  rmstore_out_entry_scanned_coil: "rm_out_entry",
  rmstore_stock_adjustment: "rm_stock_adjustment",
  rmstore_coil_transaction: "rm_coil_transaction_logs",
  rmstore_audit_master: "rm_inventory_audit",
  rmstore_audit_locations: "rm_inventory_audit",
};

/** Shared master and HRMS tables (non-IMS, non-RM Store). */
export const OTHER_TABLE_TO_MODULE = {
  mst_users: "users",
  mst_training_videos: "training_videos",
  mst_modules: "modules",
  mst_departments: "departments",
  mst_designations: "designations",
  mst_attributes: "attributes",
  hrms_attendance: "hrms_attendance",
  hrms_attendance_log: "hrms_attendance_log",
  hrms_gate_pass: "hrms_gate_pass",
};

/** Used by dashboard SQL helpers and notifications: physical table to module name. */
export const TABLE_MODULE_OVERRIDES = {
  ...IMS_TABLE_TO_MODULE,
  ...RMSTORE_TABLE_TO_MODULE,
  ...OTHER_TABLE_TO_MODULE,
};

/**
 * Primary table per module for notification template column hints.
 * Prefer master row tables over child, scan, or log tables.
 */
export const MODULE_PRIMARY_TABLE = {
  category: "ims_category",
  sticker_type: "ims_sticker_type",
  location_master: "ims_location_master",
  tray_batch: "ims_tray_batch",
  tray_master: "ims_tray_master",
  manage_tray: "ims_tray_manage",
  packing_standard: "ims_packing_standard",
  inventory_inwards: "ims_inventory_inwards",
  forwarding_note_master: "ims_forwarding_note_master",
  out_entry: "ims_out_entry",
  gate_entry: "ims_gate_entry",
  stock_adjustment: "ims_stock_adjustment",
  boxes: "ims_box_table",
  sticker_download_logs: "ims_box_download_log",
  change_override_customer: "ims_box_override_request",
  packing_entry: "ims_dailyprod",
  schedule_planning: "ims_schedule_plan",
  box_transaction_logs: "ims_transaction_box",
  audit: "ims_audit_master",
  qc_hold_material: "ims_qc_hold_material",
  shortage: "ims_shortage",
  rm_production_master: "rmstore_master_production",
  rm_spec_master: "rmstore_spec_master",
  rm_mrn_portal: "rmstore_mrn",
  rm_coils: "rmstore_coil_table",
  rm_inventory_inwards: "rmstore_inventory_inwards",
  rm_qc_check: "rmstore_qc_check",
  rm_rejection: "rmstore_rejection",
  rm_issue_request: "rmstore_issue_request",
  rm_in_process_request: "rmstore_in_process_request",
  rm_out_entry: "rmstore_out_entry",
  rm_stock_adjustment: "rmstore_stock_adjustment",
  rm_coil_transaction_logs: "rmstore_coil_transaction",
  rm_inventory_audit: "rmstore_audit_master",
  users: "mst_users",
  training_videos: "mst_training_videos",
  modules: "mst_modules",
  departments: "mst_departments",
  designations: "mst_designations",
  attributes: "mst_attributes",
  hrms_attendance: "hrms_attendance",
  hrms_attendance_log: "hrms_attendance_log",
  hrms_gate_pass: "hrms_gate_pass",
};

const ALL_TABLES = new Set([
  ...DB_TABLES.master,
  ...DB_TABLES.ims,
  ...DB_TABLES.task,
  ...DB_TABLES.rmstore,
  ...DB_TABLES.hrms,
  ...DB_TABLES.purchase,
  ...DB_TABLES.production,
]);

/** Resolve the primary PostgreSQL table for a permission module (notification column hints). */
export function resolvePrimaryTableForModule(moduleName, appType = "core") {
  const mod = String(moduleName || "").trim();
  if (!mod) return null;

  const primary = MODULE_PRIMARY_TABLE[mod];
  if (primary && ALL_TABLES.has(primary)) return primary;

  for (const [table, mapped] of Object.entries(TABLE_MODULE_OVERRIDES)) {
    if (mapped === mod && ALL_TABLES.has(table)) return table;
  }

  const at = String(appType || "core").toLowerCase();
  const prefixes = [];
  if (TABLE_PREFIX[at]) prefixes.push(TABLE_PREFIX[at]);
  prefixes.push(TABLE_PREFIX.master, TABLE_PREFIX.ims, TABLE_PREFIX.rmstore, TABLE_PREFIX.task, TABLE_PREFIX.hrms);
  const uniquePrefixes = [...new Set(prefixes)];

  const stems = [mod];
  if (mod.startsWith("rm_")) stems.push(mod.slice(3));
  if (mod.endsWith("s")) stems.push(mod.slice(0, -1));
  else stems.push(`${mod}s`);

  for (const prefix of uniquePrefixes) {
    for (const stem of stems) {
      if (!stem) continue;
      const candidate = `${prefix}${stem}`;
      if (ALL_TABLES.has(candidate)) return candidate;
    }
  }

  return null;
}

/** Returns IMS and RM Store tables missing from the module map (for dev checks). */
export function assertImsRmstoreTableCoverage() {
  const missingIms = DB_TABLES.ims.filter((t) => !IMS_TABLE_TO_MODULE[t]);
  const missingRm = DB_TABLES.rmstore.filter((t) => !RMSTORE_TABLE_TO_MODULE[t]);
  return { missingIms, missingRm };
}
