import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";

/**
 * Maintain Job Card — one row per PRIME ITEM, created from its approved shortage entries.
 *   docno        primary key (running number, see modules/job-card/jobCard.config.js)
 *   job_card_no  JC_PREFIX + docno padded (jobCardNo())
 *   qty          total of all items · items = [{ itemdcode, qty }] item-wise
 *   shortage_ids ims_shortage rows used by this card (the only link — "already used" = id in an active card)
 *   process_plan [{ stage_no, process_id, process_name, machines: [{ machine_id, machine_name }], rm_items: [{ rm_item_dcode, rm_item_code }] }]
 *   approved     false = Pending → Approve → true = Authorized
 */
export async function createJobCardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.JOB_CARD} (
      docno             INTEGER PRIMARY KEY,
      job_card_no       VARCHAR(30) NOT NULL UNIQUE,
      job_date          DATE NOT NULL DEFAULT CURRENT_DATE,
      prime_item_dcode  INTEGER NOT NULL,
      qty               INTEGER NOT NULL CHECK (qty > 0),
      items             JSONB NOT NULL DEFAULT '[]'::jsonb,
      shortage_ids      INTEGER[] NOT NULL DEFAULT '{}',
      process_plan      JSONB NOT NULL DEFAULT '[]'::jsonb,
      status            VARCHAR(20) NOT NULL DEFAULT 'Open',
      remarks           TEXT,
      approved          BOOLEAN NOT NULL DEFAULT false,
      approved_by       TEXT,
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        TEXT,
      deleted_at        TIMESTAMP,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS prod_job_card_prime_idx ON ${T.JOB_CARD} (prime_item_dcode) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS prod_job_card_shortage_ids_idx ON ${T.JOB_CARD} USING GIN (shortage_ids) WHERE is_deleted = false;
  `);
}
