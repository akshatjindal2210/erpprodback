import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createTransactionBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRANSACTION_BOX} (
      id                SERIAL PRIMARY KEY,
      transaction_type  VARCHAR(48) NOT NULL,
      source_module     VARCHAR(48) NOT NULL,
      source_id         VARCHAR(64),
      packing_number    VARCHAR(50),
      user_id           INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      details           JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_box_created ON ${T.TRANSACTION_BOX}(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_box_type ON ${T.TRANSACTION_BOX}(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_tx_box_source ON ${T.TRANSACTION_BOX}(source_module, source_id);
    CREATE INDEX IF NOT EXISTS idx_tx_box_packing ON ${T.TRANSACTION_BOX}(packing_number);
    CREATE INDEX IF NOT EXISTS idx_tx_box_details ON ${T.TRANSACTION_BOX} USING gin (details);
  `);
}
