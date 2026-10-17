import dbQuery from "../../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { applyTablePatches, renameTableIfExists } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * Production shortage tooling Yes/No (`prod_shortage`).
 * After ims shortage approve → approved NULL (pending), then true / false.
 *
 * Legacy tables/columns renamed on boot.
 */
export async function createShortageTable() {
  await renameTableIfExists(dbQuery, "prod_prime_tooling", T.SHORTAGE);
  await renameTableIfExists(dbQuery, "prod_shortage_tooling", T.SHORTAGE);
  await renameTableIfExists(dbQuery, "prod_tooling", T.SHORTAGE);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.SHORTAGE} (
      id         SERIAL PRIMARY KEY,
      item_dcode INTEGER NOT NULL UNIQUE,
      approved   BOOLEAN,
      remark     TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT,
      updated_at TIMESTAMP
    );
  `);

  await applyTablePatches(dbQuery, T.SHORTAGE, {
    renameColumns: [
      { from: "prime_item_dcode", to: "item_dcode" },
      { from: "prime_dcode", to: "item_dcode" },
      { from: "is_approved", to: "approved" },
    ],
  });
}
