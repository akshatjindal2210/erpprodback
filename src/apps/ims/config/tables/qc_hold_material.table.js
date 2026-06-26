import dbQuery from "../../../../config/db.js";
import { patchTableSchema, patchCol } from "../../../../config/ensureDbColumns.js";
import { MST_TABLES as C, IMS_TABLES as T } from "../../../../config/dbTables.js";

export async function createQcHoldMaterialTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.QC_HOLD_MATERIAL} (
      hold_id           SERIAL PRIMARY KEY,
      packing_number    VARCHAR(128),
      item_dcode        INTEGER,
      status            VARCHAR(20) DEFAULT 'pending',
      reason            TEXT,
      remarks           TEXT,
      hold_data         JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved          BOOLEAN DEFAULT false,
      approved_by       INTEGER REFERENCES ${C.USERS}(id),
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        INTEGER REFERENCES ${C.USERS}(id),
      deleted_at        TIMESTAMP,
      created_by        INTEGER REFERENCES ${C.USERS}(id),
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        INTEGER REFERENCES ${C.USERS}(id),
      updated_at        TIMESTAMP
    );
  `);

  await patchTableSchema(dbQuery, T.QC_HOLD_MATERIAL, {
    columns: [
      patchCol("packing_number", "VARCHAR(128)"),
      patchCol("item_dcode", "INTEGER"),
      patchCol("status", "VARCHAR(20) DEFAULT 'pending'"),
      patchCol("reason", "TEXT"),
      patchCol("remarks", "TEXT"),
      patchCol("hold_data", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_qc_hold_material_packing ON ${T.QC_HOLD_MATERIAL}(packing_number) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS idx_qc_hold_material_status ON ${T.QC_HOLD_MATERIAL}(status) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS idx_qc_hold_material_hold_data ON ${T.QC_HOLD_MATERIAL} USING gin (hold_data)`,
    ],
  });
}
