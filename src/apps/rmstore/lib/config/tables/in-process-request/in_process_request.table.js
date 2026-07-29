import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

/**
 * In-process Request — one table for every request type:
 *   request_type = 'rejection' → approved rows queue for Store Out
 *   request_type = 'store_in'  → approved rows queue for Store In
 *   request_type = 'consume'   → approval marks the coils consumed (no queue)
 */
export async function createRmStoreInProcessRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.IN_PROCESS_REQUEST} (
      ipr_uid           SERIAL PRIMARY KEY,
      request_type      VARCHAR(20) NOT NULL DEFAULT 'rejection',
      rejection_type    VARCHAR(10),
      reason            TEXT,
      remarks           TEXT,
      lot_no            VARCHAR(120),
      mrn_uid           VARCHAR(100),
      mrn_no            INTEGER,
      heat_no           VARCHAR(100),
      item_code         VARCHAR(100),
      item_desc         TEXT,
      seed_coil_uid     VARCHAR(120),
      coils             JSONB NOT NULL DEFAULT '[]'::jsonb,
      previous_coils    JSONB NOT NULL DEFAULT '[]'::jsonb,
      proposed_coils    JSONB NOT NULL DEFAULT '[]'::jsonb,
      scanned_coil_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      downstream        VARCHAR(30),
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

    CREATE INDEX IF NOT EXISTS rmstore_in_process_request_created_at_idx
      ON ${T.IN_PROCESS_REQUEST}(created_at DESC);
    CREATE INDEX IF NOT EXISTS rmstore_in_process_request_type_idx
      ON ${T.IN_PROCESS_REQUEST}(request_type) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS rmstore_in_process_request_queue_idx
      ON ${T.IN_PROCESS_REQUEST}(downstream) WHERE is_deleted = false AND approved = true;
  `);
}
