import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createProcessMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PROCESS_MASTER} (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(200) NOT NULL,
      type          VARCHAR(20) NOT NULL,
      parent_id     INTEGER REFERENCES ${T.PROCESS_MASTER}(id),
      stage         VARCHAR(10) NOT NULL DEFAULT 'MID',
      multi_mc      BOOLEAN NOT NULL DEFAULT false,
      pattern       TEXT,
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

    CREATE INDEX IF NOT EXISTS eng_process_parent_idx
      ON ${T.PROCESS_MASTER} (parent_id) WHERE is_deleted = false;
    CREATE UNIQUE INDEX IF NOT EXISTS eng_process_stage_start_unique_active
      ON ${T.PROCESS_MASTER} (stage) WHERE is_deleted = false AND stage = 'START';
    CREATE UNIQUE INDEX IF NOT EXISTS eng_process_stage_end_unique_active
      ON ${T.PROCESS_MASTER} (stage) WHERE is_deleted = false AND stage = 'END';
  `);
}
