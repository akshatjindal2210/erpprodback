/**
 * Module list-page paths for inbox / PWA notification clicks.
 * Keep in sync with frontend/src/platform/utils/core/activityLogDisplay.js (MODULE_ROUTES maps).
 */
import { resolvePushAppBrand } from "../push/pushAppBrand.js";

const IMS = "/ims/dashboard";
const RM = "/rmstore/dashboard";
const TASK = "/task/dashboard";
const HRMS = "/hrms/dashboard";
const PURCHASE = "/purchase/dashboard";
const PRODUCTION = "/production/dashboard";

const IMS_MODULE_ROUTES = {
  product_master: `${IMS}/master/product-master`,
  customer_master: `${IMS}/master/customer-master`,
  customer_item_code: `${IMS}/master/customer-item-code`,
  packing_standard: `${IMS}/packing-standard`,
  packing_entry: `${IMS}/master/packing-entry`,
  location_master: `${IMS}/master/location-master`,
  tray_master: `${IMS}/master/tray-master`,
  manage_tray: `${IMS}/manage-tray`,
  boxes: `${IMS}/box`,
  box: `${IMS}/box`,
  box_table: `${IMS}/box`,
  inventory_inwards: `${IMS}/inventory-inward`,
  inventory_inward: `${IMS}/inventory-inward`,
  forwarding_note_master: `${IMS}/forwarding-note`,
  out_entry: `${IMS}/out-entry`,
  ims_out_entry: `${IMS}/out-entry`,
  gate_entry: `${IMS}/gate-entry`,
  invoice_receiving: `${IMS}/invoice-receiving`,
  stock_adjustment: `${IMS}/stock-adjustment`,
  ims_stock_adjustment: `${IMS}/stock-adjustment`,
  change_override_customer: `${IMS}/stickers/override-customer`,
  ims_box_override_request: `${IMS}/stickers/override-customer`,
  qc_hold_material: `${IMS}/qc-hold-material`,
  schedule_planning: `${IMS}/schedule-planning`,
  shortage: `${IMS}/shortage`,
  inventory_report: `${IMS}/inventory-report`,
  erp_stock_report: `${IMS}/erp-stock-report`,
  audit: `${IMS}/audit`,
  activity_logs: `${IMS}/logs`,
  box_transaction_logs: `${IMS}/logs/box-transactions`,
  sticker_download_logs: `${IMS}/logs/box-transactions`,
};

const RMSTORE_MODULE_ROUTES = {
  rm_production_master: `${RM}/master/production`,
  rm_product_master: `${RM}/master/rm-product`,
  rm_spec_master: `${RM}/master/rm-spec`,
  rm_store_location_master: `${RM}/master/store-location`,
  rm_mrn_portal: `${RM}/master/mrn-entry`,
  mrn_portal: `${RM}/master/mrn-entry`,
  rm_coils: `${RM}/coils`,
  rm_inventory_inwards: `${RM}/inventory-inward`,
  inventory_inward: `${RM}/inventory-inward`,
  inventory_inwards: `${RM}/inventory-inward`,
  rm_qc_check: `${RM}/qc-check`,
  qc_check: `${RM}/qc-check`,
  rm_rejection: `${RM}/rm-rejection`,
  rm_out_entry: `${RM}/out-entry`,
  out_entry: `${RM}/out-entry`,
  rm_issue_request: `${RM}/issue-request`,
  issue_request: `${RM}/issue-request`,
  rm_in_process_request: `${RM}/in-process-request`,
  in_process_request: `${RM}/in-process-request`,
  rm_stock_adjustment: `${RM}/stock-adjustment`,
  stock_adjustment: `${RM}/stock-adjustment`,
  rm_inventory_report: `${RM}/inventory-report`,
  rm_inventory_audit: `${RM}/inventory-audit`,
  rm_activity_logs: `${RM}/logs/activity`,
  rm_coil_transaction_logs: `${RM}/logs/coil-transactions`,
  rm_coil_download_logs: `${RM}/logs/sticker-downloads`,
  rm_sticker_download_logs: `${RM}/logs/sticker-downloads`,
};

