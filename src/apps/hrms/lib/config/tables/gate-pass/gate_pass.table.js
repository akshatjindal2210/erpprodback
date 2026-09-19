import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createGatePassTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.GATE_PASS} (
      id                    SERIAL PRIMARY KEY,
      emp_dcode             INTEGER NOT NULL,
      pass_type             TEXT NOT NULL DEFAULT 'personal',
      pass_date             DATE NOT NULL DEFAULT CURRENT_DATE,
      out_time              TIMESTAMPTZ NOT NULL,
      in_time               TIMESTAMPTZ NOT NULL,
      reason                TEXT NOT NULL,
      sup_by                TEXT,
      sup_at                TIMESTAMPTZ,
      hr_by                 TEXT,
      hr_at                 TIMESTAMPTZ,
      created_by            TEXT,
      updated_by            TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_gate_pass_emp_dcode ON ${T.GATE_PASS}(emp_dcode);
    CREATE INDEX IF NOT EXISTS idx_hrms_gate_pass_date ON ${T.GATE_PASS}(pass_date DESC);
  `);
}
