import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createGateEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.GATE_ENTRY} (
      uid            SERIAL PRIMARY KEY,
      bill_no        TEXT,
      bill_dt        TEXT,
      remarks        TEXT,
      transporter_name TEXT,
      vehicle_number TEXT,
      approved       BOOLEAN DEFAULT true,
      approved_by    TEXT,
      approved_at    TIMESTAMP,
      created_by     TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_by     TEXT,
      updated_at     TIMESTAMP,
      is_deleted     BOOLEAN DEFAULT false,
      deleted_by     TEXT,
      deleted_at     TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_entry_bill_active
      ON ${T.GATE_ENTRY} (LOWER(TRIM(bill_no)))
      WHERE is_deleted = false AND NULLIF(TRIM(bill_no), '') IS NOT NULL;
  `);
}