const TASK_MODULE_ROUTES = {
  cl_task_master: `${TASK}/cl-task`,
  cl_task: `${TASK}/cl-tasks`,
  cl_tasks: `${TASK}/cl-tasks`,
  cl_task_verification: `${TASK}/cl-task/verification`,
  task_report: `${TASK}/cl-task/report`,
  red_ticket: `${TASK}/red-ticket`,
  category: `${TASK}/category`,
  holiday: `${TASK}/holidays`,
  holidays: `${TASK}/holidays`,
  tasks: `${TASK}/tasks`,
  recurring_task: `${TASK}/recurring-task`,
};

const HRMS_MODULE_ROUTES = {
  hrms_attendance: `${HRMS}/attendance`,
  hrms_attendance_log: `${HRMS}/attendance-log`,
  hrms_employee: `${HRMS}/employees`,
  hrms_gate_pass: `${HRMS}/gate-pass`,
  hrms_activity_logs: `${HRMS}/logs`,
};

const PURCHASE_MODULE_ROUTES = {
  purchase_master: `${PURCHASE}/master`,
  purchase_shortage: `${PURCHASE}/shortage`,
  purchase_activity_logs: `${PURCHASE}/logs`,
};

const PRODUCTION_MODULE_ROUTES = {
  production_master: `${PRODUCTION}/master`,
  production_shortage: `${PRODUCTION}/shortage`,
  production_activity_logs: `${PRODUCTION}/logs`,
};

const ROUTES_BY_APP = {
  ims: IMS_MODULE_ROUTES,
  rmstore: RMSTORE_MODULE_ROUTES,
  task: TASK_MODULE_ROUTES,
  hrms: HRMS_MODULE_ROUTES,
  purchase: PURCHASE_MODULE_ROUTES,
  production: PRODUCTION_MODULE_ROUTES,
};

/** Activity-log entity slugs → canonical module key for route lookup. */
const MODULE_ROUTE_ALIASES = {
  forwarding_note_item_wise: "forwarding_note_master",
  box_table: "boxes",
  ims_box_override_request: "change_override_customer",
  rm_mrn_portal: "rm_mrn_portal",
  mrn_portal: "rm_mrn_portal",
  coils: "rm_coils",
  rm_rejection: "rm_rejection",
  purchase_shortage: "purchase_shortage",
  production_shortage: "production_shortage",
  hrms_employee: "hrms_employee",
  employees: "hrms_employee",
};

/** App home when module slug is unknown (before generic push brand). */
const APP_NOTIFY_HOME = {
  ims: "/ims/dashboard",
  rmstore: "/rmstore/dashboard",
  task: "/task/dashboard/tasks",
  hrms: "/hrms/dashboard",
  purchase: "/purchase/dashboard",
  production: "/production/dashboard",
  core: "/settings",
};

function normalizeModuleKey(module) {
  return String(module || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function lookupModuleHref(appType, moduleName) {
  const rawKey = normalizeModuleKey(moduleName);
  if (!rawKey) return null;
  const key = MODULE_ROUTE_ALIASES[rawKey] || rawKey;

  const app = String(appType || "").trim().toLowerCase();
  const primary = ROUTES_BY_APP[app]?.[key];
  if (primary) return primary;

  if (app === "rmstore" && !key.startsWith("rm_")) {
    const prefixed = ROUTES_BY_APP.rmstore?.[`rm_${key}`];
    if (prefixed) return prefixed;
  }

  for (const map of Object.values(ROUTES_BY_APP)) {
    if (map[key]) return map[key];
  }

  if (key !== rawKey) {
    for (const map of Object.values(ROUTES_BY_APP)) {
      if (map[rawKey]) return map[rawKey];
    }
  }

  return null;
}

/** Relative app path for notification / inbox click (falls back to app dashboard). */
export function resolveModuleNotifyUrl({ appType, moduleName } = {}) {
  const href = lookupModuleHref(appType, moduleName);
  if (href) return href;
  const app = String(appType || "").trim().toLowerCase();
  if (APP_NOTIFY_HOME[app]) return APP_NOTIFY_HOME[app];
  const brand = resolvePushAppBrand(appType);
  return brand.defaultUrl || "/";
}
