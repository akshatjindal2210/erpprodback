import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createDeductionTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.DEDUCTION} (
      id                SERIAL PRIMARY KEY,
      emp_dcode         INTEGER NOT NULL,
      type              TEXT NOT NULL,
      month             DATE NOT NULL,
      amount            NUMERIC(12,2) NOT NULL,
      remarks           TEXT,
      loan_id           INTEGER REFERENCES ${T.LOAN}(id) ON DELETE CASCADE,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_by        TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMPTZ,
      approved_by       TEXT,
      approved_at       TIMESTAMPTZ,
      approved_remarks  TEXT,
      deducted_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_deduction_emp ON ${T.DEDUCTION}(emp_dcode);
    CREATE INDEX IF NOT EXISTS idx_hrms_deduction_status ON ${T.DEDUCTION}(status);
  `);
}
