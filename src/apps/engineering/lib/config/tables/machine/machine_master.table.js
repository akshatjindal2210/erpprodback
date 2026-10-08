import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createMachineMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MACHINE_MASTER} (
      id                 SERIAL PRIMARY KEY,
      name               VARCHAR(200) NOT NULL,
      number             VARCHAR(100) NOT NULL,
      process_id         INTEGER NOT NULL REFERENCES ${T.PROCESS_MASTER}(id),
      speed              VARCHAR(50),
      duration           INTEGER NOT NULL DEFAULT 60,
      make               VARCHAR(200),
      model              VARCHAR(200),
      remark             TEXT,
      attachments        JSONB NOT NULL DEFAULT '[]'::jsonb,
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
}
