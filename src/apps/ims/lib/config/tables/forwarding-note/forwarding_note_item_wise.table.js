import dbQuery from "../../../../../../config/db/db.js";
import { patchTableSchema, patchCol, dropColumnIfExists } from "../../../../../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";

/**
 * Item-wise line bills (manual assign when live invfnote blank): bill_no, bill_dt, bill_updated_by, bill_updated_at
 * Master has no bill columns — summary rolls up unique item bills.
 */
export async function createForwardingNoteItemWiseTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.FORWARDING_NOTE_ITEM_WISE} (
      id              SERIAL PRIMARY KEY,
      fuid            INTEGER NOT NULL REFERENCES ${T.FORWARDING_NOTE_MASTER}(fuid) ON DELETE CASCADE,
      item_dcode      INTEGER NOT NULL,
      packing_number  VARCHAR(50),
      box             INTEGER DEFAULT 0,
      box_qty         INTEGER DEFAULT 0,
      loose_box       INTEGER DEFAULT 0,
      loose_box_qty   INTEGER DEFAULT 0,
      total_qty       INTEGER DEFAULT 0,
      schno           VARCHAR(32),
      bill_no         TEXT,
      bill_dt         TEXT,
      bill_updated_by TEXT,
      bill_updated_at TIMESTAMP,
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
  `);

  await patchTableSchema(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, {
    columns: [
      patchCol("schno", "VARCHAR(32)"),
      patchCol("bill_no", "TEXT"),
      patchCol("bill_dt", "TEXT"),
      patchCol("bill_updated_by", "TEXT"),
      patchCol("bill_updated_at", "TIMESTAMP"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_fn_item_schno ON ${T.FORWARDING_NOTE_ITEM_WISE}(schno) WHERE schno IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_fn_item_bill_no ON ${T.FORWARDING_NOTE_ITEM_WISE}(bill_no) WHERE bill_no IS NOT NULL AND is_deleted = false`,
    ],
  });

  // Drop draft cols from earlier bill design (uid/muid/status)
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, "bill_uid");
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, "bill_muid");
  await dropColumnIfExists(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, "bill_status");
}
