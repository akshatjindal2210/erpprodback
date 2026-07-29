import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreSpecMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MASTER_SPEC} (
      spec_id             SERIAL PRIMARY KEY,
      item_dcode          INTEGER NOT NULL,
      item_code           VARCHAR(100),
      item_desc           TEXT,
      condition           VARCHAR(255),
      grade               VARCHAR(255),
      size                VARCHAR(255),
      sno                 INTEGER NOT NULL DEFAULT 1,
      type                VARCHAR(100),
      spec_name           VARCHAR(255),
      remarks             TEXT,
      print_val           TEXT,
      spec_type           VARCHAR(50),
      min_value           NUMERIC DEFAULT 0,
      max_value           NUMERIC DEFAULT 0,
      correct_option      TEXT,
      incorrect_option    TEXT,
      document_required   BOOLEAN DEFAULT false,
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

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_master_spec_item_sno_unique_active
      ON ${T.MASTER_SPEC} (item_dcode, sno)
      WHERE is_deleted = false;
  `);
}
