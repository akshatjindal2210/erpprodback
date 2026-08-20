import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreStockAdjustmentTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.STOCK_ADJUSTMENT} (
      adjustment_id       SERIAL PRIMARY KEY,
      entry_type          VARCHAR(16) NOT NULL,
      financial_year      VARCHAR(16),
      it_lot_no           VARCHAR(100),
      mrn_uid             VARCHAR(100),
      mrn_no              INTEGER,
      serial_no           INTEGER,
      mrn_dt              TIMESTAMP,
      bill_no             VARCHAR(100),
      bill_dt             TIMESTAMP,
      item_dcode          INTEGER,
      item_code           VARCHAR(100),
      item_desc           TEXT,
      heat_no             VARCHAR(100),
      acc_code            INTEGER,
      acc_name            TEXT,
      qty                 NUMERIC DEFAULT 0,
      unit                VARCHAR(50) DEFAULT 'KG',
      per_coil_qty        NUMERIC,
      coil_qtys           JSONB,
      coil_count_impact   INTEGER,
      removed_coil_uids   TEXT,
      remarks             TEXT,
      doc_dt              DATE,
      tc_file_path        TEXT,
      tc_file_name        VARCHAR(255),
      rmtc_file_path      TEXT,
      rmtc_file_name      VARCHAR(255),
      approved            BOOLEAN DEFAULT false,
      approved_by         TEXT,
      approved_at         TIMESTAMP,
      is_deleted          BOOLEAN DEFAULT false,
      deleted_by          TEXT,
      deleted_at          TIMESTAMP,
      created_by          TEXT,
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_by          TEXT,
      updated_at          TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_sa_created_at_idx
      ON ${T.STOCK_ADJUSTMENT}(created_at DESC)
      WHERE is_deleted = false;

    CREATE INDEX IF NOT EXISTS rmstore_sa_entry_type_idx
      ON ${T.STOCK_ADJUSTMENT}(entry_type)
      WHERE is_deleted = false;
  `);
}
