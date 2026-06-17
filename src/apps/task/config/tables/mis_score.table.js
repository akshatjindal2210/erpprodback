import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskMisScoreLedgerTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MIS_SCORE_LEDGER} (
      ledger_id    SERIAL PRIMARY KEY,
      user_id      INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      score_delta  INT NOT NULL,
      source_type  VARCHAR(30) NOT NULL,
      source_id    INT NOT NULL,
      remark       TEXT,
      ledger_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      created_by   INT REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_mis_ledger_user_date ON ${T.MIS_SCORE_LEDGER} (user_id, ledger_date)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_mis_ledger_source ON ${T.MIS_SCORE_LEDGER} (source_type, source_id)`);
}

export async function createTaskReportReviewsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.REPORT_REVIEWS} (
      review_id           SERIAL PRIMARY KEY,
      cl_instance_id      INT REFERENCES ${T.CL_TASK_INSTANCES}(instance_id) ON DELETE CASCADE,
      task_id             INT REFERENCES ${T.TASKS}(task_id) ON DELETE CASCADE,
      report_date         DATE NOT NULL,
      score               INT,
      management_remark   TEXT,
      is_red_flag         BOOLEAN DEFAULT FALSE,
      reviewed_by         INT REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_report_reviews_instance ON ${T.REPORT_REVIEWS} (cl_instance_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_report_reviews_task ON ${T.REPORT_REVIEWS} (task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_report_reviews_date ON ${T.REPORT_REVIEWS} (report_date)`);
}
