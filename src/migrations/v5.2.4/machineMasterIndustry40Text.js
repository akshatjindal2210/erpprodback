/** eng_machine_master — industry_4_0 as comma-separated names (TEXT). Converts legacy boolean → ''. */
import dbQuery from "../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../config/db/dbTables.js";
import { columnExists, ensureColumns } from "../../config/db/ensureDbColumns.js";

export default async function up() {
  const table = T.MACHINE_MASTER;
  if (!(await columnExists(dbQuery, table, "industry_4_0"))) {
    await ensureColumns(dbQuery, table, [
      { name: "industry_4_0", addSql: "industry_4_0 TEXT NOT NULL DEFAULT ''" },
    ]);
    return;
  }
  const [col] = await dbQuery(
    `SELECT udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'eng_machine_master' AND column_name = 'industry_4_0'`
  );
  if (col?.udt_name === "bool") {
    await dbQuery(`ALTER TABLE ${table} ALTER COLUMN industry_4_0 DROP DEFAULT`);
    await dbQuery(`ALTER TABLE ${table} ALTER COLUMN industry_4_0 TYPE TEXT USING ''`);
    await dbQuery(`ALTER TABLE ${table} ALTER COLUMN industry_4_0 SET DEFAULT ''`);
    await dbQuery(`ALTER TABLE ${table} ALTER COLUMN industry_4_0 SET NOT NULL`);
  }
}
