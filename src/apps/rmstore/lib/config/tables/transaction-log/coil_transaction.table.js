import dbQuery from "../../../../../../config/db/db.js";
import { MST_TABLES as C, RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createRmStoreCoilTransactionTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.COIL_TRANSACTION} (
      id                SERIAL PRIMARY KEY,
      transaction_type  VARCHAR(48) NOT NULL,
      source_module     VARCHAR(48) NOT NULL,
      source_id         VARCHAR(64),
      mrn_no            VARCHAR(50),
      user_id           INTEGER REFERENCES ${C.USERS}(id) ON DELETE SET NULL,
      user_name         VARCHAR(100),
      details           JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_rm_coil_tx_created ON ${T.COIL_TRANSACTION}(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rm_coil_tx_type ON ${T.COIL_TRANSACTION}(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_rm_coil_tx_source ON ${T.COIL_TRANSACTION}(source_module, source_id);
    CREATE INDEX IF NOT EXISTS idx_rm_coil_tx_mrn ON ${T.COIL_TRANSACTION}(mrn_no);
    CREATE INDEX IF NOT EXISTS idx_rm_coil_tx_details ON ${T.COIL_TRANSACTION} USING gin (details);
  `);
}
