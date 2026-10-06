import dbQuery from "../../../../../../config/db/db.js";
import { HRMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

export async function createLeaveTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.LEAVE} (
      id          SERIAL PRIMARY KEY,
      emp_dcode   INTEGER NOT NULL,
      leave_type  TEXT NOT NULL,
      from_date   DATE NOT NULL,
      to_date     DATE NOT NULL,
      days        NUMERIC(4,1) NOT NULL,
      reason      TEXT NOT NULL,
      sup_by      TEXT,
      sup_at      TIMESTAMPTZ,
      sup_remarks TEXT,
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      approved_remarks TEXT,
      created_by  TEXT,
      updated_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_hrms_leave_emp_dcode ON ${T.LEAVE}(emp_dcode);
  `);

  await applyTablePatches(dbQuery, T.LEAVE, {
    renameColumns: [
      { from: "hr_by", to: "approved_by" },
      { from: "hr_at", to: "approved_at" },
    ],
  });

  await patchTableSchema(dbQuery, T.LEAVE, {
    columns: [
      patchCol("approved_by", "TEXT"),
      patchCol("approved_at", "TIMESTAMPTZ"),
      patchCol("sup_remarks", "TEXT"),
      patchCol("approved_remarks", "TEXT"),
    ],
  });
}
