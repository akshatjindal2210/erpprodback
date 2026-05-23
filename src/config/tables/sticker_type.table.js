import dbQuery from "../db.js";

export async function createStickerTypeTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS sticker_type (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(50) UNIQUE,

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
