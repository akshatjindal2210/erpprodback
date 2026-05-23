import dbQuery from "../db.js";

export async function createDailyProdTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS dailyprod (
      doc_no                SERIAL PRIMARY KEY,
      doc_dt                DATE,
      job_card_no           VARCHAR(50),
      acc_code              INTEGER,
      item_dcode            INTEGER,
      total_qty             NUMERIC(18,3),
      sticker_generated     BOOLEAN DEFAULT false,
      packing_standard_id   INTEGER REFERENCES packing_standard(standard_id) ON DELETE SET NULL
    );
  `);
}