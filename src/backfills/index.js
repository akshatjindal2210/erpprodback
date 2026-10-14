/**
 * Manual data backfills — none of these run on boot by default.
 * Run one: uncomment its line in `config/db/initDB.js` (section 5) → restart once → check the log → comment again.
 * Each job is idempotent; a failure is logged and never blocks boot.
 */
import dbQuery from "../config/db/db.js";
import { columnExists, runIfColumnExists } from "../config/db/ensureDbColumns.js";
import { MST_TABLES as M, IMS_TABLES as T } from "../config/db/dbTables.js";
import { runAuditUserNamesBackfill } from "./auditUserNames.js";
import { runBoxDownloadLogBackfill } from "./boxDownloadLog.js";
import { runImportErpInvoiceReceivingToGate } from "./importErpInvoiceReceivingToGate.js";
import { backfillDailyprodStickerColumns } from "../apps/ims/lib/utils/packing-entry/stickers/backfillDailyprodStickerSnapshot.js";

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[backfill] ${label}:`, err?.message || err);
  }
}

// ── Old small data fixes (IMS / core) — safe to re-run ─────────────────────
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
    const { runBoxCategoryBackfillOnStartup, runBoxIsLooseBackfillOnStartup } = await import(
      "../apps/ims/modules/box/utils/backfill/backfillBoxCategory.js"
    );
    await runBoxCategoryBackfillOnStartup();
    await runBoxIsLooseBackfillOnStartup();
  });

  console.log("✅ Startup backfills finished");
}

// ── One-time imports — run once, then keep commented ───────────────────────

/** ERP invreceiving → ims_gate_entry. ⚠ Calls ERP; files → `documents`, meta → receiving_meta, only on gates that have no IR files yet. */
export const backfillIrErpToGate = () => safe("IR ERP → gate", runImportErpInvoiceReceivingToGate);

/** v4.1.5 Shortage.grpname from IMS. */
export { default as backfillShortageGrpname } from "../migrations/v4.1.5/shortageGrpname.mjs";

/** v5.0.0 old file paths → documents (`<uuid>.<ext>`). Auto while the version is 5.0.0; run manually after a version bump if needed. */
export { default as backfillDocFiles } from "../migrations/v5.0.0/docFileBackfill.js";

