import dbQuery from "../../shared/db.js";
import { TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskRedTicketsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.RED_TICKETS} (
      ticket_id    SERIAL PRIMARY KEY,
      title        VARCHAR(255) NOT NULL,
      description  TEXT,
      priority     VARCHAR(20) DEFAULT 'medium',
      status       VARCHAR(30) DEFAULT 'open',
      created_by   INTEGER REFERENCES mst_users(id),
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS department_id INT REFERENCES mst_departments(id) ON DELETE SET NULL`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS designation_id INT REFERENCES mst_designations(id) ON DELETE SET NULL`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS person_id INT REFERENCES mst_users(id) ON DELETE SET NULL`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS score_penalty INT NOT NULL DEFAULT 0`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS cl_instance_id INT REFERENCES task_cl_task_instances(instance_id) ON DELETE SET NULL`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS task_id INT REFERENCES task_tasks(task_id) ON DELETE SET NULL`);
  await dbQuery(`ALTER TABLE ${T.RED_TICKETS} ADD COLUMN IF NOT EXISTS ticket_date DATE DEFAULT CURRENT_DATE`);
}
