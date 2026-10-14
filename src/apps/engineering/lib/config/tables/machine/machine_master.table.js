import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { ensureColumns, ensureUniqueIndex } from "../../../../../../config/db/ensureDbColumns.js";

export async function createMachineMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MACHINE_MASTER} (
      id                 SERIAL PRIMARY KEY,
      name               VARCHAR(200) NOT NULL,
      number             VARCHAR(100) NOT NULL,
      process_id         INTEGER NOT NULL REFERENCES ${T.PROCESS_MASTER}(id),
      speed              VARCHAR(50),
      duration           INTEGER NOT NULL DEFAULT 60,   -- seconds
      setup_time         INTEGER NOT NULL DEFAULT 0,    -- seconds
      make               VARCHAR(200),
      model              VARCHAR(200),
      remark             TEXT,
      approved           BOOLEAN DEFAULT false,
      approved_by        TEXT,
      approved_at        TIMESTAMP,
      is_deleted         BOOLEAN DEFAULT false,
      deleted_by         TEXT,
      deleted_at         TIMESTAMP,
      created_by         TEXT,
      created_at         TIMESTAMP DEFAULT NOW(),
      updated_by         TEXT,
      updated_at         TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS eng_machine_number_unique_active
      ON ${T.MACHINE_MASTER} (lower(trim(number))) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS eng_machine_process_idx
      ON ${T.MACHINE_MASTER} (process_id) WHERE is_deleted = false;
  `);

  await ensureColumns(dbQuery, T.MACHINE_MASTER, [
    { name: "setup_time", addSql: "setup_time INTEGER NOT NULL DEFAULT 0" },
  ]);
  // Files: `documents` + `doc_files`. Old `attachments` JSON is dropped by the documents backfill (migrations/v5.0.0).

  // Machine name unique among active machines (case / spaces ignored).
  // To remove this rule: replace the line below with  await dropIndexesIfExist(dbQuery, ["eng_machine_name_unique_active"]);
  await ensureUniqueIndex(dbQuery, T.MACHINE_MASTER, "eng_machine_name_unique_active", "lower(trim(name))", "is_deleted = false");
}
