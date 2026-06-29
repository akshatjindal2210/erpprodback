import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol, runIfColumnExists, dropColumnIfExists } from "../../../../config/ensureDbColumns.js";
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
      qc_hold_id      INTEGER REFERENCES ${T.QC_HOLD_MATERIAL}(hold_id) ON DELETE SET NULL,
      download_count  INTEGER DEFAULT 0,
      is_deleted      BOOLEAN DEFAULT false,
      deleted_by      INTEGER REFERENCES ${C.USERS}(id),
      deleted_at      TIMESTAMP,
      created_by      INTEGER REFERENCES ${C.USERS}(id),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_by      INTEGER REFERENCES ${C.USERS}(id),
      updated_at      TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_box_no_uid ON ${T.BOX_TABLE}(box_no_uid);
    CREATE INDEX IF NOT EXISTS idx_box_is_deleted ON ${T.BOX_TABLE}(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_box_location_id ON ${T.BOX_TABLE}(location_id);
    CREATE INDEX IF NOT EXISTS idx_box_in_uid ON ${T.BOX_TABLE}(in_uid);
    CREATE INDEX IF NOT EXISTS idx_box_out_uid ON ${T.BOX_TABLE}(out_uid);
    CREATE INDEX IF NOT EXISTS idx_box_sa_id ON ${T.BOX_TABLE}(sa_id);
    CREATE INDEX IF NOT EXISTS idx_box_qc_hold_id ON ${T.BOX_TABLE}(qc_hold_id);
    CREATE INDEX IF NOT EXISTS idx_box_created_at ON ${T.BOX_TABLE}(created_at DESC);
  `);

  await patchTableSchema(dbQuery, T.BOX_TABLE, {
    columns: [
      patchCol("packing_number", "VARCHAR(50)"),
      patchCol("fuid", "INTEGER"),
      patchCol("qc_hold_id", "INTEGER"),
      patchCol("download_count", "INTEGER DEFAULT 0"),
      patchCol("is_loose", "BOOLEAN DEFAULT false"),
      patchCol("sa_entry_type", "VARCHAR(20)"),
      patchCol("category_id", "INTEGER"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_box_packing_number ON ${T.BOX_TABLE}(packing_number)`,
      `CREATE INDEX IF NOT EXISTS idx_box_fuid ON ${T.BOX_TABLE}(fuid)`,
      `CREATE INDEX IF NOT EXISTS idx_box_download_count ON ${T.BOX_TABLE}(download_count)`,
      `CREATE INDEX IF NOT EXISTS idx_box_in_hand ON ${T.BOX_TABLE}(is_deleted, out_uid, location_id) WHERE is_deleted = false AND out_uid IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_box_sa_lookup ON ${T.BOX_TABLE}(sa_id, is_deleted) WHERE sa_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_box_packing_number_trimmed ON ${T.BOX_TABLE} (NULLIF(TRIM(packing_number::text), ''))`,
      `CREATE INDEX IF NOT EXISTS idx_box_no_uid_trgm ON ${T.BOX_TABLE} USING gin (box_no_uid gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_box_packing_number_trgm ON ${T.BOX_TABLE} USING gin (packing_number gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_box_category_id ON ${T.BOX_TABLE}(category_id) WHERE category_id IS NOT NULL`,
    ],
  });

  await dropColumnIfExists(dbQuery, T.BOX_TABLE, "category_name");

  await runIfColumnExists(dbQuery, T.BOX_TABLE, "sa_entry_type", async () => {
    await dbQuery(`
      UPDATE ${T.BOX_TABLE}
      SET sa_entry_type = 'stock_in'
      WHERE sa_id IS NOT NULL AND sa_entry_type IS NULL
    `);
  });
}

export async function createBoxDownloadLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.BOX_DOWNLOAD_LOG} (
      log_id           SERIAL PRIMARY KEY,
      box_uid          INTEGER REFERENCES ${T.BOX_TABLE}(box_uid) ON DELETE CASCADE,
      packing_number   VARCHAR(50),
      item_dcode       VARCHAR(100),
      acc_name         VARCHAR(255),
      downloaded_by    INTEGER NOT NULL REFERENCES ${C.USERS}(id),
      downloaded_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      download_type    VARCHAR(20) NOT NULL DEFAULT 'single',
      sticker_count    INTEGER NOT NULL DEFAULT 1,
      download_source  VARCHAR(48)
    );

    CREATE INDEX IF NOT EXISTS idx_bdl_box_uid ON ${T.BOX_DOWNLOAD_LOG}(box_uid);
    CREATE INDEX IF NOT EXISTS idx_bdl_downloaded_by ON ${T.BOX_DOWNLOAD_LOG}(downloaded_by);
    CREATE INDEX IF NOT EXISTS idx_bdl_downloaded_at ON ${T.BOX_DOWNLOAD_LOG}(downloaded_at DESC);
  `);

  await patchTableSchema(dbQuery, T.BOX_DOWNLOAD_LOG, {
    columns: [
      patchCol("packing_number", "VARCHAR(50)"),
      patchCol("item_dcode", "VARCHAR(100)"),
      patchCol("acc_name", "VARCHAR(255)"),
      patchCol("download_source", "VARCHAR(48)"),
      patchCol("sticker_count", "INTEGER NOT NULL DEFAULT 1"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_bdl_packing_number ON ${T.BOX_DOWNLOAD_LOG}(packing_number)`,
    ],
  });

  await migrateBoxDownloadLogData();
}

