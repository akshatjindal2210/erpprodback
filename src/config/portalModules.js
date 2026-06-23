export const APP_GATES = {
  core: "app_core",
  ims: "app_ims",
  task: "app_task",
};

export const APP_META = {
  core: { label: "Admin Console", permissions: true },
  ims: { label: "IMS", permissions: true },
  task: { label: "Task", permissions: true },
};

export const PORTAL_APP_KEYS = ["core", "ims", "task"];

export const SETTINGS_MODULES = ["users", "modules", "training_videos", "departments", "designations"];

export const MODULES = {
  core: [
    { name: "users", label: "User Management" },
    { name: "modules", label: "System Module" },
    { name: "training_videos", label: "Training Videos" },
    { name: "departments", label: "Departments" },
    { name: "designations", label: "Designations" },
  ],
  ims: [
    { name: "product_master", label: "Product Master" },
    { name: "customer_master", label: "Customer Master" },
    { name: "customer_item_code", label: "Customer Item Code" },
    { name: "packing_standard", label: "Packing Standard" },
    { name: "location_master", label: "Store Location Master" },
    { name: "packing_entry", label: "Packing Entry" },
    { name: "boxes", label: "Boxes" },
    { name: "inventory_inwards", label: "Store In" },
    { name: "forwarding_note_master", label: "Forwarding Note" },
    { name: "out_entry", label: "Store Out" },
    { name: "change_override_customer", label: "Change / Override Customer" },
    { name: "stock_adjustment", label: "Stock Adjustment" },
    { name: "inventory_report", label: "Inventory Report" },
    { name: "activity_logs", label: "Activity Logs" },
    { name: "box_transaction_logs", label: "Box Transaction Logs" },
    { name: "sticker_download_logs", label: "Sticker Download Logs" },
    { name: "audit", label: "Inventory Audit" },
    { name: "qc_hold_material", label: "QC Hold Material" },
  ],
  task: [
    // { name: "cl_task", label: "CL Task" },
    // { name: "cl_task_verification", label: "CL Task Verification" },
    // { name: "task_report", label: "CL Task Report" },
    // { name: "red_ticket", label: "Red Ticket" },
  ],
};

export const SEED_MODULES = [
  { name: "users",                        label: "User Management",                 sort_order: 1,        app_type: "core" },
  { name: "modules",                      label: "System Module",                   sort_order: 2,        app_type: "core" },
  { name: "training_videos",              label: "Training Videos",                 sort_order: 3,        app_type: "core" },
  { name: "product_master",               label: "Product Master",                  sort_order: 4,        app_type: "ims" },
  { name: "customer_master",              label: "Customer Master",                 sort_order: 5,        app_type: "ims" },
  { name: "customer_item_code",           label: "Customer Item Code",              sort_order: 6,        app_type: "ims" },
  { name: "packing_standard",             label: "Packing Standard",                sort_order: 7,        app_type: "ims" },
  { name: "location_master",              label: "Store Location Master",           sort_order: 8,        app_type: "ims" },
  { name: "packing_entry",                label: "Packing Entry",                   sort_order: 9,        app_type: "ims" },
  { name: "boxes",                        label: "Boxes",                           sort_order: 10,       app_type: "ims" },
  { name: "inventory_inwards",            label: "Store In",                        sort_order: 11,       app_type: "ims" },
  { name: "forwarding_note_master",       label: "Forwarding Note",                 sort_order: 12,       app_type: "ims" },
  { name: "out_entry",                    label: "Store Out",                       sort_order: 13,       app_type: "ims" },
  { name: "change_override_customer",     label: "Change / Override Customer",      sort_order: 14,       app_type: "ims" },
  { name: "stock_adjustment",             label: "Stock Adjustment",                sort_order: 15,       app_type: "ims" },
  { name: "inventory_report",             label: "Inventory Report",                sort_order: 16,       app_type: "ims" },
  { name: "activity_logs",                label: "Activity Logs",                   sort_order: 17,       app_type: "ims" },
  { name: "box_transaction_logs",         label: "Box Transaction Logs",            sort_order: 18,       app_type: "ims" },
  { name: "sticker_download_logs",        label: "Sticker Download Logs",           sort_order: 19,       app_type: "ims" },
  { name: "departments",                  label: "Departments",                     sort_order: 20,       app_type: "core" },
  { name: "designations",                 label: "Designations",                    sort_order: 21,       app_type: "core" },
  { name: "audit",                        label: "Inventory Audit",                 sort_order: 22,       app_type: "ims" },
  { name: "qc_hold_material",             label: "QC Hold Material",                sort_order: 23,       app_type: "ims" },
  // { name: "cl_task",                      label: "CL Task",                         sort_order: 24,       app_type: "task" },
  // { name: "cl_task_verification",         label: "CL Task Verification",            sort_order: 24,       app_type: "task" },
  // { name: "task_report",                  label: "CL Task Report",                  sort_order: 25,       app_type: "task" },
  // { name: "red_ticket",                   label: "Red Ticket",                      sort_order: 26,       app_type: "task" },
];

