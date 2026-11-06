import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/** prod_entry — docdt = entry date; shift_start/end = run datetime. */
export async function createProdEntryTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ENTRY} (
      docno          SERIAL PRIMARY KEY,
      docdt          DATE NOT NULL,
      dept           SMALLINT NOT NULL DEFAULT 0,
      jc             VARCHAR(30),
      itemdcode      INTEGER,
      shift          SMALLINT NOT NULL,
      shift_start    TIMESTAMP,
      shift_end      TIMESTAMP,
      run_proc       INTEGER,
      next_proc      INTEGER,
      operator_id    VARCHAR(200),
      operator       TEXT,
      qc_person_id   VARCHAR(50),
      qc_person      VARCHAR(100),
      machine        INTEGER NOT NULL,
      cavity         VARCHAR(50),
      cycle          INTEGER,
      target_qty     NUMERIC(12,2) DEFAULT 0,
      prd_qty        NUMERIC(12,2) DEFAULT 0,
      loose_qty      NUMERIC(12,2) DEFAULT 0,
      rej_qty        NUMERIC(12,2) DEFAULT 0,
      ok_qty         NUMERIC(12,2) DEFAULT 0,
      bin            VARCHAR(50),
      remark         TEXT,
      is_deleted     BOOLEAN DEFAULT false,
      created_by     TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_by     TEXT,
      updated_at     TIMESTAMP,
      approved_by    TEXT,
      approved_at    TIMESTAMP,
      deleted_by     TEXT,
      deleted_at     TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS prod_entry_docdt_idx ON ${T.ENTRY} (docdt);
  `);
}
