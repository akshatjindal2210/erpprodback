import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskClTasksTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASKS} (
      cl_task_id             SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      sop_description        TEXT,
      task_type              VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (task_type IN ('open', 'frequently')),
      recurrence_type        VARCHAR(10) DEFAULT NULL CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      recurrence_weekdays    JSONB DEFAULT NULL,
      recurrence_month_dates JSONB DEFAULT NULL,
      recurrence_year_dates  JSONB DEFAULT NULL,
      wastage                INT NOT NULL DEFAULT 1 CHECK (wastage >= 1 AND wastage <= 10),
      verification_user_id   INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id          INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id         INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id              INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      end_date_time          TIMESTAMP NOT NULL,
      next_occurrence        DATE DEFAULT NULL,
      is_active              BOOLEAN DEFAULT TRUE,
      form_schema            JSONB NOT NULL DEFAULT '[]'::jsonb,
      verification_required  BOOLEAN NOT NULL DEFAULT TRUE,
      scoring_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      created_by             INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function createTaskClTaskInstancesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASK_INSTANCES} (
      instance_id            SERIAL PRIMARY KEY,
      cl_task_id             INT NOT NULL REFERENCES ${T.CL_TASKS}(cl_task_id) ON DELETE CASCADE,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      sop_description        TEXT,
      task_type              VARCHAR(20) NOT NULL CHECK (task_type IN ('open', 'frequently')),
      recurrence_type        VARCHAR(10) DEFAULT NULL,
      recurrence_weekdays    JSONB DEFAULT NULL,
      recurrence_month_dates JSONB DEFAULT NULL,
      recurrence_year_dates  JSONB DEFAULT NULL,
      wastage                INT NOT NULL DEFAULT 1 CHECK (wastage >= 1 AND wastage <= 10),
      verification_user_id   INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id          INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id         INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id              INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      end_date_time          TIMESTAMP NOT NULL,
      scheduled_date         DATE NOT NULL,
      status                 VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_verification', 'completed')),
      reject_count           INT NOT NULL DEFAULT 0,
      score                  INT DEFAULT NULL,
      submitted_at           TIMESTAMP DEFAULT NULL,
      completed_at           TIMESTAMP DEFAULT NULL,
      verifier_remark        TEXT DEFAULT NULL,
      person_remark          TEXT DEFAULT NULL,
      form_schema            JSONB NOT NULL DEFAULT '[]'::jsonb,
      form_responses         JSONB DEFAULT NULL,
      verification_required  BOOLEAN NOT NULL DEFAULT TRUE,
      scoring_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
