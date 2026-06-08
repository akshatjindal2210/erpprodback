import dbQuery from "../src/config/db.js";
import {
  computeInwardListMetadata,
  computeOutEntryListMetadata,
  resolveMetadataItemCodes,
} from "../src/apps/ims/utils/entryListMetadata.js";

async function migrateDailyprodAndStockAdjustment() {
  await dbQuery(`
    ALTER TABLE ims_dailyprod
      ADD COLUMN IF NOT EXISTS item_code TEXT
  `);

  await dbQuery(`
    ALTER TABLE ims_stock_adjustment
      ADD COLUMN IF NOT EXISTS acc_code TEXT
  `);
}

async function migrateDropLegacyActivityLogTables() {
  await dbQuery(`DROP TABLE IF EXISTS ims_activity_logs`);
  await dbQuery(`DROP TABLE IF EXISTS task_users_logs`);
}

/**
 * Fix SERIAL sequences out of sync after manual inserts / backup restore.
 * Safe to re-run (idempotent).
 */
async function migrateResetSerialSequences() {
  await dbQuery(`
    DO $$
    DECLARE
      rec RECORD;
      max_val BIGINT;
    BEGIN
      FOR rec IN
        SELECT
          format('%I.%I', n.nspname, c.relname) AS tbl,
          a.attname AS col,
          pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relkind = 'r'
          AND n.nspname = 'public'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
      LOOP
        EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %s', rec.col, rec.tbl) INTO max_val;
        IF max_val > 0 THEN
          PERFORM setval(rec.seq, max_val, true);
        ELSE
          PERFORM setval(rec.seq, 1, false);
        END IF;
      END LOOP;
    END $$;
  `);
}

async function migrateOutEntry() {
  await dbQuery(`
    ALTER TABLE ims_out_entry
      ADD COLUMN IF NOT EXISTS entry_type VARCHAR(20) DEFAULT 'forwarding_note'
  `);

  await dbQuery(`
    UPDATE ims_out_entry
    SET entry_type = 'forwarding_note'
    WHERE entry_type IS NULL OR TRIM(entry_type) = ''
  `);

  await dbQuery(`
    DO $$ BEGIN
      ALTER TABLE ims_out_entry ALTER COLUMN fuid DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
}

/** One-time: store in/out table metadata columns + backfill. Safe to re-run; delete after live deploy. */
async function migrateStoreInOutListMetadata() {
  await dbQuery(`ALTER TABLE ims_inventory_inwards ADD COLUMN IF NOT EXISTS item_codes TEXT`);
  await dbQuery(`ALTER TABLE ims_inventory_inwards ADD COLUMN IF NOT EXISTS qtys TEXT`);
  await dbQuery(`ALTER TABLE ims_inventory_inwards ADD COLUMN IF NOT EXISTS total_qty INTEGER DEFAULT 0`);

  await dbQuery(`ALTER TABLE ims_out_entry ADD COLUMN IF NOT EXISTS packing_numbers TEXT`);
  await dbQuery(`ALTER TABLE ims_out_entry ADD COLUMN IF NOT EXISTS item_codes TEXT`);
  await dbQuery(`ALTER TABLE ims_out_entry ADD COLUMN IF NOT EXISTS qtys TEXT`);
  await dbQuery(`ALTER TABLE ims_out_entry ADD COLUMN IF NOT EXISTS total_qty INTEGER DEFAULT 0`);

  const inwards = await dbQuery(
    `SELECT in_uid FROM ims_inventory_inwards WHERE is_deleted = false`
  );
  for (const row of inwards) {
    const raw = await computeInwardListMetadata(row.in_uid);
    const meta = await resolveMetadataItemCodes(raw);
    await dbQuery(
      `UPDATE ims_inventory_inwards
       SET item_codes = $2, qtys = $3, total_qty = $4
       WHERE in_uid = $1`,
      [row.in_uid, meta.item_codes, meta.qtys, meta.total_qty ?? 0]
    );
  }

  const outs = await dbQuery(
    `SELECT out_uid FROM ims_out_entry WHERE is_deleted = false`
  );
  for (const row of outs) {
    const raw = await computeOutEntryListMetadata(row.out_uid);
    const meta = await resolveMetadataItemCodes(raw);
    await dbQuery(
      `UPDATE ims_out_entry
       SET packing_numbers = $2, item_codes = $3, qtys = $4, total_qty = $5
       WHERE out_uid = $1`,
      [row.out_uid, meta.packing_numbers, meta.item_codes, meta.qtys, meta.total_qty ?? 0]
    );
  }
}

async function migrateOutEntryReason() {
  await dbQuery(`
    ALTER TABLE ims_out_entry
      ADD COLUMN IF NOT EXISTS reason VARCHAR(200)
  `);

  await dbQuery(`
    DO $$ BEGIN
      ALTER TABLE ims_out_entry DROP CONSTRAINT IF EXISTS ims_out_entry_reason_id_fkey;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  await dbQuery(`ALTER TABLE ims_out_entry DROP COLUMN IF EXISTS reason_id`);
  await dbQuery(`DROP TABLE IF EXISTS ims_out_entry_reason`);
}

const migrations = [
  { name: "dailyprod.item_code + stock_adjustment.acc_code", run: migrateDailyprodAndStockAdjustment },
  { name: "out_entry.entry_type + nullable fuid", run: migrateOutEntry },
  { name: "out_entry.reason column", run: migrateOutEntryReason },
  { name: "drop legacy activity log tables (ims_activity_logs, task_users_logs)", run: migrateDropLegacyActivityLogTables },
  { name: "reset SERIAL sequences (mst_users, mst_user_app_access, …)", run: migrateResetSerialSequences },
  { name: "store in/out list metadata columns + backfill", run: migrateStoreInOutListMetadata },
];

async function main() {
  try {
    console.log("Running migrations...\n");

    for (const step of migrations) {
      console.log(`→ ${step.name}`);
      await step.run();
      console.log(`✓ ${step.name}\n`);
    }

    console.log("All migrations completed.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
