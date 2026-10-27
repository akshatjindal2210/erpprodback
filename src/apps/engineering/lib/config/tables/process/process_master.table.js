import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, columnExists, ensureUniqueIndex, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";
import { syncProcessDepth } from "../../../../modules/process-master/models/processMaster.model.js";

/** Process tree: parent_id (null = master) + depth (0 master, 1 sub, 2 sub-sub …). */
export async function createProcessMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PROCESS_MASTER} (
      proccode      SERIAL PRIMARY KEY,
      procname      VARCHAR(200) NOT NULL,
      parent_id     INTEGER REFERENCES ${T.PROCESS_MASTER}(proccode),
      depth         INTEGER NOT NULL DEFAULT 0,
      stage         VARCHAR(10) NOT NULL DEFAULT 'MID',
      pattern       TEXT,
      multi_jc      BOOLEAN NOT NULL DEFAULT false,
      rm_wire       BOOLEAN NOT NULL DEFAULT false,
      tooling       BOOLEAN NOT NULL DEFAULT false,
      fg            BOOLEAN NOT NULL DEFAULT false,
      prime         BOOLEAN NOT NULL DEFAULT false,
      rework        BOOLEAN NOT NULL DEFAULT false,
      approved      BOOLEAN DEFAULT false,
      approved_by   TEXT,
      approved_at   TIMESTAMP,
      is_deleted    BOOLEAN DEFAULT false,
      deleted_by    TEXT,
      deleted_at    TIMESTAMP,
      created_by    TEXT,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_by    TEXT,
      updated_at    TIMESTAMP
    );
  `);

  // Existing DBs — rename to current names (idempotent)
  await applyTablePatches(dbQuery, T.PROCESS_MASTER, {
    renameColumns: [
      { from: "id", to: "proccode" },
      { from: "name", to: "procname" },
      { from: "ProcCode", to: "proccode" },
      { from: "ProcName", to: "procname" },
      { from: "multi_mc", to: "multi_jc" },
    ],
    dropColumns: ["type"],
    indexes: [
      `DROP INDEX IF EXISTS eng_process_stage_start_unique_active`,
      `DROP INDEX IF EXISTS eng_process_stage_end_unique_active`,
    ],
  });

  const hadDepth = await columnExists(dbQuery, T.PROCESS_MASTER, "depth");
  await patchTableSchema(dbQuery, T.PROCESS_MASTER, {
    columns: [
      patchCol("depth", "INTEGER NOT NULL DEFAULT 0"),
      patchCol("multi_jc", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("rm_wire", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("tooling", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("fg", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("prime", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("rework", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("inhouse", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("jobwork", "BOOLEAN NOT NULL DEFAULT false"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS eng_process_parent_idx ON ${T.PROCESS_MASTER} (parent_id) WHERE is_deleted = false`,
    ],
  });
  if (!hadDepth) await syncProcessDepth();

  await ensureUniqueIndex(dbQuery, T.PROCESS_MASTER, "eng_process_name_unique_active", `COALESCE(parent_id, 0), lower(trim(procname))`, "is_deleted = false");
}
