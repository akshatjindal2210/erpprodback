import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createAuditTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.AUDIT_MASTER} (
      audit_id             SERIAL PRIMARY KEY,
      assigned_user_id     INTEGER REFERENCES ${C.USERS}(id),
      start_date           DATE,
      end_date             DATE,
      remarks              TEXT,
      status               VARCHAR(20) DEFAULT 'pending', -- pending (not started), in_progress, submitted, verified, cancelled
      approved             BOOLEAN DEFAULT false,
      approved_by          INTEGER REFERENCES ${C.USERS}(id),
      approved_at          TIMESTAMP,
      is_deleted           BOOLEAN DEFAULT false,
      deleted_by           INTEGER REFERENCES ${C.USERS}(id),
      deleted_at           TIMESTAMP,
      created_by           INTEGER REFERENCES ${C.USERS}(id),
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_by           INTEGER REFERENCES ${C.USERS}(id),
      updated_at           TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ${T.AUDIT_LOCATIONS} (
      audit_id             INTEGER REFERENCES ${T.AUDIT_MASTER}(audit_id),
      location_id          INTEGER REFERENCES ${T.LOCATION_MASTER}(location_id),
      status               VARCHAR(20) DEFAULT 'pending', -- pending, completed
      PRIMARY KEY (audit_id, location_id)
    );

    CREATE TABLE IF NOT EXISTS ${T.AUDIT_SCANS} (
      scan_id              SERIAL PRIMARY KEY,
      audit_id             INTEGER REFERENCES ${T.AUDIT_MASTER}(audit_id),
      location_id          INTEGER REFERENCES ${T.LOCATION_MASTER}(location_id),
      box_no_uid           VARCHAR(100),
      scanned_at           TIMESTAMP DEFAULT NOW(),
      scanned_by           INTEGER REFERENCES ${C.USERS}(id)
    );
  `);
}
