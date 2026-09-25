import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** Gate Entry + Invoice Receiving columns (local — no ERP invreceiving). */
export async function createGateEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.GATE_ENTRY} (
      uid            SERIAL PRIMARY KEY,
      bill_no        TEXT,
      bill_dt        TEXT,
      remarks        TEXT,
      transporter_name TEXT,
      vehicle_number TEXT,
      type           VARCHAR(16) NOT NULL DEFAULT 'out',
      approved       BOOLEAN DEFAULT true,
      approved_by    TEXT,
      approved_at    TIMESTAMP,
      created_by     TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_by     TEXT,
      updated_at     TIMESTAMP,
      is_deleted     BOOLEAN DEFAULT false,
      deleted_by     TEXT,
      deleted_at     TIMESTAMP,
      invoice_matched BOOLEAN NOT NULL DEFAULT false,
      receiving_file  TEXT,
      receiving_meta  TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_entry_bill_active
      ON ${T.GATE_ENTRY} (LOWER(TRIM(bill_no)))
      WHERE is_deleted = false AND NULLIF(TRIM(bill_no), '') IS NOT NULL;
  `);

  await patchTableSchema(dbQuery, T.GATE_ENTRY, {
    columns: [
      patchCol("type", "VARCHAR(16) NOT NULL DEFAULT 'out'"),
      patchCol("invoice_matched", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("receiving_file", "TEXT"),
      patchCol("receiving_meta", "TEXT"),
    ],
  });
}
