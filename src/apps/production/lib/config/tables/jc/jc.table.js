import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** prod_jc — Maintain Job Card (one row per prime item; plan lines live in prod_plan). */
export async function createJobCardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.JC} (
      docno              INTEGER PRIMARY KEY,
      pjobcardno         VARCHAR(30) UNIQUE,
      jobcarddt          DATE NOT NULL DEFAULT CURRENT_DATE,
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
    CREATE INDEX IF NOT EXISTS prod_jc_prime_idx ON ${T.JC} (itemdcode) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS prod_jc_tooling_approved_idx ON ${T.JC} (tooling_approved) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS prod_jc_type_idx ON ${T.JC} (type) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS prod_jc_jobcarddt_idx ON ${T.JC} (jobcarddt) WHERE is_deleted = false;
    CREATE UNIQUE INDEX IF NOT EXISTS prod_jc_erp_no_uq
      ON ${T.JC} (jcseriescode, fyid, jobcardno)
      WHERE jobcardno IS NOT NULL AND fyid IS NOT NULL;
  `);
}
