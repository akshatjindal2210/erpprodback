import dbQuery from "../../../../config/db.js";
import { MST_TABLES as T } from "../../../../config/dbTables.js";

export async function createUserPermissionsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.USER_PERMISSIONS} (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES ${T.USERS}(id) ON DELETE CASCADE,
      module_id     INTEGER NOT NULL REFERENCES ${T.MODULES}(id) ON DELETE CASCADE,
      can_view      BOOLEAN DEFAULT false,
      can_view_days INTEGER DEFAULT 0,
      can_add       BOOLEAN DEFAULT false,
      can_edit      BOOLEAN DEFAULT false,
      can_edit_days INTEGER DEFAULT 0,
      can_delete    BOOLEAN DEFAULT false,
      can_authorize BOOLEAN DEFAULT false,
      approved      BOOLEAN DEFAULT false,
      approved_by   INTEGER REFERENCES ${T.USERS}(id),
      approved_at   TIMESTAMP,
      is_deleted    BOOLEAN DEFAULT false,
      deleted_by    INTEGER REFERENCES ${T.USERS}(id),
      deleted_at    TIMESTAMP,
      created_by    INTEGER REFERENCES ${T.USERS}(id),
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_by    INTEGER REFERENCES ${T.USERS}(id),
      updated_at    TIMESTAMP,
      UNIQUE(user_id, module_id)
    );
  `);
}
