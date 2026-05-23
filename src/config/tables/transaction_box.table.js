import dbQuery from "../db.js";

export async function createTransactionBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS transaction_box (
      id                SERIAL PRIMARY KEY,
      transaction_type  VARCHAR(48) NOT NULL,
      source_module     VARCHAR(48) NOT NULL,
      source_id         VARCHAR(64),
      packing_number    VARCHAR(50),
      user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details           JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_box_created ON transaction_box(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_box_type ON transaction_box(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_tx_box_source ON transaction_box(source_module, source_id);
    CREATE INDEX IF NOT EXISTS idx_tx_box_packing ON transaction_box(packing_number);
    CREATE INDEX IF NOT EXISTS idx_tx_box_details ON transaction_box USING gin (details);
  `);

  await dbQuery(`ALTER TABLE transaction_box DROP COLUMN IF EXISTS box_uid`);
  await dbQuery(`ALTER TABLE transaction_box DROP COLUMN IF EXISTS box_no_uid`);
  await dbQuery(`ALTER TABLE transaction_box DROP COLUMN IF EXISTS ip_address`);
  await dbQuery(`ALTER TABLE transaction_box DROP COLUMN IF EXISTS user_agent`);
}
