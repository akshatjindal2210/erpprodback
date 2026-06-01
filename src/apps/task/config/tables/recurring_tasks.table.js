import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskRecurringTasksTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.RECURRING_TASKS} (
      recurring_id           SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      task_type              VARCHAR(20) DEFAULT 'assigned'
        CHECK (task_type IN ('self', 'assigned')),
      created_by             INT NOT NULL,
      assigned_by            INT DEFAULT NULL,
      assigned_to            INT NOT NULL,
      category_id            INT DEFAULT NULL,
      priority               VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
      recurrence_type        VARCHAR(10) NOT NULL
        CHECK (recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      recurrence_weekdays    JSONB NULL,
      recurrence_month_dates JSONB NULL,
      recurrence_year_dates  JSONB NULL,
      next_occurrence        DATE NOT NULL,
      end_date               DATE NULL,
      is_active              BOOLEAN DEFAULT TRUE,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_recurring_next_occurrence ON ${T.RECURRING_TASKS} (next_occurrence)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_recurring_is_active ON ${T.RECURRING_TASKS} (is_active)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_recurring_created_by ON ${T.RECURRING_TASKS} (created_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_recurring_assigned_by ON ${T.RECURRING_TASKS} (assigned_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_recurring_assigned_to ON ${T.RECURRING_TASKS} (assigned_to)`);
}

export async function createTaskRecurringTaskAssignmentsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.RECURRING_TASK_ASSIGNMENTS} (
      assignment_id        SERIAL PRIMARY KEY,
      recurring_id         INT NOT NULL REFERENCES ${T.RECURRING_TASKS}(recurring_id) ON DELETE CASCADE,
      assigned_by          INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      assigned_to          INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      role                 VARCHAR(20) DEFAULT 'sub_user'
        CHECK (role IN ('level_one', 'sub_user', 'self')),
      is_level_one         BOOLEAN DEFAULT FALSE,
      assignment_level     INT NOT NULL DEFAULT 1,
      parent_assignment_id INT DEFAULT NULL REFERENCES ${T.RECURRING_TASK_ASSIGNMENTS}(assignment_id) ON DELETE SET NULL,
      note                 TEXT NULL,
      created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rta_recurring_id ON ${T.RECURRING_TASK_ASSIGNMENTS} (recurring_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rta_assigned_to ON ${T.RECURRING_TASK_ASSIGNMENTS} (assigned_to)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rta_assigned_by ON ${T.RECURRING_TASK_ASSIGNMENTS} (assigned_by)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rta_role ON ${T.RECURRING_TASK_ASSIGNMENTS} (role)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rta_parent ON ${T.RECURRING_TASK_ASSIGNMENTS} (parent_assignment_id)`);
}

export async function createTaskRecurringTaskChatTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.RECURRING_TASK_CHAT} (
      chat_id      SERIAL PRIMARY KEY,
      recurring_id INT NOT NULL REFERENCES ${T.RECURRING_TASKS}(recurring_id) ON DELETE CASCADE,
      user_id      INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      message      TEXT NULL,
      reply_to_id  INT DEFAULT NULL REFERENCES ${T.RECURRING_TASK_CHAT}(chat_id) ON DELETE SET NULL,
      attachments  JSONB DEFAULT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rtc_recurring_id ON ${T.RECURRING_TASK_CHAT} (recurring_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rtc_user_id ON ${T.RECURRING_TASK_CHAT} (user_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rtc_reply_to ON ${T.RECURRING_TASK_CHAT} (reply_to_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_rtc_created_at ON ${T.RECURRING_TASK_CHAT} (created_at)`);
}
