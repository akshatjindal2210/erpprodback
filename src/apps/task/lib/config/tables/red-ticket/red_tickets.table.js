import dbQuery from "../../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createTaskRedTicketsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.RED_TICKETS} (
      ticket_id       SERIAL PRIMARY KEY,
      title           VARCHAR(255) NOT NULL,
      description     TEXT,
      priority        VARCHAR(20) DEFAULT 'medium',
      status          VARCHAR(30) DEFAULT 'open',
      department_id   INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id  INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id       INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      score_penalty   INT NOT NULL DEFAULT 0,
      cl_instance_id  INT DEFAULT NULL REFERENCES ${T.CL_TASKS}(instance_id) ON DELETE SET NULL,
      task_id         INT DEFAULT NULL REFERENCES ${T.TASKS}(task_id) ON DELETE SET NULL,
      ticket_date     DATE DEFAULT CURRENT_DATE,
      created_by      INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
