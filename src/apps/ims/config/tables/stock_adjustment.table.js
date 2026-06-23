import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createStockAdjustmentTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.STOCK_ADJUSTMENT} (
      adjustment_id     SERIAL PRIMARY KEY,
      item_dcode        INTEGER NOT NULL,
      qty               INTEGER,
      unit              VARCHAR(50),
      remarks           TEXT,
      approved          BOOLEAN DEFAULT false,
      approved_by       INTEGER REFERENCES ${C.USERS}(id),
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        INTEGER REFERENCES ${C.USERS}(id),
      deleted_at        TIMESTAMP,
      created_by        INTEGER REFERENCES ${C.USERS}(id),
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        INTEGER REFERENCES ${C.USERS}(id),
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
      patchCol("doc_dt", "DATE"),
      patchCol("job_card_no", "VARCHAR(50)"),
      patchCol("item_code", "VARCHAR(50)"),
      patchCol("item_desc", "TEXT"),
      patchCol("acc_code", "INTEGER"),
      patchCol("acc_name", "VARCHAR(255)"),
    ],
  });

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_sa_packing_approved
      ON ${T.STOCK_ADJUSTMENT}(packing_number)
      WHERE is_deleted = false AND approved = true;
  `);
}
