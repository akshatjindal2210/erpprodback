import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";

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
      shortage_no     VARCHAR(64),
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fin_year_id, schno, itemdcode)
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_plan_fin_year ON ${T.SCHEDULE_PLAN} (fin_year_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_schno ON ${T.SCHEDULE_PLAN} (fin_year_id, schno);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_item ON ${T.SCHEDULE_PLAN} (itemdcode);
    CREATE INDEX IF NOT EXISTS idx_schedule_plan_status ON ${T.SCHEDULE_PLAN} (fin_year_id, is_planned);
  `);

  await patchTableSchema(dbQuery, T.SCHEDULE_PLAN, {
    columns: [
      patchCol("shortage_no", "VARCHAR(64)"),
    ],
  });
}
