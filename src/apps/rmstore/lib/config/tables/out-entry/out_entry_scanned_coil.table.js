import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { dropColumnsIfExist, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/** One-shot: missing scanned rows + null qty + header total_qty. Safe re-run. */
async function backfillOutEntryScannedCoilQty() {
  await dbQuery(`
    INSERT INTO ${T.OUT_ENTRY_SCANNED_COIL} (out_uid, coil_no_uid, qty)
    SELECT c.out_uid, c.coil_no_uid, c.qty FROM ${T.COIL_TABLE} c
    INNER JOIN ${T.OUT_ENTRY} o ON o.out_uid = c.out_uid AND o.is_deleted = false
    WHERE TRUE
    ON CONFLICT (out_uid, coil_no_uid) DO NOTHING
  `);
  await dbQuery(`
    UPDATE ${T.OUT_ENTRY_SCANNED_COIL} s
    SET qty = c.qty
    FROM ${T.COIL_TABLE} c
    WHERE LOWER(TRIM(c.coil_no_uid)) = LOWER(TRIM(s.coil_no_uid)) AND s.qty IS NULL
  `);
  await dbQuery(`
    UPDATE ${T.OUT_ENTRY} o
    SET total_qty = COALESCE((
      SELECT SUM(COALESCE(s.qty, 0))
      FROM ${T.OUT_ENTRY_SCANNED_COIL} s
      WHERE s.out_uid = o.out_uid
    ), 0)
    WHERE o.is_deleted = false
  `);
}

/** Per out_uid: coil + qty only. heat/mrn from coil→MRN JOIN. */
export async function createRmStoreOutEntryScannedCoilTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.OUT_ENTRY_SCANNED_COIL} (
      out_uid      INTEGER NOT NULL REFERENCES ${T.OUT_ENTRY}(out_uid) ON DELETE CASCADE,
      coil_no_uid  TEXT NOT NULL,
      qty          NUMERIC,
      created_at   TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (out_uid, coil_no_uid)
    );

    CREATE INDEX IF NOT EXISTS rmstore_out_entry_scanned_coil_coil_idx
      ON ${T.OUT_ENTRY_SCANNED_COIL} (coil_no_uid);
  `);

  await patchTableSchema(dbQuery, T.OUT_ENTRY_SCANNED_COIL, {
    columns: [patchCol("qty", "NUMERIC")],
  });

  await dropColumnsIfExist(dbQuery, T.OUT_ENTRY_SCANNED_COIL, ["heat_no", "mrn_uid"]);

  // OFF Bcakfill
  await backfillOutEntryScannedCoilQty();
}
