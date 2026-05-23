import dbQuery from "../db.js";

/** Fresh install only; run ALTER / migrations on existing databases manually */
export async function createUsersTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(100) NOT NULL,
      username      VARCHAR(100) NOT NULL,
      usercode      INTEGER,
      email         VARCHAR(150),
      phone         VARCHAR(20),
      password      VARCHAR(255) NOT NULL,
      type          VARCHAR(20) CHECK (type IN ('super_admin', 'admin', 'user')) DEFAULT 'user',
      status        VARCHAR(50) CHECK (status IN ('active', 'inactive', 'training')) DEFAULT 'training',
      auth_source   VARCHAR(20) CHECK (auth_source IN ('local', 'erp')) DEFAULT 'local',
      approved      BOOLEAN DEFAULT false,
      approved_by   INTEGER REFERENCES users(id),
      approved_at   TIMESTAMP,
      is_deleted    BOOLEAN DEFAULT false,
      deleted_by    INTEGER REFERENCES users(id),
      deleted_at    TIMESTAMP,
      created_by    INTEGER REFERENCES users(id),
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_by    INTEGER REFERENCES users(id),
      updated_at    TIMESTAMP,
      CONSTRAINT users_auth_source_chk CHECK (auth_source IN ('local', 'erp'))
    );
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_active
      ON users (username)
      WHERE is_deleted = false;
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique_active
      ON users (phone)
      WHERE is_deleted = false AND phone IS NOT NULL;
  `);

  // Email is optional and may repeat across users (legacy unique index removed).
  await dbQuery(`DROP INDEX IF EXISTS users_email_unique_active;`);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_usercode_unique_active
      ON users (usercode)
      WHERE is_deleted = false AND usercode IS NOT NULL;
  `);
}
