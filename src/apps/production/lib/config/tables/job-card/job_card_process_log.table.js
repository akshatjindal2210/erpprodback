import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/**
 * Process / machine status history for Maintain Job Card.
 * job_card_id = prod_job_card.docno (internal PK, not ERP jobcardno).
 * process_id = eng_process_master.proccode · machine_id = eng_machine_master.maccode (nullable).
 */
export async function createJobCardProcessLogTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.JOB_CARD_PROCESS_LOG} (
      id            SERIAL PRIMARY KEY,
      job_card_id   INTEGER NOT NULL REFERENCES ${T.JOB_CARD}(docno) ON DELETE CASCADE,
      process_id    INTEGER NOT NULL,
      machine_id    INTEGER,
      status        VARCHAR(20) NOT NULL,
      changed_by    VARCHAR(100),
      changed_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      remark        VARCHAR(500)
    );
    CREATE INDEX IF NOT EXISTS prod_jc_process_log_jc_idx ON ${T.JOB_CARD_PROCESS_LOG} (job_card_id, changed_at DESC);
    CREATE INDEX IF NOT EXISTS prod_jc_process_log_process_idx ON ${T.JOB_CARD_PROCESS_LOG} (process_id);
    CREATE INDEX IF NOT EXISTS prod_jc_process_log_machine_idx ON ${T.JOB_CARD_PROCESS_LOG} (machine_id);
  `);

  await dbQuery(`
    DELETE FROM ${T.JOB_CARD_PROCESS_LOG} l
    WHERE NOT EXISTS (SELECT 1 FROM ${T.JOB_CARD} j WHERE j.docno = l.job_card_id)
  `);

  await dbQuery(`
    DO $$ BEGIN
      ALTER TABLE ${T.JOB_CARD_PROCESS_LOG}
        ADD CONSTRAINT prod_jc_process_log_jc_fk
        FOREIGN KEY (job_card_id) REFERENCES ${T.JOB_CARD}(docno) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$
  `);
}
