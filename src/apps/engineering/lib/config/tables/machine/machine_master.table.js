import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, dropIndexesIfExist, ensureColumns, ensureUniqueIndex } from "../../../../../../config/db/ensureDbColumns.js";

export async function createMachineMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MACHINE_MASTER} (
      id                 SERIAL PRIMARY KEY,
      macname            VARCHAR(200) NOT NULL,
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

    CREATE INDEX IF NOT EXISTS eng_machine_process_idx
      ON ${T.MACHINE_MASTER} (process_id) WHERE is_deleted = false;
  `);

  // Existing DBs: name → macname (before indexes that use macname)
  await applyTablePatches(dbQuery, T.MACHINE_MASTER, {
    renameColumns: [{ from: "name", to: "macname" }],
  });

  await ensureColumns(dbQuery, T.MACHINE_MASTER, [
    { name: "setup_time", addSql: "setup_time INTEGER NOT NULL DEFAULT 0" },
  ]);

  // Store macname + number as CAPS (simple one-shot normalize)
  await dbQuery(`
    UPDATE ${T.MACHINE_MASTER}
    SET macname = UPPER(TRIM(macname)), number = UPPER(TRIM(number))
    WHERE macname IS DISTINCT FROM UPPER(TRIM(macname)) OR number IS DISTINCT FROM UPPER(TRIM(number))
  `);

  await dropIndexesIfExist(dbQuery, ["eng_machine_name_unique_active", "eng_machine_number_unique_active"]);
  await ensureUniqueIndex(dbQuery, T.MACHINE_MASTER, "eng_machine_macname_unique_active", "macname", "is_deleted = false");
  await ensureUniqueIndex(dbQuery, T.MACHINE_MASTER, "eng_machine_number_unique_active", "number", "is_deleted = false");
}
