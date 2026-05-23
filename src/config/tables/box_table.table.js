import dbQuery from "../db.js";

export async function createBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS box_table (
      box_uid         SERIAL PRIMARY KEY,
      box_no_uid      VARCHAR(120),
      packing_number  VARCHAR(50),
      qty             INTEGER,
      override_cust   VARCHAR(100),
      is_loose        BOOLEAN DEFAULT false,
      sa_id           INTEGER REFERENCES stock_adjustment(adjustment_id) ON DELETE SET NULL,
      sa_entry_type   VARCHAR(20) CHECK (sa_entry_type IN ('stock_in', 'stock_out')),
      location_id     INTEGER REFERENCES location_master(location_id),
      in_uid          INTEGER,
      out_uid         INTEGER,
      fuid            INTEGER,
      download_count  INTEGER DEFAULT 0,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES users(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES users(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES users(id),
      updated_at      TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_box_packing_num ON box_table(packing_number);
    CREATE INDEX IF NOT EXISTS idx_box_no_uid_active ON box_table (box_no_uid) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS idx_box_packing_active ON box_table (packing_number)
      WHERE is_deleted = false AND (sa_entry_type IS DISTINCT FROM 'stock_out');
  `);

  await dbQuery(`
    ALTER TABLE box_table DROP COLUMN IF EXISTS approved;
    ALTER TABLE box_table DROP COLUMN IF EXISTS approved_by;
    ALTER TABLE box_table DROP COLUMN IF EXISTS approved_at;
  `);
}

export async function createBoxDownloadLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS box_download_log (
      log_id                SERIAL PRIMARY KEY,
      box_uid               INTEGER REFERENCES box_table(box_uid) ON DELETE CASCADE,
      cust_at_time          VARCHAR(100),
      downloaded_by         INTEGER NOT NULL REFERENCES users(id),
      downloaded_at         TIMESTAMP DEFAULT NOW(),
      download_type         VARCHAR(20) DEFAULT 'single',
      bulk_packing_number   VARCHAR(80),
      bulk_sticker_count    INTEGER,
      download_source       VARCHAR(48)
    );

    CREATE INDEX IF NOT EXISTS idx_bdl_box_uids ON box_download_log(box_uid);
    CREATE INDEX IF NOT EXISTS idx_bdl_downloaded_by ON box_download_log(downloaded_by);
    CREATE INDEX IF NOT EXISTS idx_bdl_bulk_packing ON box_download_log(bulk_packing_number) 
      WHERE bulk_packing_number IS NOT NULL;
  `);

  await dbQuery(`
    ALTER TABLE box_download_log
    ADD COLUMN IF NOT EXISTS download_source VARCHAR(48);
  `);
}

export async function createBoxOverrideRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS box_override_request (
      request_id       SERIAL PRIMARY KEY,
      packing_number   VARCHAR(50) NOT NULL,
      itemdcode        VARCHAR(100) NOT NULL,
      box_uids         TEXT[] NOT NULL,
      from_customer    VARCHAR(150),
      to_customer      VARCHAR(150) NOT NULL,
      approved         BOOLEAN DEFAULT false,
      status           VARCHAR(20) DEFAULT 'pending',
      remarks          TEXT,
      requested_by     INTEGER NOT NULL REFERENCES users(id),
      requested_at     TIMESTAMP DEFAULT NOW(),
      approved_by      INTEGER REFERENCES users(id),
      approved_at      TIMESTAMP,
      updated_by       INTEGER REFERENCES users(id),
      updated_at       TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_box_override_approved ON box_override_request(approved);
    CREATE INDEX IF NOT EXISTS idx_box_override_status ON box_override_request(status);
    CREATE INDEX IF NOT EXISTS idx_box_override_packing ON box_override_request(packing_number);
  `);
}