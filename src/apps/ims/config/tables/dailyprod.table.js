import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";

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
  `);
}
