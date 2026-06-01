import dbQuery from "../../../../config/db.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.BOX_TABLE} (
      box_uid         SERIAL PRIMARY KEY,
      box_no_uid      VARCHAR(120),
      packing_number  VARCHAR(50),
      qty             INTEGER,
      override_cust   VARCHAR(100),
      is_loose        BOOLEAN DEFAULT false,
      sa_id           INTEGER REFERENCES ${T.STOCK_ADJUSTMENT}(adjustment_id) ON DELETE SET NULL,
      sa_entry_type   VARCHAR(20) CHECK (sa_entry_type IN ('stock_in', 'stock_out')),
      location_id     INTEGER REFERENCES ${T.LOCATION_MASTER}(location_id),
      in_uid          INTEGER,
      out_uid         INTEGER,
      fuid            INTEGER,
      download_count  INTEGER DEFAULT 0,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES ${C.USERS}(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES ${C.USERS}(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES ${C.USERS}(id),
      updated_at      TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_box_packing_num ON ${T.BOX_TABLE}(packing_number);
    CREATE INDEX IF NOT EXISTS idx_box_no_uid_active ON ${T.BOX_TABLE}(box_no_uid)
      WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_box_packing_active ON ${T.BOX_TABLE}(packing_number)
      WHERE is_deleted = false AND (sa_entry_type IS DISTINCT FROM 'stock_out');
  `);
}

export async function createBoxDownloadLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.BOX_DOWNLOAD_LOG} (
      log_id                SERIAL PRIMARY KEY,
      box_uid               INTEGER REFERENCES ${T.BOX_TABLE}(box_uid) ON DELETE CASCADE,
      cust_at_time          VARCHAR(100),
      downloaded_by         INTEGER NOT NULL REFERENCES ${C.USERS}(id),
      downloaded_at         TIMESTAMP DEFAULT NOW(),
      download_type         VARCHAR(20) DEFAULT 'single',
      bulk_packing_number   VARCHAR(80),
      bulk_sticker_count    INTEGER,
      download_source       VARCHAR(48)
    );

    CREATE INDEX IF NOT EXISTS idx_bdl_box_uids ON ${T.BOX_DOWNLOAD_LOG}(box_uid);
    CREATE INDEX IF NOT EXISTS idx_bdl_downloaded_by ON ${T.BOX_DOWNLOAD_LOG}(downloaded_by);
    CREATE INDEX IF NOT EXISTS idx_bdl_bulk_packing ON ${T.BOX_DOWNLOAD_LOG}(bulk_packing_number)
      WHERE bulk_packing_number IS NOT NULL;
  `);
}

export async function createBoxOverrideRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.BOX_OVERRIDE_REQUEST} (
      request_id       SERIAL PRIMARY KEY,
      packing_number   VARCHAR(50) NOT NULL,
      itemdcode        VARCHAR(100) NOT NULL,
      box_uids         TEXT[] NOT NULL,
      from_customer    VARCHAR(150),
      to_customer      VARCHAR(150) NOT NULL,
      approved         BOOLEAN DEFAULT false,
      status           VARCHAR(20) DEFAULT 'pending',
      remarks          TEXT,
      requested_by     INTEGER NOT NULL REFERENCES ${C.USERS}(id),
      requested_at     TIMESTAMP DEFAULT NOW(),
      approved_by      INTEGER REFERENCES ${C.USERS}(id),
      approved_at      TIMESTAMP,
      updated_by       INTEGER REFERENCES ${C.USERS}(id),
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_box_override_approved ON ${T.BOX_OVERRIDE_REQUEST}(approved);
    CREATE INDEX IF NOT EXISTS idx_box_override_status ON ${T.BOX_OVERRIDE_REQUEST}(status);
    CREATE INDEX IF NOT EXISTS idx_box_override_packing ON ${T.BOX_OVERRIDE_REQUEST}(packing_number);
  `);
}
