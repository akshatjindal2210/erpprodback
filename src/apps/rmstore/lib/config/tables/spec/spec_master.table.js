import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { ensureIndexes } from "../../../../../../config/db/ensureDbColumns.js";

export async function createRmStoreSpecMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SPEC_MASTER} (
      spec_item_id      SERIAL PRIMARY KEY,
      item_dcode        INTEGER NOT NULL,
      item_code         VARCHAR(100),
      item_desc         TEXT,
      condition         VARCHAR(255),
      grade             VARCHAR(255),
      size              VARCHAR(255),
      condition_color   VARCHAR(255),
      grade_color       VARCHAR(255),
      type              VARCHAR(100),
      approved          BOOLEAN DEFAULT false,
      approved_by       TEXT,
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        TEXT,
      deleted_at        TIMESTAMP,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMP
    );
  `);

  await ensureIndexes(dbQuery, [
    `CREATE UNIQUE INDEX IF NOT EXISTS rmstore_spec_master_dcode_unique_active
       ON ${T.SPEC_MASTER} (item_dcode)
       WHERE is_deleted = false`,
  ]);
}

export async function createRmStoreSpecDetailTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SPEC_DETAIL} (
      spec_id             SERIAL PRIMARY KEY,
      spec_item_id        INTEGER NOT NULL REFERENCES ${T.SPEC_MASTER}(spec_item_id) ON DELETE CASCADE,
      sno                 INTEGER NOT NULL DEFAULT 1,
      spec_name           VARCHAR(255),
      remarks             TEXT,
      print_val           TEXT,
      inspection_method   TEXT,
      spec_type           VARCHAR(50),
      min_value           NUMERIC DEFAULT 0,
      max_value           NUMERIC DEFAULT 0,
      correct_option      TEXT,
      incorrect_option    TEXT,
      document_required   BOOLEAN DEFAULT false
    );
  `);

  await ensureIndexes(dbQuery, [
    `CREATE UNIQUE INDEX IF NOT EXISTS rmstore_spec_detail_item_sno_unique
       ON ${T.SPEC_DETAIL} (spec_item_id, sno)`,
  ]);
}
