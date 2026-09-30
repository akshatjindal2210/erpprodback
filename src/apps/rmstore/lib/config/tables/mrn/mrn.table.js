import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, columnExists, dropColumnsIfExist, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * MRN — lean schema:
 *   qty / coil_no (renamed from it_recp_qty / it_lot_no)
 *   fyid kept
 *   create + generate audit only
 *   TC/RMTC paths only (no file names)
 *   one sticker_status + sticker_by + sticker_at for draft / generate / approved / reject
 *   serial_no dropped (derive from uid when needed)
 */
export async function createRmStoreMrnTable() {
  // CREATE only — never CREATE INDEX here (old DBs skip CREATE but still run following stmts).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.MRN} (
      uid                      VARCHAR(100) PRIMARY KEY,
      mrn_no                   INTEGER,
      mrn_dt                   TIMESTAMP,
      bill_no                  VARCHAR(100),
      bill_dt                  TIMESTAMP,
      acc_code                 INTEGER,
      acc_name                 TEXT,
      item_dcode               INTEGER,
      item_code                VARCHAR(100),
      item_desc                TEXT,
      heat_no                  VARCHAR(100),
      remarks                  TEXT,
      qty                      NUMERIC,
      coil_no                  VARCHAR(100),
      it_unit                  VARCHAR(50),
      fyid                     INTEGER,
      sticker_mode             VARCHAR(24),
      internal_create_user     VARCHAR(255),
      internal_create_date     TIMESTAMP WITH TIME ZONE,
      system_generate_user     VARCHAR(255),
      system_generate_date     TIMESTAMP WITH TIME ZONE,
      tc_file_path             TEXT,
      rmtc_file_path           TEXT,
      sticker_draft            JSONB,
      sticker_status           VARCHAR(24) DEFAULT 'pending',
      sticker_by               VARCHAR(255),
      sticker_at               TIMESTAMP WITH TIME ZONE,
      sticker_reject_uid       INTEGER
    )
  `);

  // Existing DBs: rename legacy qty/lot columns.
  await applyTablePatches(dbQuery, T.MRN, {
    renameColumns: [
      { from: "it_recp_qty", to: "qty" },
      { from: "it_lot_no", to: "coil_no" },
    ],
  });

  // Add new columns before any index/migrate that references them.
  await patchTableSchema(dbQuery, T.MRN, {
    columns: [
      patchCol("fyid", "INTEGER"),
      patchCol("sticker_status", "VARCHAR(24) DEFAULT 'pending'"),
      patchCol("sticker_by", "VARCHAR(255)"),
      patchCol("sticker_at", "TIMESTAMP WITH TIME ZONE"),
      patchCol("sticker_reject_uid", "INTEGER"),
      patchCol("qty", "NUMERIC"),
      patchCol("coil_no", "VARCHAR(100)"),
      patchCol("tc_file_path", "TEXT"),
      patchCol("rmtc_file_path", "TEXT"),
      patchCol("sticker_draft", "JSONB"),
      patchCol("sticker_mode", "VARCHAR(24)"),
      patchCol("internal_create_user", "VARCHAR(255)"),
      patchCol("internal_create_date", "TIMESTAMP WITH TIME ZONE"),
      patchCol("system_generate_user", "VARCHAR(255)"),
      patchCol("system_generate_date", "TIMESTAMP WITH TIME ZONE"),
      patchCol("heat_no", "VARCHAR(100)"),
      patchCol("remarks", "TEXT"),
    ],
  });

  // One-shot migrate old boolean/audit columns → sticker_status / by / at.
  if (
    (await columnExists(dbQuery, T.MRN, "sticker_generated")) &&
    (await columnExists(dbQuery, T.MRN, "sticker_status"))
  ) {
    try {
      await dbQuery(`
        UPDATE ${T.MRN}
        SET
          sticker_status = CASE
            WHEN COALESCE(sticker_rejected, false) = true THEN 'reject'
            WHEN COALESCE(sticker_generated, false) = true
                 AND COALESCE(sticker_approved, true) = true THEN 'approved'
            WHEN COALESCE(sticker_generated, false) = true THEN 'generate'
            WHEN sticker_draft IS NOT NULL THEN 'draft'
            ELSE COALESCE(NULLIF(TRIM(sticker_status), ''), 'pending')
          END,
          sticker_by = COALESCE(
            sticker_by,
            CASE
              WHEN COALESCE(sticker_rejected, false) = true THEN sticker_rejected_by
              WHEN COALESCE(sticker_approved, false) = true THEN sticker_approved_by
              WHEN sticker_draft IS NOT NULL THEN sticker_draft_by
              ELSE system_generate_user
            END
          ),
          sticker_at = COALESCE(
            sticker_at,
            CASE
              WHEN COALESCE(sticker_rejected, false) = true THEN sticker_rejected_at
              WHEN COALESCE(sticker_approved, false) = true THEN sticker_approved_at
              WHEN sticker_draft IS NOT NULL THEN sticker_draft_at
              ELSE system_generate_date
            END
          )
      `);
    } catch (err) {
      console.warn("[rmstore_mrn] sticker_status migrate skipped:", err?.message || err);
    }
  }

  await dropColumnsIfExist(dbQuery, T.MRN, [
    "serial_no",
    "tc_file_name",
    "rmtc_file_name",
    "sticker_generated",
    "sticker_draft_at",
    "sticker_draft_by",
    "sticker_approved",
    "sticker_approved_by",
    "sticker_approved_at",
    "sticker_rejected",
    "sticker_rejected_by",
    "sticker_rejected_at",
  ]);

  await dbQuery(`DROP INDEX IF EXISTS rmstore_mrn_sticker_generated_idx`);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS rmstore_mrn_sticker_status_idx
      ON ${T.MRN}(sticker_status)
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS rmstore_mrn_mrn_no_idx ON ${T.MRN}(mrn_no)
  `);
}
