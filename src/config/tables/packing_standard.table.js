import dbQuery from "../db.js";

export async function createPackingStandardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS packing_standard (
      standard_id  SERIAL PRIMARY KEY,
      item_dcode   INTEGER NOT NULL,
      qty          INTEGER,
      unit         VARCHAR(50),
      type         INTEGER REFERENCES category(id),
      sticker_type INTEGER REFERENCES sticker_type(id),
      acc_code     INTEGER,
      approved     BOOLEAN DEFAULT false,
      approved_by  INTEGER REFERENCES users(id),
      approved_at  TIMESTAMP,
      is_deleted   BOOLEAN DEFAULT false,
      deleted_by   INTEGER REFERENCES users(id),
      deleted_at   TIMESTAMP,
      created_by   INTEGER REFERENCES users(id),
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_by   INTEGER REFERENCES users(id),
      updated_at   TIMESTAMP
    );
  `);
}