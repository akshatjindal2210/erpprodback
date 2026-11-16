import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** prod_bin_manage — start_bin / end_bin = ims_tray_master.id; mode = partial|full (transfer) */
export async function createProdBinManageTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.BIN_MANAGE} (
      id              SERIAL PRIMARY KEY,
      type            TEXT NOT NULL DEFAULT 'assign',
      mode            TEXT,
      start_bin       INTEGER,
      end_bin         INTEGER NOT NULL,
      pjobcardno      VARCHAR(50),
      qty             NUMERIC(14, 3),
      data            JSONB NOT NULL DEFAULT '{}'::jsonb,
      remark          TEXT,
      created_by      TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMP,
      is_deleted      BOOLEAN NOT NULL DEFAULT false,
      deleted_by      TEXT,
      deleted_at      TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS prod_bin_manage_created_at_idx ON ${T.BIN_MANAGE} (created_at DESC);
    CREATE INDEX IF NOT EXISTS prod_bin_manage_end_bin_idx ON ${T.BIN_MANAGE} (end_bin, id DESC) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS prod_bin_manage_jc_idx ON ${T.BIN_MANAGE} (pjobcardno) WHERE is_deleted = false AND pjobcardno IS NOT NULL;
    CREATE INDEX IF NOT EXISTS prod_bin_manage_type_idx ON ${T.BIN_MANAGE} (type) WHERE is_deleted = false;
  `);
}
