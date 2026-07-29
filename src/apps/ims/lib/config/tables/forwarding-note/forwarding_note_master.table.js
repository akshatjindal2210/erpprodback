import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol } from "../../../../../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

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
      packing_category_id   INTEGER,
      bill_updated_by       TEXT,
      bill_updated_at       TIMESTAMP,
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
    columnTypes: [{ name: "bill_no", type: "text" }],
  });
}
