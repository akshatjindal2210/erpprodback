import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createUserAppPreferencesTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.USER_APP_PREFERENCES} (
      user_id      INTEGER NOT NULL REFERENCES ${T.USERS}(id) ON DELETE CASCADE,
      app_type     VARCHAR(20) NOT NULL,
      pref_key     VARCHAR(120) NOT NULL,
      pref_value   JSONB NOT NULL DEFAULT '{}',
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, app_type, pref_key)
    );
  `);
}
