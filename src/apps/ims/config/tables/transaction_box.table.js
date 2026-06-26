import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
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
      user_name         VARCHAR(100),
      details           JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_box_created ON ${T.TRANSACTION_BOX}(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_box_type ON ${T.TRANSACTION_BOX}(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_tx_box_source ON ${T.TRANSACTION_BOX}(source_module, source_id);
    CREATE INDEX IF NOT EXISTS idx_tx_box_details ON ${T.TRANSACTION_BOX} USING gin (details);
  `);

  await patchTableSchema(dbQuery, T.TRANSACTION_BOX, {
    columns: [
      patchCol("packing_number", "VARCHAR(50)"),
      patchCol("user_name", "VARCHAR(100)"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_tx_box_packing ON ${T.TRANSACTION_BOX}(packing_number)`,
      `CREATE INDEX IF NOT EXISTS idx_tx_box_search_trgm ON ${T.TRANSACTION_BOX} USING gin (transaction_type gin_trgm_ops, source_module gin_trgm_ops, packing_number gin_trgm_ops, user_name gin_trgm_ops)`,
    ],
  });

  // Backfill user_name
  await dbQuery(`
    UPDATE ${T.TRANSACTION_BOX} tb
    SET user_name = u.name
    FROM ${C.USERS} u
    WHERE tb.user_id = u.id AND tb.user_name IS NULL
  `);
}
