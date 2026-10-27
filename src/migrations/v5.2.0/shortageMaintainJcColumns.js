/**
 * ims_shortage — Maintain JC: is_accepted, accepted_remark, docno; drop legacy duplicate columns.
 * Idempotent (safe on every 5.2.0 boot). Rollback: export `down` (manual).
 */
import dbQuery from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import { columnExists, dropColumnsIfExist, patchCol, patchTableSchema, renameColumnIfExists, runIfColumnExists } from "../../config/db/ensureDbColumns.js";

const TABLE = T.SHORTAGE;

async function mergeLegacyIntoCanonical() {
  if (await columnExists(dbQuery, TABLE, "docno")) {
    for (const col of ["mjc_docno", "maintain_jc_docno"]) {
      await runIfColumnExists(dbQuery, TABLE, col, () =>
        dbQuery(`UPDATE ${TABLE} SET docno = ${col} WHERE docno IS NULL AND ${col} IS NOT NULL`)
      );
    }
  }
  await runIfColumnExists(dbQuery, TABLE, "is_approved", () =>
    dbQuery(
      `UPDATE ${TABLE} SET is_accepted = is_approved
       WHERE is_accepted IS NULL AND is_approved IS NOT NULL`
    )
  );
  for (const col of ["decision_remark", "approval_remark"]) {
    await runIfColumnExists(dbQuery, TABLE, col, () =>
      dbQuery(
        `UPDATE ${TABLE} SET accepted_remark = ${col}
         WHERE (accepted_remark IS NULL OR TRIM(accepted_remark) = '')
           AND ${col} IS NOT NULL AND TRIM(${col}) <> ''`
      )
    );
  }
}

export default async function up() {
  await renameColumnIfExists(dbQuery, TABLE, "maintain_jc_docno", "mjc_docno");
  await renameColumnIfExists(dbQuery, TABLE, "mjc_docno", "docno");
  await renameColumnIfExists(dbQuery, TABLE, "is_approved", "is_accepted");
  await renameColumnIfExists(dbQuery, TABLE, "approval_remark", "decision_remark");
  await renameColumnIfExists(dbQuery, TABLE, "decision_remark", "accepted_remark");

  await patchTableSchema(dbQuery, TABLE, {
    columns: [
      patchCol("is_accepted", "BOOLEAN"),
      patchCol("accepted_remark", "TEXT"),
      patchCol("docno", "INTEGER"),
    ],
  });

  await mergeLegacyIntoCanonical();

  await dropColumnsIfExist(dbQuery, TABLE, [
    "maintain_jc_docno",
    "mjc_docno",
    "decision_remark",
    "approval_remark",
    "is_approved",
  ]);

  await dbQuery(`DROP INDEX IF EXISTS idx_shortage_is_approved`);
  await dbQuery(`DROP INDEX IF EXISTS idx_shortage_maintain_jc_docno`);
  await dbQuery(`DROP INDEX IF EXISTS idx_shortage_mjc_docno`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS idx_shortage_is_accepted ON ${TABLE}(is_accepted) WHERE is_deleted = false`
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS idx_shortage_docno ON ${TABLE}(docno) WHERE is_deleted = false AND docno IS NOT NULL`
  );
}

export async function down() {
  await dbQuery(`DROP INDEX IF EXISTS idx_shortage_docno`);
  await dbQuery(`DROP INDEX IF EXISTS idx_shortage_is_accepted`);
}
