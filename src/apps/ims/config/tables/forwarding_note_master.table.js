import dbQuery from "../../../../config/db.js";
import { patchTableSchema } from "../../../../config/ensureDbColumns.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

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
      bill_no               TEXT,
      bill_updated_by       INTEGER REFERENCES ${C.USERS}(id),
      bill_updated_at       TIMESTAMP,
      out_entry_locked      BOOLEAN DEFAULT false,
      out_entry_locked_by   INTEGER REFERENCES ${C.USERS}(id),
      out_entry_locked_at   TIMESTAMP,
      approved              BOOLEAN DEFAULT false,
      approved_by           INTEGER REFERENCES ${C.USERS}(id),
      approved_at           TIMESTAMP,
      is_deleted            BOOLEAN DEFAULT false,
      deleted_by            INTEGER REFERENCES ${C.USERS}(id),
      deleted_at            TIMESTAMP,
      created_by            INTEGER REFERENCES ${C.USERS}(id),
      created_at            TIMESTAMP DEFAULT NOW(),
      updated_by            INTEGER REFERENCES ${C.USERS}(id),
      updated_at            TIMESTAMP
    );
  `);

  await patchTableSchema(dbQuery, T.FORWARDING_NOTE_MASTER, {
    columnTypes: [{ name: "bill_no", type: "text" }],
  });
}
