import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createUsersTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.USERS} (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(100) NOT NULL,
      username        VARCHAR(100) NOT NULL,
      usercode        INTEGER,
      email           VARCHAR(150),
      phone           VARCHAR(20),
      password        VARCHAR(255) NOT NULL,
      type            VARCHAR(20) CHECK (type IN ('super_admin', 'admin', 'user', 'executive_assistant')) DEFAULT 'user',
      status          VARCHAR(50) CHECK (status IN ('active', 'inactive', 'training')) DEFAULT 'training',
      auth_source     VARCHAR(20) CHECK (auth_source IN ('local', 'erp')) DEFAULT 'local',
      department_id   INTEGER,
      designation_id  INTEGER,
      approved        BOOLEAN DEFAULT false,
      approved_by     INTEGER REFERENCES ${T.USERS}(id),
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES ${T.USERS}(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES ${T.USERS}(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES ${T.USERS}(id),
      updated_at      TIMESTAMP,
      CONSTRAINT users_auth_source_chk CHECK (auth_source IN ('local', 'erp'))
    );
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_active
      ON ${T.USERS} (username)
      WHERE is_deleted = false;
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique_active
      ON ${T.USERS} (phone)
      WHERE is_deleted = false AND phone IS NOT NULL;
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_usercode_unique_active
      ON ${T.USERS} (usercode)
      WHERE is_deleted = false AND usercode IS NOT NULL;
  `);
}
