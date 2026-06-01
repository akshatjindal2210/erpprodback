import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskTasksTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TASKS} (
      task_id               SERIAL PRIMARY KEY,
      title                 VARCHAR(255) NOT NULL,
      description           TEXT,
      task_type             VARCHAR(20) DEFAULT 'assigned'
        CHECK (task_type IN ('self', 'assigned')),
      created_by            INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      creator_type          VARCHAR(20) DEFAULT 'user'
        CHECK (creator_type IN ('admin', 'super_admin', 'user')),
      assigned_by           INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      first_assigned_to     INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      current_holder_id     INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      current_assignment_id INT DEFAULT NULL,
      category_id           INT REFERENCES ${T.CATEGORIES}(id) ON DELETE SET NULL,
      priority              VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
      status                VARCHAR(30) DEFAULT 'pending'
        CHECK (status IN ('pending','in_progress','on_hold','forwarded','pending_approval','creator_pending','completed','overdue')),
      due_date              TIMESTAMP,
      reminder_date         TIMESTAMP,
      self_reminder_date    TIMESTAMP DEFAULT NULL,
      completed_at          TIMESTAMP NULL,
      is_recurring          BOOLEAN DEFAULT FALSE,
      recurrence_type       VARCHAR(10) DEFAULT NULL
        CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON ${T.TASKS} (created_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON ${T.TASKS} (assigned_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_first_assigned_to ON ${T.TASKS} (first_assigned_to)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_current_holder ON ${T.TASKS} (current_holder_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON ${T.TASKS} (status)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON ${T.TASKS} (task_type)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_category_id ON ${T.TASKS} (category_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON ${T.TASKS} (due_date)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON ${T.TASKS} (reminder_date)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_tasks_self_reminder ON ${T.TASKS} (self_reminder_date)`);
}
