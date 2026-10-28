import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E } from "../../../../../../config/db/dbTables.js";

/** prod_plan — one row per process/machine line on an authorized job card (synced from prod_jc.process_plan). */
export async function createProdPlanTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PLAN} (
      docno         SERIAL PRIMARY KEY,
      pjobcardno    VARCHAR(30) NOT NULL REFERENCES ${T.JC}(pjobcardno) ON DELETE CASCADE,
      proccode      INTEGER NOT NULL REFERENCES ${E.PROCESS_MASTER}(proccode),
      maccode       INTEGER REFERENCES ${E.MACHINE_MASTER}(maccode),
      stage_no      INTEGER,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      plan_start    DATE,
      plan_end      DATE,
      actual_start  TIMESTAMPTZ,
      actual_end    TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prod_plan_uq
      ON ${T.PLAN} (pjobcardno, proccode, COALESCE(maccode, 0));
    CREATE INDEX IF NOT EXISTS prod_plan_pjc_idx ON ${T.PLAN} (pjobcardno);
  `);
}
