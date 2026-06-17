import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskClTasksTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASKS} (
      cl_task_id           SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      sop_description        TEXT,
      task_type              VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (task_type IN ('open', 'frequently')),
      recurrence_type        VARCHAR(10) DEFAULT NULL CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      wastage                INT NOT NULL DEFAULT 1 CHECK (wastage >= 1 AND wastage <= 10),
      verification_user_id   INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id          INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id         INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id              INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      end_date_time          TIMESTAMP NOT NULL,
      next_occurrence        DATE DEFAULT NULL,
      is_active              BOOLEAN DEFAULT TRUE,
      created_by             INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_task_type ON ${T.CL_TASKS} (task_type)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_next_occurrence ON ${T.CL_TASKS} (next_occurrence)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_is_active ON ${T.CL_TASKS} (is_active)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_department ON ${T.CL_TASKS} (department_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_designation ON ${T.CL_TASKS} (designation_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_tasks_person ON ${T.CL_TASKS} (person_id)`);

  await migrateClTaskMasterColumns();
}

export async function createTaskClTaskInstancesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASK_INSTANCES} (
      instance_id            SERIAL PRIMARY KEY,
      cl_task_id               INT NOT NULL REFERENCES ${T.CL_TASKS}(cl_task_id) ON DELETE CASCADE,
      title                    VARCHAR(255) NOT NULL,
      description              TEXT,
      sop_description          TEXT,
      task_type                VARCHAR(20) NOT NULL CHECK (task_type IN ('open', 'frequently')),
      recurrence_type          VARCHAR(10) DEFAULT NULL,
      wastage                  INT NOT NULL DEFAULT 1 CHECK (wastage >= 1 AND wastage <= 10),
      verification_user_id     INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id            INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id           INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id                INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      end_date_time            TIMESTAMP NOT NULL,
      scheduled_date           DATE NOT NULL,
      status                   VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_cl_task ON ${T.CL_TASK_INSTANCES} (cl_task_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_department ON ${T.CL_TASK_INSTANCES} (department_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_designation ON ${T.CL_TASK_INSTANCES} (designation_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_person ON ${T.CL_TASK_INSTANCES} (person_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_scheduled ON ${T.CL_TASK_INSTANCES} (scheduled_date)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_status ON ${T.CL_TASK_INSTANCES} (status)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cl_instances_verification ON ${T.CL_TASK_INSTANCES} (verification_user_id)`);

  await migrateClTaskInstanceColumns();
}

async function migrateClTaskInstanceColumns() {
  const table = T.CL_TASK_INSTANCES;

  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS reject_count INT NOT NULL DEFAULT 0`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS score INT DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS verifier_remark TEXT DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS person_remark TEXT DEFAULT NULL`);

  await dbQuery(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS task_cl_task_instances_status_check`);
  await dbQuery(`
    ALTER TABLE ${table} ADD CONSTRAINT task_cl_task_instances_status_check
    CHECK (status IN ('pending', 'awaiting_verification', 'completed'))
  `);

  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS form_schema JSONB DEFAULT '[]'::jsonb`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS form_responses JSONB DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS verification_required BOOLEAN DEFAULT TRUE`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS scoring_enabled BOOLEAN DEFAULT TRUE`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_weekdays JSONB DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_month_dates JSONB DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_year_dates JSONB DEFAULT NULL`);
}

async function migrateClTaskMasterColumns() {
  const table = T.CL_TASKS;
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS form_schema JSONB DEFAULT '[]'::jsonb`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS verification_required BOOLEAN DEFAULT TRUE`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS scoring_enabled BOOLEAN DEFAULT TRUE`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_weekdays JSONB DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_month_dates JSONB DEFAULT NULL`);
  await dbQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recurrence_year_dates JSONB DEFAULT NULL`);
}
