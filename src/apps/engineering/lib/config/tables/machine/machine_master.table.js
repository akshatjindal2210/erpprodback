import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, dropIndexesIfExist, ensureColumns, ensureUniqueIndex } from "../../../../../../config/db/ensureDbColumns.js";

export async function createMachineMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MACHINE_MASTER} (
      maccode            SERIAL PRIMARY KEY,
      macname            VARCHAR(200) NOT NULL,
      macno              VARCHAR(100) NOT NULL,
      macproccode        INTEGER NOT NULL REFERENCES ${T.PROCESS_MASTER}(proccode),
      cavity             VARCHAR(50),
      maccycletime       INTEGER NOT NULL DEFAULT 60,   -- seconds
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
  `);

  // Existing DBs: rename columns (idempotent) — before any index on macproccode
  await applyTablePatches(dbQuery, T.MACHINE_MASTER, {
    renameColumns: [
      { from: "name", to: "macname" },
      { from: "id", to: "maccode" },
      { from: "number", to: "macno" },
      { from: "speed", to: "cavity" },
      { from: "duration", to: "maccycletime" },
      { from: "process_id", to: "macproccode" },
    ],
  });

  await ensureColumns(dbQuery, T.MACHINE_MASTER, [
    { name: "setup_time", addSql: "setup_time INTEGER NOT NULL DEFAULT 0" },
  ]);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS eng_machine_process_idx
      ON ${T.MACHINE_MASTER} (macproccode) WHERE is_deleted = false;
  `);

  // Store macname + macno as CAPS (simple one-shot normalize)
  await dbQuery(`
    UPDATE ${T.MACHINE_MASTER}
    SET macname = UPPER(TRIM(macname)), macno = UPPER(TRIM(macno))
    WHERE macname IS DISTINCT FROM UPPER(TRIM(macname)) OR macno IS DISTINCT FROM UPPER(TRIM(macno))
  `);

  await dropIndexesIfExist(dbQuery, ["eng_machine_name_unique_active", "eng_machine_number_unique_active", "eng_machine_macno_unique_active"]);
  await ensureUniqueIndex(dbQuery, T.MACHINE_MASTER, "eng_machine_macname_unique_active", "macname", "is_deleted = false");
  await ensureUniqueIndex(dbQuery, T.MACHINE_MASTER, "eng_machine_macno_unique_active", "macno", "is_deleted = false");
}
