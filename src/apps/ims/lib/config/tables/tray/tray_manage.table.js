import dbQuery from "../../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/** Light register: type + packing_number + link_count + data.links only (item via join). */
export async function createTrayManageTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.TRAY_MANAGE} (
      id               SERIAL PRIMARY KEY,
      type             TEXT NOT NULL DEFAULT 'assign',
      packing_number   TEXT,
      link_count       INTEGER NOT NULL DEFAULT 0,
      data             JSONB NOT NULL DEFAULT '{"links":[]}'::jsonb,
      remark           TEXT,
      approved         BOOLEAN NOT NULL DEFAULT true,
      approved_by      TEXT,
      approved_at      TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       TEXT,
      updated_at       TIMESTAMP,
      is_deleted       BOOLEAN NOT NULL DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP
    );
  `);

  await patchTableSchema(dbQuery, T.TRAY_MANAGE, {
    columns: [
      patchCol("type", "TEXT NOT NULL DEFAULT 'assign'"),
      patchCol("packing_number", "TEXT"),
      patchCol("link_count", "INTEGER NOT NULL DEFAULT 0"),
      patchCol("data", `JSONB NOT NULL DEFAULT '{"links":[]}'::jsonb`),
      patchCol("remark", "TEXT"),
      patchCol("approved", "BOOLEAN NOT NULL DEFAULT true"),
      patchCol("approved_by", "TEXT"),
      patchCol("approved_at", "TIMESTAMP"),
      patchCol("created_by", "TEXT"),
      patchCol("created_at", "TIMESTAMP DEFAULT NOW()"),
      patchCol("updated_by", "TEXT"),
      patchCol("updated_at", "TIMESTAMP"),
      patchCol("is_deleted", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("deleted_by", "TEXT"),
      patchCol("deleted_at", "TIMESTAMP"),
    ],
    columnTypes: [{ name: "type", type: "text" }],
    indexes: [
      `CREATE INDEX IF NOT EXISTS tray_manage_created_at_idx ON ${T.TRAY_MANAGE} (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS tray_manage_packing_idx ON ${T.TRAY_MANAGE} (packing_number, id DESC) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS tray_manage_type_idx ON ${T.TRAY_MANAGE} (type) WHERE is_deleted = false`,
    ],
  });
}
