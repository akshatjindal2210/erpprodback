import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createAuditTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.AUDIT_MASTER} (
      audit_id              SERIAL PRIMARY KEY,
      start_date            DATE,
      end_date              DATE,
      remarks               TEXT,
      status                VARCHAR(20) DEFAULT 'pending',
      approved              BOOLEAN DEFAULT false,
      approved_by           INTEGER REFERENCES ${C.USERS}(id),
      approved_at           TIMESTAMP,
      is_deleted            BOOLEAN DEFAULT false,
      deleted_by            INTEGER REFERENCES ${C.USERS}(id),
      deleted_at            TIMESTAMP,
      created_by            INTEGER REFERENCES ${C.USERS}(id),
      created_at            TIMESTAMP DEFAULT NOW(),
      updated_by            INTEGER REFERENCES ${C.USERS}(id),
      updated_at            TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ${T.AUDIT_LOCATIONS} (
      assignment_id         SERIAL PRIMARY KEY,
      audit_id              INTEGER NOT NULL REFERENCES ${T.AUDIT_MASTER}(audit_id),
      location_id           INTEGER NOT NULL REFERENCES ${T.LOCATION_MASTER}(location_id),
      assigned_user_id      INTEGER REFERENCES ${C.USERS}(id),
      plan_assigned_user_id INTEGER REFERENCES ${C.USERS}(id),
      status                VARCHAR(20) DEFAULT 'pending',
      expected_boxes        JSONB NOT NULL DEFAULT '[]'::jsonb,
      scanned_boxes         JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active             BOOLEAN NOT NULL DEFAULT true,
      reassigned_at         TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_loc_one_active
      ON ${T.AUDIT_LOCATIONS} (audit_id, location_id)
      WHERE is_active = true;
  `);
}
