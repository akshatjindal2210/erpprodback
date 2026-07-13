import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { migrateTableAuditColumnsToUserNames } from "../../../../config/auditUserNameColumns.js";

export async function createOutEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.OUT_ENTRY} (
      out_uid           SERIAL PRIMARY KEY,
      fuid              INTEGER REFERENCES ${T.FORWARDING_NOTE_MASTER}(fuid) ON DELETE CASCADE,
      qc_hold_id        INTEGER REFERENCES ${T.QC_HOLD_MATERIAL}(hold_id) ON DELETE SET NULL,
      entry_type        VARCHAR(20) DEFAULT 'forwarding_note',
      packing_numbers   TEXT,
      item_codes        TEXT,
      qtys              TEXT,
      total_qty         INTEGER DEFAULT 0,
      remarks           TEXT,
      approved          BOOLEAN DEFAULT false,
      approved_by       TEXT,
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        TEXT,
      deleted_at        TIMESTAMP,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMP,
      scan_complete     BOOLEAN DEFAULT false,
      boxes_required    INTEGER DEFAULT 0,
      boxes_scanned     INTEGER DEFAULT 0,
      reason            VARCHAR(200)
    );
  `);

  await patchTableSchema(dbQuery, T.OUT_ENTRY, {
    columns: [
      patchCol("qc_hold_id", `INTEGER REFERENCES ${T.QC_HOLD_MATERIAL}(hold_id) ON DELETE SET NULL`),
    ],
  });

  // ONE-TIME: INT id → user name. After prod OK, remove this call.
  await migrateTableAuditColumnsToUserNames(dbQuery, T.OUT_ENTRY);
}
