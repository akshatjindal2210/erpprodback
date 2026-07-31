import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreMrnTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MRN} (
      uid                      VARCHAR(100) PRIMARY KEY,
      mrn_no                   INTEGER,
      serial_no                INTEGER,
      mrn_dt                   TIMESTAMP,
      bill_no                  VARCHAR(100),
      bill_dt                  TIMESTAMP,
      acc_code                 INTEGER,
      acc_name                 TEXT,
      item_dcode               INTEGER,
      item_code                VARCHAR(100),
      item_desc                TEXT,
      it_recp_qty              NUMERIC,
      it_lot_no                VARCHAR(100),
      it_unit                  VARCHAR(50),
      fyid                     INTEGER,
      sticker_mode             VARCHAR(24),
      sticker_generated        BOOLEAN DEFAULT false,
      internal_create_user     VARCHAR(255),
      internal_create_date     TIMESTAMP WITH TIME ZONE,
      system_generate_user     VARCHAR(255),
      system_generate_date     TIMESTAMP WITH TIME ZONE,
      tc_file_path             TEXT,
      tc_file_name             VARCHAR(255),
      rmtc_file_path           TEXT,
      rmtc_file_name           VARCHAR(255),
      sticker_draft            JSONB,
      sticker_draft_at         TIMESTAMP WITH TIME ZONE,
      sticker_draft_by         VARCHAR(255)
    );

    CREATE INDEX IF NOT EXISTS rmstore_mrn_sticker_generated_idx
      ON ${T.MRN}(sticker_generated);
    CREATE INDEX IF NOT EXISTS rmstore_mrn_mrn_no_idx ON ${T.MRN}(mrn_no);
  `);
}
