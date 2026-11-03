import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E } from "../../../../../../config/db/dbTables.js";

/** prod_plan — drop & recreate manually if needed. Hard delete. */
export async function createProdPlanTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.PLAN} (
      docno       SERIAL PRIMARY KEY,
      pjobcardno  VARCHAR(30) NOT NULL REFERENCES ${T.JC}(pjobcardno) ON DELETE CASCADE,
      proccode    INTEGER NOT NULL REFERENCES ${E.PROCESS_MASTER}(proccode),
      maccode     INTEGER REFERENCES ${E.MACHINE_MASTER}(maccode),
      stage_no    INTEGER,
      status      VARCHAR(20) NOT NULL DEFAULT 'pending',
      rm_items    JSONB NOT NULL DEFAULT '[]'::jsonb,
      sys_start   DATE,
      sys_end     DATE,
      act_start   TIMESTAMPTZ,
      act_end     TIMESTAMPTZ,
      mp_start    DATE,
      mp_end      DATE,
      created_by  TEXT,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_by  TEXT,
      updated_at  TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prod_plan_uq
      ON ${T.PLAN} (pjobcardno, proccode, COALESCE(maccode, 0));
    CREATE INDEX IF NOT EXISTS prod_plan_pjc_idx ON ${T.PLAN} (pjobcardno);
  `);
  // Cleanup if a prior build added queue_no (order is mp_start / sys_start only).
  await dbQuery(`ALTER TABLE ${T.PLAN} DROP COLUMN IF EXISTS queue_no`);
}
