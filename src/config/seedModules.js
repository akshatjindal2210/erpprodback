import dbQuery from "./db.js";
import { MST_TABLES as M } from "./dbTables.js";

/** Upsert rows into `mst_modules` (used by core seed). */
export async function upsertModuleRows(rows) {
  for (const mod of rows) {
    const updated = await dbQuery(
      `UPDATE ${M.MODULES}
       SET label = $2, sort_order = $3, app_type = $4
       WHERE name = $1
       RETURNING id`,
      [mod.name, mod.label, mod.sort_order, mod.app_type]
    );

    if (!updated?.length) {
      await dbQuery(
        `INSERT INTO ${M.MODULES} (name, label, sort_order, app_type)
         VALUES ($1, $2, $3, $4)`,
        [mod.name, mod.label, mod.sort_order, mod.app_type]
      );
    }
  }
}
