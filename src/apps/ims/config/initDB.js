import dbQuery from "../../../config/db.js";
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
import { createTransactionBoxTable } from "./tables/transaction_box.table.js";
import { createCategoryTable } from "./tables/category.table.js";
import { createStickerTypeTable } from "./tables/sticker_type.table.js";
import { createAppConfigTable } from "./tables/app_config.table.js";
// import { createAuditTables } from "./tables/audit.table.js";
import { syncImsSequences } from "./syncSequences.js";

export async function initImsDB() {
  await createCategoryTable();
  await createStickerTypeTable();
  await createAppConfigTable();
  await createLocationMasterTable();
  await createPackingStandardTable();
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
  await createTransactionBoxTable();
  // await createAuditTables();

  await syncImsSequences();

  console.log("✅ IMS tables ready");
}
