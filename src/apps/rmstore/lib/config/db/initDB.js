import { createRmStoreLocationMasterTable } from "../tables/store-location/store_location_master.table.js";
import { createRmStoreProductionMasterTable } from "../tables/production/production_master.table.js";
import { createRmStoreSpecMasterTable } from "../tables/spec/spec_master.table.js";
import { createRmStoreMrnTable } from "../tables/mrn/mrn.table.js";
import { createRmStoreCoilTable } from "../tables/coil/coil_table.table.js";
import { createRmStoreInventoryInwardsTable } from "../tables/inventory-inward/inventory_inwards.table.js";
import { createRmStoreQcCheckTable } from "../tables/qc-check/qc_check.table.js";
import { createRmStoreRejectionTable } from "../tables/rm-rejection/rejection.table.js";
import { createRmStoreIssueRequestTable } from "../tables/issue-request/issue_request.table.js";
import { createRmStoreInProcessRequestTable } from "../tables/in-process-request/in_process_request.table.js";
import { createRmStoreOutEntryTable } from "../tables/out-entry/out_entry.table.js";
import { createRmStoreOutEntryScannedCoilTable } from "../tables/out-entry/out_entry_scanned_coil.table.js";
import { createRmStoreCoilTransactionTable } from "../tables/transaction-log/coil_transaction.table.js";
import { createRmStoreStockAdjustmentTable } from "../tables/stock-adjustment/stock_adjustment.table.js";

export async function initRmStoreDB() {
  await createRmStoreLocationMasterTable();
  await createRmStoreProductionMasterTable();
  await createRmStoreSpecMasterTable();
  await createRmStoreMrnTable();
  await createRmStoreCoilTable();
  await createRmStoreInventoryInwardsTable();
  await createRmStoreQcCheckTable();
  await createRmStoreRejectionTable();
  await createRmStoreIssueRequestTable();
  await createRmStoreInProcessRequestTable();
  await createRmStoreOutEntryTable();
  await createRmStoreOutEntryScannedCoilTable();
  await createRmStoreStockAdjustmentTable();
  await createRmStoreCoilTransactionTable();
}
