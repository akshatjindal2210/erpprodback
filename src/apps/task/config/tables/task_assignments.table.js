import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskAssignmentsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ASSIGNMENTS} (
      assignment_id           SERIAL PRIMARY KEY,
      task_id                 INT NOT NULL REFERENCES ${T.TASKS}(task_id) ON DELETE CASCADE,
      assigned_by             INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      assigned_to             INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      role                    VARCHAR(20) DEFAULT 'sub_user'
        CHECK (role IN ('level_one', 'sub_user', 'self')),
      is_level_one            BOOLEAN DEFAULT FALSE,
      assignment_level        INT NOT NULL DEFAULT 1,
      parent_assignment_id    INT DEFAULT NULL REFERENCES ${T.ASSIGNMENTS}(assignment_id) ON DELETE SET NULL,
      is_active               BOOLEAN DEFAULT TRUE,
      note                    TEXT NULL,
      completion_requested_at TIMESTAMP NULL,
      completion_approved_at  TIMESTAMP NULL,
      approved_by             INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      assigned_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_task_id ON ${T.ASSIGNMENTS} (task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_assigned_to ON ${T.ASSIGNMENTS} (assigned_to)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_assigned_by ON ${T.ASSIGNMENTS} (assigned_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_role ON ${T.ASSIGNMENTS} (role)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_is_level_one ON ${T.ASSIGNMENTS} (is_level_one)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_is_active ON ${T.ASSIGNMENTS} (is_active)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ta_parent ON ${T.ASSIGNMENTS} (parent_assignment_id)`);
}
