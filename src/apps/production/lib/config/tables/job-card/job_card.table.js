import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * Maintain Job Card — one row per PRIME ITEM.
 *   type: 0 = jc (default) | 1 = 2c | …
 *   pjobcardno / pldt / itemdcode
 *   tooling_approved / tooling_remark / tooling_by / tooling_at
 *   status: Pending | Planning | Running | Hold | Complete
 *   schedule_shift: 1 | 2 | 3 (calendar / day-wise production)
 */
export async function createJobCardTable() {
  // Table only — no indexes on columns that may still need rename on existing DBs
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.JOB_CARD} (
      docno              INTEGER PRIMARY KEY,
      pjobcardno         VARCHAR(30) NOT NULL UNIQUE,
      pldt               DATE NOT NULL DEFAULT CURRENT_DATE,
      schedule_shift     SMALLINT NOT NULL DEFAULT 1,
      type               SMALLINT NOT NULL DEFAULT 0,
      itemdcode          INTEGER NOT NULL,
      shortage_ids       INTEGER[] NOT NULL DEFAULT '{}',
      process_plan       JSONB NOT NULL DEFAULT '[]'::jsonb,
      status             VARCHAR(20) NOT NULL DEFAULT 'Pending',
      remarks            TEXT,
      approved           BOOLEAN NOT NULL DEFAULT false,
      approved_by        TEXT,
      approved_at        TIMESTAMP,
      tooling_approved   BOOLEAN,
      tooling_remark     TEXT,
      tooling_by         TEXT,
      tooling_at         TIMESTAMP,
      is_deleted         BOOLEAN DEFAULT false,
      deleted_by         TEXT,
      deleted_at         TIMESTAMP,
      created_by         TEXT,
      created_at         TIMESTAMP DEFAULT NOW(),
      updated_by         TEXT,
      updated_at         TIMESTAMP
    );
  `);

  // Existing DBs: rename old labels → new (before any index that uses them)
  await applyTablePatches(dbQuery, T.JOB_CARD, {
    renameColumns: [
      { from: "job_card_no", to: "pjobcardno" },
      { from: "job_date", to: "pldt" },
      { from: "prime_item_dcode", to: "itemdcode" },
      { from: "tooling_approved_by", to: "tooling_by" },
      { from: "tooling_approved_at", to: "tooling_at" },
    ],
  });

  await patchTableSchema(dbQuery, T.JOB_CARD, {
    columns: [
      patchCol("pjobcardno", "VARCHAR(30)"),
      patchCol("pldt", "DATE NOT NULL DEFAULT CURRENT_DATE"),
      patchCol("schedule_shift", "SMALLINT NOT NULL DEFAULT 1"),
      patchCol("type", "SMALLINT NOT NULL DEFAULT 0"),
      patchCol("itemdcode", "INTEGER"),
      patchCol("shortage_ids", "INTEGER[] NOT NULL DEFAULT '{}'"),
      patchCol("process_plan", "JSONB NOT NULL DEFAULT '[]'::jsonb"),
      patchCol("status", "VARCHAR(20) NOT NULL DEFAULT 'Pending'"),
      patchCol("remarks", "TEXT"),
      patchCol("approved", "BOOLEAN NOT NULL DEFAULT false"),
      patchCol("approved_by", "TEXT"),
      patchCol("approved_at", "TIMESTAMP"),
      patchCol("tooling_approved", "BOOLEAN"),
      patchCol("tooling_remark", "TEXT"),
      patchCol("tooling_by", "TEXT"),
      patchCol("tooling_at", "TIMESTAMP"),
      patchCol("is_deleted", "BOOLEAN DEFAULT false"),
      patchCol("deleted_by", "TEXT"),
      patchCol("deleted_at", "TIMESTAMP"),
      patchCol("created_by", "TEXT"),
      patchCol("created_at", "TIMESTAMP DEFAULT NOW()"),
      patchCol("updated_by", "TEXT"),
      patchCol("updated_at", "TIMESTAMP"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS prod_job_card_prime_idx ON ${T.JOB_CARD} (itemdcode) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_shortage_ids_idx ON ${T.JOB_CARD} USING GIN (shortage_ids) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_tooling_approved_idx ON ${T.JOB_CARD} (tooling_approved) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_type_idx ON ${T.JOB_CARD} (type) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_pldt_shift_idx ON ${T.JOB_CARD} (pldt, schedule_shift) WHERE is_deleted = false`,
    ],
  });

  await applyTablePatches(dbQuery, T.JOB_CARD, {
    dropColumns: ["qty", "items", "shortage_approved", "shortage_remark"],
  });
}
