/** ims_tray_master.batch_id → integer FK to ims_tray_batch.id. Idempotent. */
import dbQuery from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import {
  columnExists,
  dropColumnIfExists,
  renameColumnIfExists,
} from "../../config/db/ensureDbColumns.js";

const MASTER = T.TRAY_MASTER;
const BATCH = T.TRAY_BATCH;
const BOX = T.BOX_TABLE;
const FK = "ims_tray_master_batch_id_fkey";
const STAGING = "ims_tray_master_colorder_tmp";
const BATCH_ID_ORDINAL = 5;

async function masterTableExists() {
  const rows = await dbQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'ims_tray_master'
     LIMIT 1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function columnUdt(columnName) {
  const rows = await dbQuery(
    `SELECT udt_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ims_tray_master' AND column_name = $1
     LIMIT 1`,
    [columnName],
  );
  return String(rows?.[0]?.udt_name || rows?.[0]?.data_type || "").toLowerCase();
}

async function constraintExists(name) {
  const rows = await dbQuery(`SELECT 1 FROM pg_constraint WHERE conname = $1 LIMIT 1`, [name]);
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureBatchHeadersFromLegacyCode(legacyCol) {
  await dbQuery(`
    INSERT INTO ${BATCH} (batch_id, approved, created_at)
    SELECT DISTINCT TRIM(t.${legacyCol}), false, NOW()
    FROM ${MASTER} t
    WHERE NULLIF(TRIM(t.${legacyCol}), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${BATCH} b WHERE TRIM(b.batch_id) = TRIM(t.${legacyCol})
      )
  `);
}

async function backfillIntegerBatchId(legacyCol) {
  await ensureBatchHeadersFromLegacyCode(legacyCol);
  await dbQuery(`
    UPDATE ${MASTER} t
    SET batch_id = b.id
    FROM ${BATCH} b
    WHERE NULLIF(TRIM(t.${legacyCol}), '') IS NOT NULL
      AND TRIM(b.batch_id) = TRIM(t.${legacyCol})
      AND (t.batch_id IS NULL OR t.batch_id IS DISTINCT FROM b.id)
  `);
}

async function backfillIntegerBatchIdIfNeeded() {
  if (await columnExists(dbQuery, MASTER, "batch_id_code")) {
    await backfillIntegerBatchId("batch_id_code");
    return;
  }
  if (await columnExists(dbQuery, MASTER, "tray_batch_uid")) {
    const uidKind = await columnUdt("tray_batch_uid");
    if (uidKind === "varchar" || uidKind === "text" || uidKind === "bpchar") {
      await backfillIntegerBatchId("tray_batch_uid");
    }
  }
}

async function batchIdOrdinalPosition() {
  const [row] = await dbQuery(
    `SELECT ordinal_position::int AS pos
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ims_tray_master' AND column_name = 'batch_id'
     LIMIT 1`,
  );
  return Number(row?.pos) || 0;
}

async function dropLegacyTrayMasterColumns() {
  await dropColumnIfExists(dbQuery, MASTER, "batch_id_code");
  await dropColumnIfExists(dbQuery, MASTER, "tray_batch_uid");
}

async function refreshTrayMasterIndexes() {
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_serial_unique`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_category_serial_uq`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_serial_legacy_uq`);
  await dbQuery(`DROP INDEX IF EXISTS tray_master_type_letter_serial_uq`);

  const hasLetter = await columnExists(dbQuery, MASTER, "letter");
  if (hasLetter) {
    await dbQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_serial_legacy_uq
        ON ${MASTER} (type, serial_number)
        WHERE letter IS NULL OR BTRIM(letter) = ''
    `);
    await dbQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_letter_serial_uq
        ON ${MASTER} (type, letter, serial_number)
        WHERE letter IS NOT NULL AND BTRIM(letter) <> ''
    `);
  } else {
    await dbQuery(
      `CREATE UNIQUE INDEX IF NOT EXISTS tray_master_type_serial_unique ON ${MASTER} (type, serial_number)`,
    );
  }

  await dbQuery(`CREATE INDEX IF NOT EXISTS tray_master_batch_idx ON ${MASTER} (batch_id)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS tray_master_status_idx ON ${MASTER} (status)`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS idx_tray_master_box_uid ON ${MASTER}(box_uid) WHERE box_uid IS NOT NULL`,
  );
}

