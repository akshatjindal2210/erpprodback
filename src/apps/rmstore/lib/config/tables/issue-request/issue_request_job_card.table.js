import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** One row per job card — FG/RM mapping, qty, and assigned coils (JSONB). */
export async function createRmStoreIssueRequestJobCardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ISSUE_REQUEST_JOB_CARD} (
      id               SERIAL PRIMARY KEY,
      issue_uid        INTEGER NOT NULL REFERENCES ${T.ISSUE_REQUEST}(issue_uid) ON DELETE CASCADE,
      pjobcardno       VARCHAR(100) NOT NULL,
      pldt             TIMESTAMP,
      macname          VARCHAR(100),
      item_dcode       INTEGER,
      item_code        VARCHAR(100),
      item_desc        TEXT,
      rm_item_dcode    INTEGER,
      rm_item_code     VARCHAR(100),
      rm_item_desc     TEXT,
      production_id    INTEGER,
      planqty          NUMERIC DEFAULT 0,
      issue_qty        NUMERIC DEFAULT 0,
      coil_count       INTEGER DEFAULT 0,
      coils            JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_jc_issue_uid_idx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(issue_uid) WHERE is_deleted = false;

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_jc_pjobcardno_idx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(UPPER(TRIM(pjobcardno))) WHERE is_deleted = false;

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_issue_request_jc_issue_pjc_uidx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(issue_uid, UPPER(TRIM(pjobcardno)))
      WHERE is_deleted = false;
  `);
}
