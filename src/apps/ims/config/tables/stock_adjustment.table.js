import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol, dropColumnIfExists } from "../../../../config/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createStockAdjustmentTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.STOCK_ADJUSTMENT} (
      adjustment_id     SERIAL PRIMARY KEY,
      item_dcode        INTEGER NOT NULL,
      qty               INTEGER,
      unit              VARCHAR(50),
      remarks           TEXT,
      approved          BOOLEAN DEFAULT false,
      approved_by       TEXT,
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        TEXT,
      deleted_at        TIMESTAMP,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMP,
      entry_type        VARCHAR(16),
      packing_number    VARCHAR(128),
      financial_year    VARCHAR(32),
      per_box_qty       INTEGER,
      box_count_impact  INTEGER,
      removed_box_ids   TEXT
    );
  `);

  /** Packing meta frozen in columns (no JSON snapshot). */
  await patchTableSchema(dbQuery, T.STOCK_ADJUSTMENT, {
    columns: [
      patchCol("packing_number", "VARCHAR(128)"),
      patchCol("entry_type", "VARCHAR(16)"),
      patchCol("financial_year", "VARCHAR(32)"),
      patchCol("per_box_qty", "INTEGER"),
      patchCol("box_count_impact", "INTEGER"),
      patchCol("removed_box_ids", "TEXT"),
      patchCol("doc_dt", "DATE"),
      patchCol("job_card_no", "VARCHAR(50)"),
      patchCol("item_code", "VARCHAR(50)"),
      patchCol("item_desc", "TEXT"),
      patchCol("acc_code", "INTEGER"),
      patchCol("acc_name", "VARCHAR(255)"),
      patchCol("category_id", "INTEGER"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_sa_packing_approved ON ${T.STOCK_ADJUSTMENT}(packing_number) WHERE is_deleted = false AND approved = true`,
    ],
  });

  await dropColumnIfExists(dbQuery, T.STOCK_ADJUSTMENT, "category_name");

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.STOCK_ADJUSTMENT);
}
