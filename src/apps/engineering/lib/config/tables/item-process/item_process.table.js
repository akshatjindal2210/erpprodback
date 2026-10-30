import dbQuery from "../../../../../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { dropColumnIfExists, ensureColumns } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * Item process — Prime / FG process plan of an item (one row = one plan). Engineering only — no Item RM (rmstore) link.
 *
 *   type 1 = PRIME → item_dcode = the prime item (HN006)
 *   type 2 = FG    → item_dcode = the FG item (HN006, HN006TW, HN006Y — each its own row)
 *   An FG finds its prime by item: IMS primitemdcode of the FG item → the type 1 row of that item.
 *
 *   process = ids only (names come live from Process / Machine Master, RM codes from IMS).
 *             JSON (not JSONB) so keys keep their order:
 *     { "type": "prime", "connecting": 12,
 *       "stages": [ { "stage": 1, "processes": [ { "process": 1, "machines": [1, 2], "rm": [1451] } ] } ] }
 *     { "type": "fg",
 *       "stages": [ { "stage": 1, "processes": [ { "process": 12, "machines": [20], "rm": [] } ] } ] }
 */
export async function createItemProcessTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ITEM_PROCESS} (
      id          SERIAL PRIMARY KEY,
      type        SMALLINT NOT NULL,      -- 1 prime · 2 fg
      item_dcode  INTEGER NOT NULL,       -- the item of this plan (prime or fg)
      process     JSON NOT NULL,          -- { type, stages, connecting? }
      is_deleted  BOOLEAN DEFAULT false,
      deleted_by  TEXT,
      deleted_at  TIMESTAMP,
      created_by  TEXT,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_by  TEXT,
      updated_at  TIMESTAMP,
      is_approved BOOLEAN NOT NULL DEFAULT false,
      approved_by TEXT,
      approved_at TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS eng_item_process_type_item_unique_active
      ON ${T.ITEM_PROCESS} (type, item_dcode) WHERE is_deleted = false;     -- one active plan per (type, item)
  `);

  await dropColumnIfExists(dbQuery, T.ITEM_PROCESS, "connecting_process_id");
  await ensureColumns(dbQuery, T.ITEM_PROCESS, [
    { name: "is_approved", addSql: "is_approved BOOLEAN NOT NULL DEFAULT false" },
    { name: "approved_by", addSql: "approved_by TEXT" },
    { name: "approved_at", addSql: "approved_at TIMESTAMP" },
  ]);
}
