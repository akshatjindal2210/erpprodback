/**
 * SQL fragments for box inventory — mirrors backend/src/utils/boxInventory.js
 *
 * 1. out_uid empty  → in hand (inventory counts)
 * 2. out_uid set + stock adjustment (sa_entry_type stock_out, or out_uid = sa_id) → not inventory
 * 3. out_uid set + not SA out (typical out entry; sa_id may stay from prior SA add) → not inventory
 */

export function sqlBoxOutUidEmpty(alias = "b") {
  return `(${alias}.out_uid IS NULL OR NULLIF(TRIM(${alias}.out_uid::text), '') IS NULL)`;
}

export function sqlBoxSaIdSet(alias = "b") {
  return `(${alias}.sa_id IS NOT NULL)`;
}

/** Case 1 — counts toward inventory report / inward. */
export function sqlBoxInHand(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND ${sqlBoxOutUidEmpty(alias)}
    AND (${alias}.sa_entry_type IS DISTINCT FROM 'stock_out')
  `.trim();
}

/** Case 2 — removed via stock adjustment minus. */
export function sqlBoxStockAdjustmentOut(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND NOT ${sqlBoxOutUidEmpty(alias)}
    AND (
      ${alias}.sa_entry_type = 'stock_out'
      OR (
        ${sqlBoxSaIdSet(alias)}
        AND ${alias}.out_uid::text = ${alias}.sa_id::text
      )
    )
  `.trim();
}

/** Out of inventory counts (dispatch or stock-adjustment minus). */
export function sqlBoxCountedAsOut(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND (
      ${alias}.sa_entry_type = 'stock_out'
      OR (
        NOT ${sqlBoxOutUidEmpty(alias)}
        AND EXISTS (
          SELECT 1 FROM ims_out_entry o
          WHERE o.out_uid = ${alias}.out_uid::integer
            AND o.approved = true
            AND o.is_deleted = false
        )
      )
    )
  `.trim();
}

/** Case 3 — dispatched via approved out entry only (stock reflects on authorize). */
export function sqlBoxOutwardDispatch(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND NOT ${sqlBoxOutUidEmpty(alias)}
    AND NOT (
      ${alias}.sa_entry_type = 'stock_out'
      OR (
        ${sqlBoxSaIdSet(alias)}
        AND ${alias}.out_uid::text = ${alias}.sa_id::text
      )
    )
    AND EXISTS (
      SELECT 1 FROM ims_out_entry o
      WHERE o.out_uid = ${alias}.out_uid::integer
        AND o.approved = true
        AND o.is_deleted = false
    )
  `.trim();
}