async function migrateBoxDownloadLogData() {
  await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "bulk_packing_number", async () => {
    await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "packing_number", async () => {
      await dbQuery(`
        UPDATE ${T.BOX_DOWNLOAD_LOG}
        SET packing_number = COALESCE(NULLIF(TRIM(packing_number), ''), NULLIF(TRIM(bulk_packing_number), ''))
        WHERE packing_number IS NULL OR TRIM(packing_number) = ''
      `);
    });
  });

  await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "packing_number", async () => {
    await runIfColumnExists(dbQuery, T.BOX_TABLE, "packing_number", async () => {
      await dbQuery(`
        UPDATE ${T.BOX_DOWNLOAD_LOG} l
        SET packing_number = b.packing_number::text
        FROM ${T.BOX_TABLE} b
        WHERE l.box_uid = b.box_uid AND (l.packing_number IS NULL OR TRIM(l.packing_number) = '')
      `);
    });
  });

  await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "cust_at_time", async () => {
    await dbQuery(`
      UPDATE ${T.BOX_DOWNLOAD_LOG}
      SET acc_name = COALESCE(NULLIF(TRIM(acc_name), ''), NULLIF(TRIM(cust_at_time), ''))
      WHERE acc_name IS NULL OR TRIM(acc_name) = ''
    `);
  });

  await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "bulk_sticker_count", async () => {
    await dbQuery(`
      UPDATE ${T.BOX_DOWNLOAD_LOG}
      SET sticker_count = GREATEST(1, COALESCE(bulk_sticker_count, 1))
      WHERE download_type = 'bulk_pack'
    `);
    await dbQuery(`
      UPDATE ${T.BOX_DOWNLOAD_LOG}
      SET sticker_count = 1
      WHERE download_type IS DISTINCT FROM 'bulk_pack'
        AND (sticker_count IS NULL OR sticker_count < 1)
    `);
  });

  await runIfColumnExists(dbQuery, T.BOX_DOWNLOAD_LOG, "packing_number", async () => {
    await dbQuery(`
      UPDATE ${T.BOX_DOWNLOAD_LOG} l
      SET item_dcode = COALESCE(NULLIF(TRIM(l.item_dcode), ''), dp.item_dcode::text),
          acc_name   = COALESCE(NULLIF(TRIM(l.acc_name), ''), dp.acc_name)
      FROM ims_dailyprod dp
      WHERE l.packing_number = dp.doc_no::text
        AND (l.item_dcode IS NULL OR l.acc_name IS NULL OR TRIM(l.acc_name) = '')
    `);
  });

  await dbQuery(`DROP INDEX IF EXISTS idx_bdl_bulk_packing`);
  await dbQuery(`DROP INDEX IF EXISTS idx_bdl_search_trgm`);
  await dbQuery(`DROP INDEX IF EXISTS idx_bdl_item_dcode`);
  await dbQuery(`DROP INDEX IF EXISTS idx_bdl_acc_code`);
  await dbQuery(`DROP INDEX IF EXISTS idx_bdl_box_uids`);

  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "downloaded_by_name");
  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "cust_at_time");
  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "bulk_packing_number");
  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "item_code");
  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "acc_code");
  await dropColumnIfExists(dbQuery, T.BOX_DOWNLOAD_LOG, "bulk_sticker_count");
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
  `);

  await patchTableSchema(dbQuery, T.BOX_OVERRIDE_REQUEST, {
    columns: [
      patchCol("packing_number", "VARCHAR(50)"),
      patchCol("itemdcode", "VARCHAR(100)"),
      patchCol("from_customer", "VARCHAR(150)"),
      patchCol("to_customer", "VARCHAR(150)"),
      patchCol("status", "VARCHAR(20) DEFAULT 'pending'"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_box_override_packing ON ${T.BOX_OVERRIDE_REQUEST}(packing_number)`,
    ],
  });
}
