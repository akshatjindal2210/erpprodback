import dbQuery from "../../shared/db.js";
import { MST_TABLES as C, TASK_TABLES as T } from "../../../../config/dbTables.js";

export async function createTaskClTasksMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASKS_MASTER} (
      cl_task_id             SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      sop_description        TEXT,
      task_type              VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (task_type IN ('open', 'frequently')),
      recurrence_type        VARCHAR(10) DEFAULT NULL CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      recurrence_weekdays    JSONB DEFAULT NULL,
      recurrence_month_dates JSONB DEFAULT NULL,
      recurrence_year_dates  JSONB DEFAULT NULL,
      weightage              INT NOT NULL DEFAULT 1 CHECK (weightage >= 1 AND weightage <= 10),
      verification_user_id   INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id          INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id         INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id              INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      due_time               VARCHAR(5) DEFAULT '11:00',
      day_offset             INT NOT NULL DEFAULT 0 CHECK (day_offset >= 0 AND day_offset <= 14),
      next_occurrence        DATE DEFAULT NULL,
      approved               BOOLEAN DEFAULT TRUE,
      approved_by            TEXT,
      approved_at            TIMESTAMP,
      form_schema            JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachment             JSONB DEFAULT NULL,
      verification_required  BOOLEAN NOT NULL DEFAULT TRUE,
      scoring_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      sop_required           BOOLEAN NOT NULL DEFAULT FALSE,
      created_by             INT NOT NULL REFERENCES ${C.USERS}(id) ON DELETE CASCADE,
      created_by_name        VARCHAR(255) DEFAULT NULL,
      updated_by             INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      updated_by_name        VARCHAR(255) DEFAULT NULL,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function createTaskClTasksTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.CL_TASKS} (
      instance_id            SERIAL PRIMARY KEY,
      cl_task_id             INT NOT NULL REFERENCES ${T.CL_TASKS_MASTER}(cl_task_id) ON DELETE CASCADE,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT,
      sop_description        TEXT,
      task_type              VARCHAR(20) NOT NULL CHECK (task_type IN ('open', 'frequently')),
      recurrence_type        VARCHAR(10) DEFAULT NULL CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      recurrence_weekdays    JSONB DEFAULT NULL,
      recurrence_month_dates JSONB DEFAULT NULL,
      recurrence_year_dates  JSONB DEFAULT NULL,
      weightage              INT NOT NULL DEFAULT 1 CHECK (weightage >= 1 AND weightage <= 10),
      verification_user_id   INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      department_id          INT DEFAULT NULL REFERENCES ${C.DEPARTMENTS}(id) ON DELETE SET NULL,
      designation_id         INT DEFAULT NULL REFERENCES ${C.DESIGNATIONS}(id) ON DELETE SET NULL,
      person_id              INT DEFAULT NULL REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      due_time               VARCHAR(5) DEFAULT '11:00',
      day_offset             INT NOT NULL DEFAULT 0,
      scheduled_date         DATE NOT NULL,
      status                 VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_verification', 'completed')),
      reject_count           INT NOT NULL DEFAULT 0,
      score                  INT DEFAULT NULL,
      submitted_at           TIMESTAMP DEFAULT NULL,
      completed_at           TIMESTAMP DEFAULT NULL,
      verifier_remark        TEXT DEFAULT NULL,
      person_remark          TEXT DEFAULT NULL,
      edit_note              TEXT DEFAULT NULL,
      last_edited_by         INT DEFAULT NULL,
      last_edited_by_name    VARCHAR(255) DEFAULT NULL,
      last_edited_at         TIMESTAMP DEFAULT NULL,
      form_schema            JSONB NOT NULL DEFAULT '[]'::jsonb,
      form_responses         JSONB DEFAULT NULL,
      attachment             JSONB DEFAULT NULL,
      verification_required  BOOLEAN NOT NULL DEFAULT TRUE,
      scoring_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      sop_required           BOOLEAN NOT NULL DEFAULT FALSE,
      sop_acknowledged       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
