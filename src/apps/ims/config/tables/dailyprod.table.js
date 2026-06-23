import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { backfillDailyprodStickerColumns } from "../../utils/packing-entry/backfillDailyprodStickerSnapshot.js";

export async function createDailyProdTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.DAILYPROD} (
      doc_no                SERIAL PRIMARY KEY,
      doc_dt                DATE,
      job_card_no           VARCHAR(50),
      acc_code              INTEGER,
      item_dcode            INTEGER,
      total_qty             NUMERIC(18,3),
      sticker_generated     BOOLEAN DEFAULT false,
      packing_standard_id   INTEGER REFERENCES ${T.PACKING_STANDARD}(standard_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dailyprod_doc_no_text ON ${T.DAILYPROD} ((TRIM(doc_no::text)));
  `);

  /** Extra sticker / display fields — columns only (no JSON snapshot). */
  await patchTableSchema(dbQuery, T.DAILYPROD, {
    columns: [
      patchCol("acc_name", "VARCHAR(255)"),
      patchCol("item_code", "VARCHAR(50)"),
      patchCol("item_desc", "TEXT"),
      patchCol("party_rate_cust_code", "VARCHAR(64)"),
      patchCol("unit", "VARCHAR(50) DEFAULT 'PCS'"),
      patchCol("fg_location", "VARCHAR(128)"),
      patchCol("category_id", "INTEGER"),
      patchCol("category_name", "VARCHAR(255)"),
      patchCol("qty_per_box", "NUMERIC(18,3)"),
      patchCol("full_boxes_count", "INTEGER"),
      patchCol("loose_box_qty", "NUMERIC(18,3)"),
      patchCol("total_stickers", "INTEGER"),
    ],
  });

  const { updated } = await backfillDailyprodStickerColumns();
  if (updated > 0) {
    console.log(`✅ Backfilled ${updated} ims_dailyprod sticker column row(s)`);
  }
}
