import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createAuditTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.AUDIT_MASTER} (
      audit_id              SERIAL PRIMARY KEY,
      start_date            DATE,
      end_date              DATE,
      remarks               TEXT,
      status                VARCHAR(20) DEFAULT 'pending',
      approved              BOOLEAN DEFAULT false,
      approved_by           TEXT,
      approved_at           TIMESTAMP,
      is_deleted            BOOLEAN DEFAULT false,
      deleted_by            TEXT,
      deleted_at            TIMESTAMP,
      created_by            TEXT,
      created_at            TIMESTAMP DEFAULT NOW(),
      updated_by            TEXT,
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
      reassigned_at         TIMESTAMP,
      score_pct             NUMERIC(6, 2),
      score_at              TIMESTAMP,
      result_rejected       BOOLEAN NOT NULL DEFAULT false
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_loc_one_active
      ON ${T.AUDIT_LOCATIONS} (audit_id, location_id)
      WHERE is_active = true;
  `);

  await patchTableSchema(dbQuery, T.AUDIT_LOCATIONS, {
    columns: [
      patchCol("score_pct", "NUMERIC(6, 2)"),
      patchCol("score_at", "TIMESTAMP"),
      patchCol("result_rejected", "BOOLEAN NOT NULL DEFAULT false"),
    ],
  });

  // ONE-TIME: INT id → user name on audit master only.
  // assigned_user_id / plan_assigned_user_id stay INTEGER (live assignment FKs).
  await migrateTableAuditColumnsToUserNames(dbQuery, T.AUDIT_MASTER);
}
