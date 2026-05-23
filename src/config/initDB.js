import dbQuery from "./db.js";
import { createUsersTable } from "./tables/user.table.js";
import { createModulesTable } from "./tables/module.table.js";
import { createUserPermissionsTable } from "./tables/user_permissions.table.js";
import { createTrainingVideosTable } from "./tables/training_videos.table.js";
import { createModuleSopsTable } from "./tables/module_sops.table.js";
import { createLocationMasterTable } from "./tables/location_master.table.js";
import { createPackingStandardTable } from "./tables/packing_standard.table.js";
import { createBoxDownloadLogTable, createBoxOverrideRequestTable, createBoxTable } from "./tables/box_table.table.js";
import { createDailyProdTable } from "./tables/dailyprod.table.js";
import { createInventoryInwardsTable } from "./tables/inventory_inwards.table.js";
import { createForwardingNoteMasterTable } from "./tables/forwarding_note_master.table.js";
import { createForwardingNoteItemWiseTable } from "./tables/forwarding_note_item_wise.table.js";
import { createOutEntryTable } from "./tables/out_entry.table.js";
import { createOutEntryScannedBoxTable } from "./tables/out_entry_scanned_box.table.js";
import { createStockAdjustmentTable } from "./tables/stock_adjustment.table.js";
import { createActivityLogsTable } from "./tables/activity_logs.table.js";
import { createTransactionBoxTable } from "./tables/transaction_box.table.js";
import { createCategoryTable } from "./tables/category.table.js";
import { createStickerTypeTable } from "./tables/sticker_type.table.js";
import { createAppConfigTable } from "./tables/app_config.table.js";

export const initDB = async () => {
  try {
    await dbQuery("SELECT 1");
    console.log("✅ PostgreSQL Connected");

    // Master & Basic Data
    await createUsersTable();
    await createModulesTable();
    await createCategoryTable();
    await createStickerTypeTable();
    await createUserPermissionsTable();
    await createAppConfigTable();
    await createTrainingVideosTable();
    await createModuleSopsTable();
    await createLocationMasterTable();
    await createPackingStandardTable();

    // Operations
    await createInventoryInwardsTable();
    await createForwardingNoteMasterTable();
    await createForwardingNoteItemWiseTable();
    await createOutEntryTable();
    await createStockAdjustmentTable();
    await createBoxTable();
    await createDailyProdTable();
    await createBoxDownloadLogTable();
    await createBoxOverrideRequestTable();
    await createOutEntryScannedBoxTable();

    // Logs
    await createActivityLogsTable();
    await createTransactionBoxTable();

    console.log("✅ All Tables Ready");
  } catch (err) {
    console.error("❌ initDB Failed:", err.message);
    throw err;
  }
};
