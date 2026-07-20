/**
 * Startup backfills (tables = schema only).
 * Safe / idempotent — already-done rows are no-ops. Failures never block boot.
 * SA packing meta is not run (legacy done; new SA fills on approve).
 */
import dbQuery from "../config/db.js";
import { columnExists, runIfColumnExists } from "../config/ensureDbColumns.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../config/dbTables.js";
import { runAuditUserNamesBackfill } from "./auditUserNames.js";
import { runBoxDownloadLogBackfill } from "./boxDownloadLog.js";
import { backfillDailyprodStickerColumns } from "../apps/ims/utils/packing-entry/backfillDailyprodStickerSnapshot.js";

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[backfill] ${label}:`, err?.message || err);
  }
}

export async function runStartupBackfills() {
  await safe("audit user names", runAuditUserNamesBackfill);

  await safe("FN schno", async () => {
    await runIfColumnExists(dbQuery, T.FORWARDING_NOTE_ITEM_WISE, "schno", async () => {
      await runIfColumnExists(dbQuery, T.FORWARDING_NOTE_MASTER, "schno", async () => {
        await dbQuery(`
          UPDATE ${T.FORWARDING_NOTE_ITEM_WISE} fi
          SET schno = LEFT(TRIM(f.schno::text), 32)
          FROM ${T.FORWARDING_NOTE_MASTER} f
          WHERE fi.fuid = f.fuid
            AND (fi.schno IS NULL OR TRIM(fi.schno::text) = '')
            AND f.schno IS NOT NULL
            AND TRIM(f.schno::text) <> ''
        `);
      });
    });
  });

  await safe("transaction_box user_name", async () => {
    await dbQuery(`
      UPDATE ${T.TRANSACTION_BOX} tb
      SET user_name = u.name
      FROM ${M.USERS} u
      WHERE tb.user_id = u.id AND tb.user_name IS NULL
    `);
  });

  await safe("activity_log user_name", async () => {
    await dbQuery(`
      UPDATE ${M.ACTIVITY_LOGS} l
      SET user_name = u.name
      FROM ${M.USERS} u
      WHERE l.user_id = u.id AND l.user_name IS NULL
    `);
  });

  await safe("box sa_entry_type", async () => {
    await runIfColumnExists(dbQuery, T.BOX_TABLE, "sa_entry_type", async () => {
      await dbQuery(`
        UPDATE ${T.BOX_TABLE}
        SET sa_entry_type = 'stock_in'
        WHERE sa_id IS NOT NULL AND sa_entry_type IS NULL
      `);
    });
  });

  await safe("box download log", runBoxDownloadLogBackfill);

  await safe("dailyprod stickers", async () => {
    if (!(await columnExists(dbQuery, T.BOX_TABLE, "packing_number"))) return;
    const { updated } = await backfillDailyprodStickerColumns();
    if (updated > 0) console.log(`✅ Backfilled ${updated} ims_dailyprod sticker row(s)`);
  });

  await safe("box category", async () => {
    const { runBoxCategoryBackfillOnStartup } = await import(
      "../apps/ims/utils/box/backfillBoxCategory.js"
    );
    await runBoxCategoryBackfillOnStartup();
  });

  await safe("box is_loose", async () => {
    const { runBoxIsLooseBackfillOnStartup } = await import(
      "../apps/ims/utils/box/backfillBoxCategory.js"
    );
    await runBoxIsLooseBackfillOnStartup();
  });
}
