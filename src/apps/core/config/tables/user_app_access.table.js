import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createUserAppAccessTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.USER_APP_ACCESS} (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES ${T.USERS}(id) ON DELETE CASCADE,
      app_key       VARCHAR(50) NOT NULL,
      can_access    BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP,
      UNIQUE(user_id, app_key)
    );
  `);
}
