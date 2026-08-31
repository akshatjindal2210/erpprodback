import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

export async function createShortageTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SHORTAGE} (
      id              SERIAL PRIMARY KEY,
      itemdcode       INTEGER NOT NULL,
      itemcode        VARCHAR(50),
      type            VARCHAR(32) NOT NULL CHECK (type IN ('PPC', 'Deviation', 'Additional')),
      qty             INTEGER NOT NULL CHECK (qty > 0),
      month           DATE NOT NULL DEFAULT CURRENT_DATE,
      remarks         TEXT,
      approved        BOOLEAN DEFAULT false,
      approved_by     TEXT,
      approved_at     TIMESTAMP,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      TEXT,
      deleted_at      TIMESTAMP,
      created_by      TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_shortage_itemdcode ON ${T.SHORTAGE}(itemdcode) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_shortage_month ON ${T.SHORTAGE}(month) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_shortage_approved ON ${T.SHORTAGE}(approved) WHERE is_deleted = false;
  `);
}
