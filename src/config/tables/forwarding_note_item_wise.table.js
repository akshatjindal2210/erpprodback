import dbQuery from "../db.js";

export async function createForwardingNoteItemWiseTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS forwarding_note_item_wise (
      id         SERIAL PRIMARY KEY,
      fuid       INTEGER NOT NULL REFERENCES forwarding_note_master(fuid) ON DELETE CASCADE,
      item_dcode INTEGER NOT NULL,
      
      packing_number  VARCHAR(50),
      box             INTEGER DEFAULT 0,
      box_qty         INTEGER DEFAULT 0,
      loose_box       INTEGER DEFAULT 0,
      loose_box_qty   INTEGER DEFAULT 0,
      total_qty       INTEGER DEFAULT 0,
      
      approved   BOOLEAN DEFAULT false,
      approved_by INTEGER REFERENCES users(id),
      approved_at TIMESTAMP,
      is_deleted  BOOLEAN DEFAULT false,
      deleted_by  INTEGER REFERENCES users(id),
      deleted_at  TIMESTAMP,
      created_by  INTEGER REFERENCES users(id),
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id),
      updated_at  TIMESTAMP
    );
  `);
}