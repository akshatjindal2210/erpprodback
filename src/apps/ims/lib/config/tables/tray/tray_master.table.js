import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import {
  columnExists,
  dropColumnIfExists,
  patchCol,
  patchTableSchema,
} from "../../../../../../config/db/ensureDbColumns.js";

async function ensureTrayMasterLetterColumn() {
  await patchTableSchema(dbQuery, T.TRAY_MASTER, {
    columns: [patchCol("letter", "VARCHAR(20)"), patchCol("weight", "NUMERIC(14, 3)")],
  });

  if (await columnExists(dbQuery, T.TRAY_MASTER, "category")) {
    await dbQuery(
      `UPDATE ${T.TRAY_MASTER}
       SET letter = UPPER(BTRIM(category))
       WHERE (letter IS NULL OR BTRIM(letter) = '')
         AND category IS NOT NULL AND BTRIM(category) <> ''`,
    );
  }

  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_serial_unique`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_category_serial_uq`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_serial_legacy_uq`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_letter_serial_uq`);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_serial_legacy_uq
      ON ${T.TRAY_MASTER} (type, serial_number)
      WHERE letter IS NULL OR BTRIM(letter) = ''
  `);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_letter_serial_uq
      ON ${T.TRAY_MASTER} (type, letter, serial_number)
      WHERE letter IS NOT NULL AND BTRIM(letter) <> ''
  `);

  if (await columnExists(dbQuery, T.TRAY_MASTER, "category")) {
    await dbQuery(`ALTER TABLE ${T.TRAY_MASTER} DROP COLUMN IF EXISTS category`);
  }
}

export async function createTrayMasterTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_MASTER} (
      id             SERIAL PRIMARY KEY,
      code           VARCHAR(100) NOT NULL UNIQUE,
      type           VARCHAR(20) NOT NULL,
      serial_number  INTEGER NOT NULL,
      batch_id       INTEGER NOT NULL REFERENCES ${T.TRAY_BATCH}(id),
      letter         VARCHAR(20),
      weight         NUMERIC(14, 3),
      status         VARCHAR(20) NOT NULL DEFAULT 'active',
      box_uid        INTEGER REFERENCES ${T.BOX_TABLE}(box_uid) ON DELETE SET NULL,
      updated_by     TEXT,
      updated_at     TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS tray_master_batch_idx ON ${T.TRAY_MASTER} (batch_id);
    CREATE INDEX IF NOT EXISTS tray_master_status_idx ON ${T.TRAY_MASTER} (status);
    CREATE INDEX IF NOT EXISTS idx_tray_master_box_uid ON ${T.TRAY_MASTER}(box_uid) WHERE box_uid IS NOT NULL;
  `);

  await ensureTrayMasterLetterColumn();

  await dbQuery(`DROP INDEX IF EXISTS tray_master_owner_app_idx`);
  await dropColumnIfExists(dbQuery, T.TRAY_MASTER, "owner_app");
}
