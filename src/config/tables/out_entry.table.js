import dbQuery from "../db.js";

export async function createOutEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS out_entry (
      out_uid     SERIAL PRIMARY KEY,
      fuid        INTEGER NOT NULL REFERENCES forwarding_note_master(fuid) ON DELETE CASCADE,
      remarks     TEXT,
      approved    BOOLEAN DEFAULT false,
      approved_by INTEGER REFERENCES users(id),
      approved_at TIMESTAMP,
      is_deleted  BOOLEAN DEFAULT false,
      deleted_by  INTEGER REFERENCES users(id),
      deleted_at  TIMESTAMP,
      created_by  INTEGER REFERENCES users(id),
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id),
      updated_at  TIMESTAMP,
      scan_complete   BOOLEAN DEFAULT false,
      boxes_required  INTEGER DEFAULT 0,
      boxes_scanned   INTEGER DEFAULT 0
    );
  `);

  await dbQuery(`ALTER TABLE out_entry ADD COLUMN IF NOT EXISTS scan_complete BOOLEAN DEFAULT false`);
  await dbQuery(`ALTER TABLE out_entry ADD COLUMN IF NOT EXISTS boxes_required INTEGER DEFAULT 0`);
  await dbQuery(`ALTER TABLE out_entry ADD COLUMN IF NOT EXISTS boxes_scanned INTEGER DEFAULT 0`);
}