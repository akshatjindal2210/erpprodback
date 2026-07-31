import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** Master header only — job cards + coils live in rmstore_issue_request_job_card (IMS FN style). */
export async function createRmStoreIssueRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ISSUE_REQUEST} (
      issue_uid             SERIAL PRIMARY KEY,
      shift                 VARCHAR(1) NOT NULL DEFAULT 'A',
      remarks               TEXT,
      requested_qty         NUMERIC DEFAULT 0,
      coil_count            INTEGER DEFAULT 0,
      out_entry_locked      BOOLEAN DEFAULT false,
      out_entry_locked_by   TEXT,
      out_entry_locked_at   TIMESTAMP,
      approved              BOOLEAN DEFAULT false,
      approved_by           TEXT,
      approved_at           TIMESTAMP,
      is_deleted            BOOLEAN DEFAULT false,
      deleted_by            TEXT,
      deleted_at            TIMESTAMP,
      created_by            TEXT,
      created_at            TIMESTAMP DEFAULT NOW(),
      updated_by            TEXT,
      updated_at            TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_approved_idx
      ON ${T.ISSUE_REQUEST}(approved) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_issue_request_created_at_idx
      ON ${T.ISSUE_REQUEST}(created_at);
  `);

  await patchTableSchema(dbQuery, T.ISSUE_REQUEST, {
    columns: [
      patchCol("out_entry_locked", "BOOLEAN DEFAULT false"),
      patchCol("out_entry_locked_by", "TEXT"),
      patchCol("out_entry_locked_at", "TIMESTAMP"),
    ],
  });
}
