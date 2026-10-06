import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

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
      sup_remarks           TEXT,
      approved_by           TEXT,
      approved_at           TIMESTAMPTZ,
      approved_remarks      TEXT,
      out_at                TIMESTAMPTZ,
      out_by                TEXT,
      in_at                 TIMESTAMPTZ,
      in_by                 TEXT,
      created_by            TEXT,
      updated_by            TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_gate_pass_emp_dcode ON ${T.GATE_PASS}(emp_dcode);
    CREATE INDEX IF NOT EXISTS idx_hrms_gate_pass_date ON ${T.GATE_PASS}(pass_date DESC);
  `);

  await applyTablePatches(dbQuery, T.GATE_PASS, {
    renameColumns: [
      { from: "hr_by", to: "approved_by" },
      { from: "hr_at", to: "approved_at" },
    ],
  });

  await patchTableSchema(dbQuery, T.GATE_PASS, {
    columns: [
      patchCol("approved_by", "TEXT"),
      patchCol("approved_at", "TIMESTAMPTZ"),
      patchCol("sup_remarks", "TEXT"),
      patchCol("approved_remarks", "TEXT"),
      patchCol("out_at", "TIMESTAMPTZ"),
      patchCol("out_by", "TEXT"),
      patchCol("in_at", "TIMESTAMPTZ"),
      patchCol("in_by", "TEXT"),
    ],
  });
}
