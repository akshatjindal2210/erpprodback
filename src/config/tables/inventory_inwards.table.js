import dbQuery from "../db.js";

export async function createInventoryInwardsTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS inventory_inwards (
      in_uid           SERIAL PRIMARY KEY,
      packing_number   TEXT,
      remarks          TEXT,
      approved         BOOLEAN DEFAULT false,
      approved_by      INTEGER REFERENCES users(id),
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       INTEGER REFERENCES users(id),
      deleted_at       TIMESTAMP,
      created_by       INTEGER REFERENCES users(id),
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       INTEGER REFERENCES users(id),
      updated_at       TIMESTAMP
    );
  `);
  // Older DBs used VARCHAR(50); widen so multiple packing numbers ("A | B") fit.
  try {
    await dbQuery(`
      ALTER TABLE inventory_inwards
      ALTER COLUMN packing_number TYPE TEXT
    `);
  } catch {
    // ignore if column missing or already TEXT
  }
}