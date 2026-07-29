import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreIssueRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ISSUE_REQUEST} (
      issue_uid        SERIAL PRIMARY KEY,
      production_id    INTEGER,
      item_dcode       INTEGER,
      item_code        VARCHAR(100),
      item_desc        TEXT,
      rm_item_dcode    INTEGER,
      rm_item_code     VARCHAR(100),
      rm_item_desc     TEXT,
      requested_qty    NUMERIC DEFAULT 0,
      total_qty        NUMERIC DEFAULT 0,
      coil_count       INTEGER DEFAULT 0,
      coils            JSONB NOT NULL DEFAULT '[]'::jsonb,
      job_cards        JSONB NOT NULL DEFAULT '[]'::jsonb,
      shift            VARCHAR(1) NOT NULL DEFAULT 'A',
      remarks          TEXT,
      approved         BOOLEAN DEFAULT false,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_approved_idx
      ON ${T.ISSUE_REQUEST}(approved) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_issue_request_created_at_idx
      ON ${T.ISSUE_REQUEST}(created_at);
  `);
}
