import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol, dropColumnIfExists } from "../../../../../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/**
 * Master has no bill columns — bills live on item-wise only.
 * Summary UI/print rolls up unique item bills as "1, 2, 3".
 */
export async function createForwardingNoteMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.FORWARDING_NOTE_MASTER} (
      fuid                  SERIAL PRIMARY KEY,
      acc_code              INTEGER,
      timestamp             TIMESTAMP DEFAULT NOW(),
      po_number             VARCHAR(50),
      remarks               TEXT,
      transporter_name      VARCHAR(100),
      transporter_id        VARCHAR(100),
      vehicle_number        VARCHAR(50),
      cartage               NUMERIC,
      total_items           INTEGER,
      packing_category_id   INTEGER,
      schno                 VARCHAR(32),
      out_entry_locked      BOOLEAN DEFAULT false,
      out_entry_locked_by   TEXT,
      out_entry_locked_at   TIMESTAMP,
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
  `);

  await patchTableSchema(dbQuery, T.FORWARDING_NOTE_MASTER, {
    columns: [
      patchCol("packing_category_id", "INTEGER"),
      patchCol("schno", "VARCHAR(32)"),
    ],
  });

  // Legacy master bill cols — bills are item-wise only
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_MASTER, "bill_no");
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_MASTER, "bill_updated_by");
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_MASTER, "bill_updated_at");
}
