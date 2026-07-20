import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";

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
      approved_by     TEXT,
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      TEXT,
      deleted_at      TIMESTAMP,
      created_by      TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMP
    );
  `);

  await patchTableSchema(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, {
    columns: [
      patchCol("schno", "VARCHAR(32)"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_fn_item_schno ON ${T.FORWARDING_NOTE_ITEM_WISE}(schno) WHERE schno IS NOT NULL`,
    ],
  });
}
