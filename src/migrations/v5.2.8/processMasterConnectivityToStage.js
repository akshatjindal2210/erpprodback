/**
 * eng_process_master: stage → int (1 START · 2 MID · 3 END · 4 CONNECTIVITY), drop connectivity.
 * Idempotent — v5.2.8 boot.
 */
import dbQuery from "../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../config/db/dbTables.js";
import { columnExists, dropColumnIfExists } from "../../config/db/ensureDbColumns.js";

const TABLE = T.PROCESS_MASTER;

export default async function up() {
  const tables = await dbQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'eng_process_master' LIMIT 1`,
  );
  if (!tables?.length) return;

  const [col] = await dbQuery(
    `SELECT udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'eng_process_master' AND column_name = 'stage' LIMIT 1`,
  );
  const isInt = ["int2", "int4", "int8"].includes(String(col?.udt_name || "").toLowerCase());
  const hasConnectivity = await columnExists(dbQuery, TABLE, "connectivity");

  if (!isInt) {
    if (hasConnectivity) {
      await dbQuery(`UPDATE ${TABLE} SET stage = '4' WHERE connectivity = true`);
    }
    await dbQuery(`
      UPDATE ${TABLE} SET stage = CASE upper(trim(stage::text))
        WHEN 'START' THEN '1' WHEN '1' THEN '1'
        WHEN 'END' THEN '3' WHEN '3' THEN '3'
        WHEN 'CONNECTIVITY' THEN '4' WHEN '4' THEN '4'
        ELSE '2'
      END
    `);
    await dbQuery(`ALTER TABLE ${TABLE} ALTER COLUMN stage DROP DEFAULT`);
    await dbQuery(`ALTER TABLE ${TABLE} ALTER COLUMN stage TYPE INTEGER USING trim(stage::text)::integer`);
    await dbQuery(`ALTER TABLE ${TABLE} ALTER COLUMN stage SET DEFAULT 2`);
    await dbQuery(`ALTER TABLE ${TABLE} ALTER COLUMN stage SET NOT NULL`);
  } else if (hasConnectivity) {
    await dbQuery(`UPDATE ${TABLE} SET stage = 4 WHERE connectivity = true`);
  }

  await dropColumnIfExists(dbQuery, TABLE, "connectivity");
  console.log("[migration] processMasterConnectivityToStage: stage int 1–4; connectivity dropped");
}
