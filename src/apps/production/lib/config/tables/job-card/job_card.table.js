import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, columnExists, dropColumnIfExists, dropIndexesIfExist, ensureUniqueIndex, patchCol, patchTableSchema, renameColumnIfExists } from "../../../../../../config/db/ensureDbColumns.js";
import { parseProcessPlan, statusMapFromInput, withPlanStatuses } from "../../../../modules/job-card/processPlanStatus.js";

/**
 * Maintain Job Card — one row per PRIME ITEM.
 *   process_plan JSONB machine status: pending | planning | running | hold | complete.
 *   No separate process_status column.
 */
export async function createJobCardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.JC} (
      docno              INTEGER PRIMARY KEY,
      pjobcardno         VARCHAR(30) UNIQUE,
      jobcarddt          DATE NOT NULL DEFAULT CURRENT_DATE,
      schedule_shift     SMALLINT NOT NULL DEFAULT 1,
      type               SMALLINT NOT NULL DEFAULT 0,
      itemdcode          INTEGER NOT NULL,
      process_plan       JSONB NOT NULL DEFAULT '[]'::jsonb,
      status             VARCHAR(20) NOT NULL DEFAULT 'Pending',
      remarks            TEXT,
      jobcardno          INTEGER,
      jcseriescode       INTEGER NOT NULL DEFAULT 30,
      fyid               INTEGER,
      planqty            NUMERIC,
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

  await applyTablePatches(dbQuery, T.JC, {
    renameColumns: [
      { from: "job_card_no", to: "pjobcardno" },
      { from: "job_date", to: "pldt" },
      { from: "prime_item_dcode", to: "itemdcode" },
      { from: "tooling_approved_by", to: "tooling_by" },
      { from: "tooling_approved_at", to: "tooling_at" },
    ],
  });

  // Pure rename — keep data (legacy pldt → jobcarddt)
  await renameColumnIfExists(dbQuery, T.JC, "pldt", "jobcarddt");
  await dropIndexesIfExist(dbQuery, ["prod_job_card_pldt_shift_idx"]);

  await patchTableSchema(dbQuery, T.JC, {
    columns: [
      patchCol("pjobcardno", "VARCHAR(30)"),
      patchCol("jobcarddt", "DATE NOT NULL DEFAULT CURRENT_DATE"),
      patchCol("schedule_shift", "SMALLINT NOT NULL DEFAULT 1"),
      patchCol("type", "SMALLINT NOT NULL DEFAULT 0"),
      patchCol("itemdcode", "INTEGER"),
      patchCol("process_plan", "JSONB NOT NULL DEFAULT '[]'::jsonb"),
      patchCol("status", "VARCHAR(20) NOT NULL DEFAULT 'Pending'"),
      patchCol("remarks", "TEXT"),
      patchCol("jobcardno", "INTEGER"),
      patchCol("jcseriescode", "INTEGER NOT NULL DEFAULT 30"),
      patchCol("fyid", "INTEGER"),
      patchCol("planqty", "NUMERIC"),
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
    nullable: ["pjobcardno"],
    indexes: [
      `CREATE INDEX IF NOT EXISTS prod_job_card_prime_idx ON ${T.JC} (itemdcode) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_tooling_approved_idx ON ${T.JC} (tooling_approved) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_type_idx ON ${T.JC} (type) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS prod_job_card_jobcarddt_shift_idx ON ${T.JC} (jobcarddt, schedule_shift) WHERE is_deleted = false`,
    ],
  });

  await ensureUniqueIndex(
    dbQuery,
    T.JC,
    "prod_job_card_erp_no_uq",
    "jcseriescode, fyid, jobcardno",
    "jobcardno IS NOT NULL AND fyid IS NOT NULL"
  );

  await applyTablePatches(dbQuery, T.JC, {
    dropColumns: ["qty", "items", "shortage_approved", "shortage_remark", "shortage_ids"],
  });
  await dropIndexesIfExist(dbQuery, ["prod_job_card_shortage_ids_idx"]);

  await dbQuery(
    `UPDATE ${T.JC} SET pjobcardno = NULL
     WHERE jobcardno IS NULL AND pjobcardno LIKE 'DRA-%' AND COALESCE(is_deleted, false) = false`
  );

  await migrateProcessPlanStatuses();
}

/** Merge legacy process_status into process_plan[].status, default pending, then drop column. */
async function migrateProcessPlanStatuses() {
  const hasLegacy = await columnExists(dbQuery, T.JC, "process_status");
  const cols = hasLegacy ? "docno, process_plan, process_status" : "docno, process_plan";
  const rows = await dbQuery(`SELECT ${cols} FROM ${T.JC}`);

  for (const row of rows) {
    const plan = parseProcessPlan(row.process_plan);
    if (!plan.length) continue;
    const legacyMap = hasLegacy ? statusMapFromInput(row.process_status) : new Map();
    const merged = withPlanStatuses(plan, plan, legacyMap.size ? legacyMap : null);
    const after = JSON.stringify(merged);
    // Rewrite when status keys were missing or legacy process_status was merged in
    if (JSON.stringify(row.process_plan ?? []) === after) continue;
    await dbQuery(`UPDATE ${T.JC} SET process_plan = $2::jsonb WHERE docno = $1`, [row.docno, after]);
  }

  if (hasLegacy) await dropColumnIfExists(dbQuery, T.JC, "process_status");
}
