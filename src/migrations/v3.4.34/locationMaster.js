import dbQuery from "../../config/db/db.js";
import { columnExists, dropColumnIfExists, renameColumnIfExists } from "../../config/db/ensureDbColumns.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";

async function exists(name) {
  const [r] = await dbQuery(`SELECT to_regclass($1) AS t`, [name]);
  return Boolean(r?.t);
}

async function hasCol(table, col) {
  const [r] = await dbQuery(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table.replace(/^public\./, ""), col],
  );
  return Boolean(r);
}

/** Shared master: rename draft col, normalize type/rule, singles → arrays, drop singles. */
async function cleanupSharedLocationMaster() {
  if (!(await exists(T.LOCATION_MASTER))) return;

  await renameColumnIfExists(dbQuery, T.LOCATION_MASTER, "restriction_mode", "rule");

  await dbQuery(`
    UPDATE ${T.LOCATION_MASTER}
      SET rule = 'include'
      WHERE rule IS NULL
         OR trim(rule) = ''
         OR lower(trim(rule)) NOT IN ('include', 'exclude');
    UPDATE ${T.LOCATION_MASTER}
      SET type = 'ims'
      WHERE type IS NULL OR trim(type) = '' OR lower(trim(type)) IN ('y', 'ims');
    UPDATE ${T.LOCATION_MASTER}
      SET type = 'rmstore'
      WHERE lower(trim(type)) IN ('r', 'rm', 'rmstore');
  `);

  if (await columnExists(dbQuery, T.LOCATION_MASTER, "acc_code")) {
    await dbQuery(`
      UPDATE ${T.LOCATION_MASTER}
        SET acc_codes = ARRAY[acc_code]
        WHERE acc_code IS NOT NULL
          AND (acc_codes IS NULL OR cardinality(acc_codes) = 0)
    `);
    await dropColumnIfExists(dbQuery, T.LOCATION_MASTER, "acc_code");
  }

  if (await columnExists(dbQuery, T.LOCATION_MASTER, "item_dcode")) {
    await dbQuery(`
      UPDATE ${T.LOCATION_MASTER}
        SET item_dcodes = ARRAY[item_dcode]
        WHERE item_dcode IS NOT NULL
          AND (item_dcodes IS NULL OR cardinality(item_dcodes) = 0)
    `);
    await dropColumnIfExists(dbQuery, T.LOCATION_MASTER, "item_dcode");
  }
}

async function migrateFromLegacy(source) {
  const shelf = (await hasCol(source, "shelf_no"))
    ? (await hasCol(source, "row_no") ? "COALESCE(l.shelf_no, l.row_no)" : "l.shelf_no")
    : (await hasCol(source, "row_no") ? "l.row_no" : "NULL");
  const del = (await hasCol(source, "is_deleted")) ? "COALESCE(l.is_deleted, false) = false" : "true";
  const hasAcc = await hasCol(source, "acc_code");
  const hasItem = await hasCol(source, "item_dcode");
  const hasDesc = await hasCol(source, "location_description");
  const hasCap = await hasCol(source, "total_capacity");
  const hasCreated = await hasCol(source, "created_at");

  const accExpr = hasAcc
    ? `CASE WHEN l.acc_code IS NULL THEN '{}'::int[] ELSE ARRAY[l.acc_code]::int[] END`
    : `'{}'::int[]`;
  const itemExpr = hasItem
    ? `CASE WHEN l.item_dcode IS NULL THEN '{}'::int[] ELSE ARRAY[l.item_dcode]::int[] END`
    : `'{}'::int[]`;

  await dbQuery(`
    INSERT INTO ims_location_master (rack_no, shelf_no, location_no, type, location_description, total_capacity, acc_codes, item_dcodes, created_at)
    SELECT
      NULLIF(trim(l.rack_no), ''),
      UPPER(NULLIF(trim(${shelf}), '')),
      UPPER(NULLIF(trim(l.location_no), '')),
      'rmstore',
      ${hasDesc ? "l.location_description" : "NULL"},
      ${hasCap ? "l.total_capacity" : "NULL"},
      ${accExpr},
      ${itemExpr},
      ${hasCreated ? "COALESCE(l.created_at, NOW())" : "NOW()"}
    FROM ${source} l
    WHERE ${del}
      AND NOT EXISTS (
        SELECT 1 FROM ims_location_master m
        WHERE m.is_deleted = false
          AND lower(trim(COALESCE(m.type, ''))) = 'rmstore'
          AND (
            UPPER(NULLIF(trim(m.location_no), '')) = UPPER(NULLIF(trim(l.location_no), ''))
            OR (
              NULLIF(trim(m.rack_no), '') = NULLIF(trim(l.rack_no), '')
              AND UPPER(NULLIF(trim(COALESCE(m.shelf_no, '')), '')) = UPPER(NULLIF(trim(${shelf}), ''))
            )
          )
      )
  `);

  if (!(await exists("rmstore_coil_table")) || !(await hasCol(source, "location_id"))) return;

  await dbQuery(`ALTER TABLE rmstore_coil_table DROP CONSTRAINT IF EXISTS rmstore_coil_table_location_id_fkey`);

  await dbQuery(`
    UPDATE rmstore_coil_table c
    SET location_id = m.location_id
    FROM ${source} l
    JOIN ims_location_master m
      ON m.is_deleted = false
     AND lower(trim(COALESCE(m.type, ''))) = 'rmstore'
     AND (
       UPPER(NULLIF(trim(m.location_no), '')) = UPPER(NULLIF(trim(l.location_no), ''))
       OR (
         NULLIF(trim(m.rack_no), '') = NULLIF(trim(l.rack_no), '')
         AND UPPER(NULLIF(trim(COALESCE(m.shelf_no, '')), '')) =
             UPPER(NULLIF(trim(${shelf}), ''))
       )
     )
    WHERE c.is_deleted = false
      AND c.location_id = l.location_id
      AND c.location_id IS DISTINCT FROM m.location_id
      AND (${del})
  `);
}

async function migrateLegacyRmstoreTables() {
  if (!(await exists("ims_location_master"))) return;

  const sources = [];
  if (await exists("coil_location")) sources.push("coil_location");
  if (await exists("rmstore_master_location")) sources.push("rmstore_master_location");

  if (!sources.length) {
    await dbQuery(`DROP TABLE IF EXISTS coil_location CASCADE`);
    await dbQuery(`DROP TABLE IF EXISTS rmstore_master_location CASCADE`);
    return;
  }

  for (const source of sources) {
    await migrateFromLegacy(source);
  }

  if (await exists("rmstore_coil_table")) {
    await dbQuery(`ALTER TABLE rmstore_coil_table DROP CONSTRAINT IF EXISTS rmstore_coil_table_location_id_fkey`);
    await dbQuery(
      `ALTER TABLE rmstore_coil_table
       ADD CONSTRAINT rmstore_coil_table_location_id_fkey
       FOREIGN KEY (location_id) REFERENCES ims_location_master(location_id) NOT VALID`,
    );
  }

  await dbQuery(`DROP TABLE IF EXISTS coil_location CASCADE`);
  await dbQuery(`DROP TABLE IF EXISTS rmstore_master_location CASCADE`);
  console.info(`[migration:v3.4.34] location master — migrated from [${sources.join(", ")}]`);
}

/** See README.md in this folder. Idempotent while call is ON in initDB. */
export default async function migrateLocationMasterV3434() {
  try {
    await cleanupSharedLocationMaster();
    await migrateLegacyRmstoreTables();
  } catch (err) {
    console.warn("[migration:v3.4.34] location master failed (legacy kept if any):", err.message);
  }
}
