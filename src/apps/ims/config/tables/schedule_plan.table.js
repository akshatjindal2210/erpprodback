import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createSchedulePlanTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SCHEDULE_PLAN} (
      plan_id         SERIAL PRIMARY KEY,
      fin_year_id     VARCHAR(16) NOT NULL,
      schno           VARCHAR(32) NOT NULL,
      itemdcode       INTEGER NOT NULL,
      schmonth        INTEGER,
      schdt           DATE,
      acc_code        INTEGER,
      acc_name        VARCHAR(255),
      item_code       VARCHAR(64),
      itemdesc        TEXT,
      totalqty        NUMERIC(18,3),
      is_planned      SMALLINT NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fin_year_id, schno, itemdcode)
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_plan_fin_year ON ${T.SCHEDULE_PLAN} (fin_year_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_schno ON ${T.SCHEDULE_PLAN} (fin_year_id, schno);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_item ON ${T.SCHEDULE_PLAN} (itemdcode);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_status ON ${T.SCHEDULE_PLAN} (fin_year_id, is_planned);
  `);
}
