import dbQuery from "../db.js";

export async function createStockAdjustmentTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS stock_adjustment (
      adjustment_id   SERIAL PRIMARY KEY,
      item_dcode      INTEGER NOT NULL,
      qty             INTEGER,
      unit            VARCHAR(50),
      remarks         TEXT,
      approved        BOOLEAN DEFAULT false,
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES users(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES users(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES users(id),
      updated_at      TIMESTAMP
    );
  `);

  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS entry_type VARCHAR(16);`);
  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS packing_number VARCHAR(128);`);
  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS financial_year VARCHAR(32);`);
  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS per_box_qty INTEGER;`);
  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS box_count_impact INTEGER;`);
  await dbQuery(`ALTER TABLE stock_adjustment ADD COLUMN IF NOT EXISTS removed_box_ids TEXT;`);
}
