import dbQuery from "../db.js";

export async function createOutEntryScannedBoxTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS out_entry_scanned_box (
      out_uid     INTEGER NOT NULL REFERENCES out_entry(out_uid) ON DELETE CASCADE,
      box_no_uid  TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (out_uid, box_no_uid)
    );
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_out_entry_scanned_box_box
      ON out_entry_scanned_box (box_no_uid);
  `);

  // One-time: move draft out-entry links off box_table into scan draft table (only if box_table exists)
  const [{ exists: boxTableExists }] = await dbQuery(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'box_table'
    ) AS exists
  `);
  if (boxTableExists) {
    await dbQuery(`
      INSERT INTO out_entry_scanned_box (out_uid, box_no_uid)
      SELECT b.out_uid, b.box_no_uid::text
      FROM box_table b
      INNER JOIN out_entry o ON o.out_uid = b.out_uid
      WHERE o.approved = false
        AND o.is_deleted = false
        AND b.is_deleted = false
        AND b.box_no_uid IS NOT NULL
        AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
      ON CONFLICT (out_uid, box_no_uid) DO NOTHING
    `);
    await dbQuery(`
      UPDATE box_table b
      SET out_uid = NULL,
          updated_at = NOW()
      FROM out_entry o
      WHERE b.out_uid = o.out_uid
        AND o.approved = false
        AND o.is_deleted = false
        AND b.sa_entry_type IS DISTINCT FROM 'stock_out'
    `);
  }
}
