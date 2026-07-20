/** ONE-TIME: INT audit user-id cols → TEXT names. Safe no-op when already done. */
import dbQuery from "../config/db.js";
import { migrateTableAuditColumnsToUserNames } from "../config/auditUserNameColumns.js";
import { MST_TABLES as M, IMS_TABLES as I } from "../config/dbTables.js";

const JOBS = [
  [M.USERS],
  [M.MODULES, { columns: ["updated_by"] }],
  [M.USER_PERMISSIONS],
  [M.TRAINING_VIDEOS],
  [M.MODULE_SOPS, { columns: ["created_by", "updated_by", "deleted_by"] }],
  [I.CATEGORY],
  [I.STICKER_TYPE],
  [I.APP_CONFIG, { columns: ["updated_by"] }],
  [I.LOCATION_MASTER],
  [I.PACKING_STANDARD],
  [I.INVENTORY_INWARDS],
  [
    I.FORWARDING_NOTE_MASTER,
    {
      columns: [
        "created_by",
        "updated_by",
        "approved_by",
        "deleted_by",
        "bill_updated_by",
        "out_entry_locked_by",
      ],
    },
  ],
  [I.FORWARDING_NOTE_ITEM_WISE],
  [I.QC_HOLD_MATERIAL],
  [I.OUT_ENTRY],
  [I.BOX_TABLE],
  [I.BOX_DOWNLOAD_LOG, { columns: ["downloaded_by"] }],
  [I.BOX_OVERRIDE_REQUEST, { columns: ["requested_by", "approved_by", "updated_by"] }],
  [I.STOCK_ADJUSTMENT],
  [I.SCHEDULE_PLAN, { columns: ["created_by", "updated_by"] }],
  [I.SCHEDULE_PLAN_TRANSACTION, { columns: ["created_by"] }],
  [I.AUDIT_MASTER],
];

export async function runAuditUserNamesBackfill() {
  for (const [table, opts] of JOBS) {
    if (!table) continue;
    try {
      await migrateTableAuditColumnsToUserNames(dbQuery, table, opts);
    } catch (err) {
      console.warn(`[backfill:audit] ${table}:`, err?.message || err);
    }
  }
}
