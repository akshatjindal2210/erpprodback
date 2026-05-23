import dbQuery from "../db.js";

export async function createForwardingNoteMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS forwarding_note_master (
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
      bill_no               VARCHAR(50),
      bill_updated_by       INTEGER REFERENCES users(id),
      bill_updated_at       TIMESTAMP,
      out_entry_locked      BOOLEAN DEFAULT false,
      out_entry_locked_by   INTEGER REFERENCES users(id),
      out_entry_locked_at   TIMESTAMP,
      approved              BOOLEAN DEFAULT false,
      approved_by           INTEGER REFERENCES users(id),
      approved_at           TIMESTAMP,
      is_deleted            BOOLEAN DEFAULT false,
      deleted_by            INTEGER REFERENCES users(id),
      deleted_at            TIMESTAMP,
      created_by            INTEGER REFERENCES users(id),
      created_at            TIMESTAMP DEFAULT NOW(),
      updated_by            INTEGER REFERENCES users(id),
      updated_at            TIMESTAMP
    );
  `);
}