async function repairSerialNumbersFromCode() {
  const kind = await columnUdt("serial_number");
  if (kind !== "int4" && kind !== "integer") return false;

  await dbQuery(`
    ALTER TABLE ${MASTER} ALTER COLUMN serial_number TYPE VARCHAR(10)
    USING (
      CASE
        WHEN NULLIF(TRIM(code::text), '') ~ '[0-9]+$' THEN substring(code from '[0-9]+$')
        ELSE TRIM(serial_number::text)
      END
    )
  `);
  return true;
}

async function reorderTrayMasterColumns() {
  if ((await batchIdOrdinalPosition()) === BATCH_ID_ORDINAL) return false;

  const batchKind = await columnUdt("batch_id");
  if (batchKind !== "int4" && batchKind !== "integer") {
    console.log("[migration] trayMasterBatchId: skip reorder — batch_id not integer yet");
    return false;
  }

  await dropLegacyTrayMasterColumns();

  const hasLetter = await columnExists(dbQuery, MASTER, "letter");
  const hasWeight = await columnExists(dbQuery, MASTER, "weight");
  const letterDef = hasLetter ? "      letter         VARCHAR(20),\n" : "";
  const weightDef = hasWeight ? "      weight         NUMERIC(14, 3),\n" : "";
  const letterInsert = hasLetter ? ", letter" : "";
  const weightInsert = hasWeight ? ", weight" : "";

  await dbQuery(`DROP TABLE IF EXISTS ${STAGING}`);
  await dbQuery(`
    CREATE TABLE ${STAGING} (
      id             SERIAL PRIMARY KEY,
      code           VARCHAR(100) NOT NULL UNIQUE,
      type           VARCHAR(20) NOT NULL,
      serial_number  VARCHAR(10) NOT NULL,
      batch_id       INTEGER NOT NULL REFERENCES ${BATCH}(id),
${letterDef}${weightDef}      status         VARCHAR(20) NOT NULL DEFAULT 'active',
      box_uid        INTEGER REFERENCES ${BOX}(box_uid) ON DELETE SET NULL,
      updated_by     TEXT,
      updated_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  await dbQuery(`
    INSERT INTO ${STAGING} (
      id, code, type, serial_number, batch_id${letterInsert}${weightInsert}, status, box_uid, updated_by, updated_at
    )
    SELECT
      id,
      code,
      type,
      NULLIF(TRIM(serial_number::text), '') AS serial_number,
      batch_id::int,
      ${hasLetter ? "letter," : ""}
      ${hasWeight ? "weight," : ""}
      status,
      box_uid,
      updated_by,
      updated_at
    FROM ${MASTER}
    WHERE batch_id IS NOT NULL
    ORDER BY id
  `);

  const [{ master_n = 0 }] = await dbQuery(`SELECT COUNT(*)::int AS master_n FROM ${MASTER}`);
  const [{ staged_n = 0 }] = await dbQuery(`SELECT COUNT(*)::int AS staged_n FROM ${STAGING}`);
  if (Number(staged_n) < Number(master_n)) {
    await dbQuery(`DROP TABLE IF EXISTS ${STAGING}`);
    throw new Error(
      `[migration] trayMasterBatchId: reorder aborted (${staged_n}/${master_n} rows; batch_id backfill incomplete)`,
    );
  }

  const [{ max_id } = { max_id: 0 }] = await dbQuery(
    `SELECT COALESCE(MAX(id), 0)::int AS max_id FROM ${STAGING}`,
  );
  const seq = `${STAGING}_id_seq`;
  if (Number(max_id) > 0) {
    await dbQuery(`SELECT setval($1::regclass, $2, true)`, [seq, max_id]);
  }

  await dbQuery(`DROP TABLE ${MASTER}`);
  await dbQuery(`ALTER TABLE ${STAGING} RENAME TO ims_tray_master`);
  await dbQuery(`ALTER SEQUENCE ${seq} RENAME TO ims_tray_master_id_seq`);
  await dbQuery(
    `ALTER TABLE ${MASTER} ALTER COLUMN id SET DEFAULT nextval('ims_tray_master_id_seq'::regclass)`,
  );

  if (!(await constraintExists(FK))) {
    await dbQuery(`
      ALTER TABLE ${MASTER}
      ADD CONSTRAINT ${FK}
      FOREIGN KEY (batch_id) REFERENCES ${BATCH}(id)
    `);
  }

  await refreshTrayMasterIndexes();
  return true;
}

async function finalizeBatchIdFk() {
  const [{ n: nulls } = { n: 0 }] = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM ${MASTER} WHERE batch_id IS NULL`,
  );
  if (Number(nulls) > 0) {
    throw new Error(`[migration] trayMasterBatchId: ${nulls} tray row(s) missing batch_id`);
  }

  await dbQuery(`ALTER TABLE ${MASTER} ALTER COLUMN batch_id SET NOT NULL`);
  await dbQuery(`ALTER TABLE ${MASTER} DROP CONSTRAINT IF EXISTS ims_tray_master_tray_batch_uid_fkey`);
  if (!(await constraintExists(FK))) {
    await dbQuery(`
      ALTER TABLE ${MASTER}
      ADD CONSTRAINT ${FK}
      FOREIGN KEY (batch_id) REFERENCES ${BATCH}(id)
    `);
  }

  await dbQuery(`DROP INDEX IF EXISTS tray_master_tray_batch_uid_idx`);
  await refreshTrayMasterIndexes();
}

