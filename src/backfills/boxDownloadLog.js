import dbQuery from "../config/db/db.js";
import { runIfColumnExists, dropColumnIfExists } from "../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../config/db/dbTables.js";

/** Legacy download-log column rename / fill + drop obsolete cols (idempotent). */
export async function runBoxDownloadLogBackfill() {
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
