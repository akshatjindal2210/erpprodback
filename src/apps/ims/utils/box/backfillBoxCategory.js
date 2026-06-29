/** Backfill category_id on ims_dailyprod, ims_stock_adjustment, ims_box_table. */
import dbQuery from "../../../../config/db.js";

function mutationCount(res) {
  if (res == null) return 0;
  if (typeof res.affectedRows === "number") return res.affectedRows;
  if (typeof res.rowCount === "number") return res.rowCount;
  return 0;
}

const PACKING_JOIN_B2 = `trim(b2.packing_number::text) = trim(dp.doc_no::text)`;
const PACKING_JOIN_SA = `trim(sa2.packing_number::text) = trim(dp2.doc_no::text)`;

export async function backfillBoxCategoryFromSources({ limit = 5000 } = {}) {
  const cap = Math.min(20000, Math.max(1, Number(limit) || 5000));
  let updated = 0;

  // 1) dailyprod.category_id from linked packing standard
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_dailyprod dp
       SET category_id = ps.type
       FROM ims_packing_standard ps
       WHERE dp.category_id IS NULL
         AND dp.packing_standard_id IS NOT NULL
         AND ps.standard_id = dp.packing_standard_id
         AND ps.is_deleted = false
         AND ps.type IS NOT NULL
         AND dp.doc_no IN (
           SELECT dp2.doc_no
           FROM ims_dailyprod dp2
           INNER JOIN ims_packing_standard ps2
             ON ps2.standard_id = dp2.packing_standard_id
            AND ps2.is_deleted = false
            AND ps2.type IS NOT NULL
           WHERE dp2.category_id IS NULL
             AND dp2.packing_standard_id IS NOT NULL
           ORDER BY dp2.doc_no
           LIMIT $1
         )`,
      [cap]
    )
  );

  // 2) stock_adjustment.category_id from dailyprod (same packing)
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_stock_adjustment sa
       SET category_id = dp.category_id
       FROM ims_dailyprod dp
       WHERE sa.is_deleted = false
         AND sa.category_id IS NULL
         AND sa.entry_type = 'add'
         AND dp.category_id IS NOT NULL
         AND trim(sa.packing_number::text) = trim(dp.doc_no::text)
         AND sa.adjustment_id IN (
           SELECT sa2.adjustment_id
           FROM ims_stock_adjustment sa2
           INNER JOIN ims_dailyprod dp2
             ON ${PACKING_JOIN_SA}
           WHERE sa2.is_deleted = false
             AND sa2.category_id IS NULL
             AND sa2.entry_type = 'add'
             AND dp2.category_id IS NOT NULL
           ORDER BY sa2.adjustment_id
           LIMIT $1
         )`,
      [cap]
    )
  );

  // 3) boxes from dailyprod.category_id
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_box_table b
       SET category_id = src.category_id,
           updated_at = NOW()
       FROM (
         SELECT b2.box_uid, dp.category_id
         FROM ims_box_table b2
         INNER JOIN ims_dailyprod dp ON ${PACKING_JOIN_B2}
         WHERE b2.is_deleted = false
           AND b2.category_id IS NULL
           AND dp.category_id IS NOT NULL
         ORDER BY b2.box_uid
         LIMIT $1
       ) src
       WHERE b.box_uid = src.box_uid`,
      [cap]
    )
  );

  // 4) boxes from packing_standard when dailyprod row exists but category_id still empty
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_box_table b
       SET category_id = src.category_id,
           updated_at = NOW()
       FROM (
         SELECT b2.box_uid, ps.type AS category_id
         FROM ims_box_table b2
         INNER JOIN ims_dailyprod dp ON ${PACKING_JOIN_B2}
         INNER JOIN ims_packing_standard ps
           ON ps.standard_id = dp.packing_standard_id
          AND ps.is_deleted = false
         WHERE b2.is_deleted = false
           AND b2.category_id IS NULL
           AND ps.type IS NOT NULL
         ORDER BY b2.box_uid
         LIMIT $1
       ) src
       WHERE b.box_uid = src.box_uid`,
      [cap]
    )
  );

  // 5) SA adjustment rows from packing_standard (item + optional customer)
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_stock_adjustment sa
       SET category_id = src.category_id
       FROM (
         SELECT DISTINCT ON (sa2.adjustment_id)
           sa2.adjustment_id,
           ps.type AS category_id
         FROM ims_stock_adjustment sa2
         INNER JOIN ims_packing_standard ps
           ON ps.item_dcode = sa2.item_dcode
          AND ps.is_deleted = false
          AND ps.approved = true
          AND (ps.acc_code IS NULL OR ps.acc_code::text = sa2.acc_code::text)
         WHERE sa2.is_deleted = false
           AND sa2.category_id IS NULL
           AND sa2.entry_type = 'add'
           AND ps.type IS NOT NULL
         ORDER BY sa2.adjustment_id, ps.acc_code NULLS LAST, ps.standard_id DESC
         LIMIT $1
       ) src
       WHERE sa.adjustment_id = src.adjustment_id`,
      [cap]
    )
  );

  // 6) SA stock-in boxes from stock_adjustment.category_id
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_box_table b
       SET category_id = src.category_id,
           updated_at = NOW()
       FROM (
         SELECT b2.box_uid, sa.category_id
         FROM ims_box_table b2
         INNER JOIN ims_stock_adjustment sa
           ON b2.sa_id = sa.adjustment_id
          AND sa.is_deleted = false
         WHERE b2.is_deleted = false
           AND b2.category_id IS NULL
           AND b2.sa_entry_type = 'stock_in'
           AND sa.category_id IS NOT NULL
         ORDER BY b2.box_uid
         LIMIT $1
       ) src
       WHERE b.box_uid = src.box_uid`,
      [cap]
    )
  );

  // 7) Legacy SA rows with no packing standard / dailyprod match — default OEM
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_stock_adjustment sa
       SET category_id = 1
       WHERE sa.is_deleted = false
         AND sa.category_id IS NULL
         AND sa.entry_type = 'add'
         AND sa.adjustment_id IN (
           SELECT sa2.adjustment_id
           FROM ims_stock_adjustment sa2
           WHERE sa2.is_deleted = false
             AND sa2.category_id IS NULL
             AND sa2.entry_type = 'add'
             AND NOT EXISTS (
               SELECT 1 FROM ims_dailyprod dp
               WHERE trim(sa2.packing_number::text) = trim(dp.doc_no::text)
                 AND dp.category_id IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM ims_packing_standard ps
               WHERE ps.item_dcode = sa2.item_dcode
                 AND ps.is_deleted = false
                 AND ps.approved = true
                 AND ps.type IS NOT NULL
                 AND (ps.acc_code IS NULL OR ps.acc_code::text = sa2.acc_code::text)
             )
           ORDER BY sa2.adjustment_id
           LIMIT $1
         )`,
      [cap]
    )
  );

  // 8) Propagate OEM default from SA to stock-in boxes (after step 7)
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_box_table b
       SET category_id = src.category_id,
           updated_at = NOW()
       FROM (
         SELECT b2.box_uid, sa.category_id
         FROM ims_box_table b2
         INNER JOIN ims_stock_adjustment sa
           ON b2.sa_id = sa.adjustment_id
          AND sa.is_deleted = false
         WHERE b2.is_deleted = false
           AND b2.category_id IS NULL
           AND b2.sa_entry_type = 'stock_in'
           AND sa.category_id IS NOT NULL
         ORDER BY b2.box_uid
         LIMIT $1
       ) src
       WHERE b.box_uid = src.box_uid`,
      [cap]
    )
  );

  // 9) Remaining boxes with no resolvable category source — default OEM
  updated += mutationCount(
    await dbQuery(
      `UPDATE ims_box_table b
       SET category_id = 1,
           updated_at = NOW()
       WHERE b.is_deleted = false
         AND b.category_id IS NULL
         AND b.box_uid IN (
           SELECT b2.box_uid
           FROM ims_box_table b2
           WHERE b2.is_deleted = false
             AND b2.category_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM ims_dailyprod dp
               WHERE trim(b2.packing_number::text) = trim(dp.doc_no::text)
                 AND (
                   dp.category_id IS NOT NULL
                   OR (
                     dp.packing_standard_id IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM ims_packing_standard ps
                       WHERE ps.standard_id = dp.packing_standard_id
                         AND ps.is_deleted = false
                         AND ps.type IS NOT NULL
                     )
                   )
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM ims_stock_adjustment sa
               WHERE b2.sa_id = sa.adjustment_id
                 AND b2.sa_entry_type = 'stock_in'
                 AND sa.is_deleted = false
                 AND sa.category_id IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM ims_stock_adjustment sa
               INNER JOIN ims_packing_standard ps
                 ON ps.item_dcode = sa.item_dcode
                AND ps.is_deleted = false
                AND ps.approved = true
                AND ps.type IS NOT NULL
                AND (ps.acc_code IS NULL OR ps.acc_code::text = sa.acc_code::text)
               WHERE b2.sa_id = sa.adjustment_id
                 AND b2.sa_entry_type = 'stock_in'
                 AND sa.is_deleted = false
                 AND sa.category_id IS NULL
             )
           ORDER BY b2.box_uid
           LIMIT $1
         )`,
      [cap]
    )
  );

  const [pending] = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ims_box_table WHERE is_deleted = false AND category_id IS NULL`
  );

  return { updated, pending: Number(pending?.c) || 0 };
}

/** Fix legacy `is_loose` — full-box qty = most common qty per packing (all active boxes). */
export async function backfillBoxIsLooseFromPackingMode() {
  const res = await dbQuery(
    `WITH qty_counts AS (
       SELECT
         packing_number,
         ROUND(qty)::int AS box_qty,
         COUNT(*)::int AS cnt
       FROM ims_box_table
       WHERE is_deleted = false
         AND qty IS NOT NULL
         AND ROUND(qty) > 0
       GROUP BY packing_number, ROUND(qty)::int
     ),
     packing_std AS (
       SELECT DISTINCT ON (packing_number)
         packing_number,
         box_qty AS std_qty
       FROM qty_counts
       ORDER BY packing_number, cnt DESC, box_qty DESC
     )
     UPDATE ims_box_table b
     SET is_loose = (ROUND(b.qty)::int IS DISTINCT FROM ps.std_qty),
         updated_at = NOW()
     FROM packing_std ps
     WHERE b.is_deleted = false
       AND b.packing_number = ps.packing_number
       AND ROUND(b.qty)::int > 0
       AND COALESCE(b.is_loose, false) IS DISTINCT FROM (ROUND(b.qty)::int IS DISTINCT FROM ps.std_qty)`
  );
  return { updated: mutationCount(res) };
}

export async function runBoxIsLooseBackfillOnStartup() {
  if (process.env.BACKFILL_BOX_IS_LOOSE === "0") return;

  try {
    const { updated } = await backfillBoxIsLooseFromPackingMode();
    if (updated > 0) {
      console.log(`✅ Box is_loose backfill: ${updated} box(es) corrected`);
    }
  } catch (err) {
    console.warn("Box is_loose backfill skipped:", err.message);
  }
}

export async function runBoxCategoryBackfillOnStartup() {
  if (process.env.BACKFILL_BOX_CATEGORY === "0") return;

  const [pendingRow] = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ims_box_table WHERE is_deleted = false AND category_id IS NULL`
  );
  const pendingStart = Number(pendingRow?.c) || 0;
  if (pendingStart === 0) return;

  const batchSize = Number(process.env.BACKFILL_BOX_CATEGORY_LIMIT) || 2000;
  const maxRounds = Number(process.env.BACKFILL_BOX_CATEGORY_ROUNDS) || 50;
  let totalUpdated = 0;

  console.log(`Box category backfill: ${pendingStart} box(es) pending — starting…`);

  for (let round = 1; round <= maxRounds; round++) {
    const { updated, pending: remaining } = await backfillBoxCategoryFromSources({ limit: batchSize });
    totalUpdated += updated;
    if (updated === 0) break;
    console.log(`Box category backfill round ${round}: +${updated} (${remaining} remaining)`);
  }

  const [left] = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM ims_box_table WHERE is_deleted = false AND category_id IS NULL`
  );
  const stillPending = Number(left?.c) || 0;

  if (totalUpdated > 0 || stillPending < pendingStart) {
    console.log(
      `✅ Box category backfill: ${totalUpdated} updated, ${stillPending} still without category_id`
    );
  }
  if (stillPending > 0) {
    console.warn(
      `Box category backfill: ${stillPending} box(es) still missing category_id — set via sticker/SA or packing standard`
    );
  }
}