export default async function up() {
  if (!(await masterTableExists())) {
    console.log("[migration] trayMasterBatchId: ims_tray_master missing — skip");
    return;
  }

  const hasUid = await columnExists(dbQuery, MASTER, "tray_batch_uid");
  const hasBatchId = await columnExists(dbQuery, MASTER, "batch_id");

  if (hasUid && !hasBatchId) {
    await renameColumnIfExists(dbQuery, MASTER, "tray_batch_uid", "batch_id");
  } else if (hasUid && hasBatchId) {
    const batchKind = await columnUdt("batch_id");
    if (batchKind === "int4" || batchKind === "integer") {
      await dropColumnIfExists(dbQuery, MASTER, "tray_batch_uid");
    }
  }

  const batchKind = (await columnExists(dbQuery, MASTER, "batch_id"))
    ? await columnUdt("batch_id")
    : "";

  if (batchKind === "varchar" || batchKind === "text" || batchKind === "bpchar") {
    await renameColumnIfExists(dbQuery, MASTER, "batch_id", "batch_id_code");
    if (!(await columnExists(dbQuery, MASTER, "batch_id"))) {
      await dbQuery(`ALTER TABLE ${MASTER} ADD COLUMN batch_id INTEGER`);
    }
    await backfillIntegerBatchId("batch_id_code");
    await dropColumnIfExists(dbQuery, MASTER, "batch_id_code");
    await dropColumnIfExists(dbQuery, MASTER, "tray_batch_uid");
    await finalizeBatchIdFk();
    const repairedV = await repairSerialNumbersFromCode();
    const reorderedV = await reorderTrayMasterColumns();
    console.log(
      `[migration] trayMasterBatchId: batch_id integer FK; serial_repaired=${repairedV}; reordered=${reorderedV}`,
    );
    return;
  }

  if (batchKind === "int4" || batchKind === "integer") {
    await backfillIntegerBatchIdIfNeeded();
    await dropColumnIfExists(dbQuery, MASTER, "batch_id_code");
    await dropLegacyTrayMasterColumns();
    await finalizeBatchIdFk();
    const repaired = await repairSerialNumbersFromCode();
    const reordered = await reorderTrayMasterColumns();
    console.log(
      `[migration] trayMasterBatchId: batch_id FK OK; serial_repaired=${repaired}; reordered=${reordered}`,
    );
    return;
  }

  if (!(await columnExists(dbQuery, MASTER, "batch_id"))) {
    throw new Error("[migration] trayMasterBatchId: ims_tray_master has no batch_id column");
  }
}
