import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createForwardingNoteItemWiseTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.FORWARDING_NOTE_ITEM_WISE} (
      id              SERIAL PRIMARY KEY,
      fuid            INTEGER NOT NULL REFERENCES ${T.FORWARDING_NOTE_MASTER}(fuid) ON DELETE CASCADE,
      item_dcode      INTEGER NOT NULL,
      packing_number  VARCHAR(50),
      box             INTEGER DEFAULT 0,
      box_qty         INTEGER DEFAULT 0,
      loose_box       INTEGER DEFAULT 0,
      loose_box_qty   INTEGER DEFAULT 0,
      total_qty       INTEGER DEFAULT 0,
      approved        BOOLEAN DEFAULT false,
      approved_by     INTEGER REFERENCES ${C.USERS}(id),
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES ${C.USERS}(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES ${C.USERS}(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES ${C.USERS}(id),
      updated_at      TIMESTAMP
    );
  `);
}
