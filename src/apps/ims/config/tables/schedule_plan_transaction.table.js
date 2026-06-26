import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createSchedulePlanTransactionTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SCHEDULE_PLAN_TRANSACTION} (
      txn_id          SERIAL PRIMARY KEY,
      fin_year_id     VARCHAR(16) NOT NULL,
      schno           VARCHAR(32) NOT NULL,
      itemdcode       INTEGER NOT NULL,
      plan_id         INTEGER REFERENCES ${T.SCHEDULE_PLAN}(plan_id) ON DELETE SET NULL,
      action_type     VARCHAR(16) NOT NULL,
      from_status     SMALLINT,
      to_status       SMALLINT NOT NULL,
      action_date     DATE,
      action_reason   TEXT,
      remark          TEXT,
      created_by      INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sch_plan_txn_key
      ON ${T.SCHEDULE_PLAN_TRANSACTION} (fin_year_id, schno, itemdcode);
    CREATE INDEX IF NOT EXISTS idx_sch_plan_txn_created
      ON ${T.SCHEDULE_PLAN_TRANSACTION} (fin_year_id, schno, itemdcode, created_at DESC);
  `);
}
