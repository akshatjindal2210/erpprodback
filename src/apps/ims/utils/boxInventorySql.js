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
          WHERE o.out_uid::text = ${alias}.out_uid::text
            AND o.approved = true
            AND o.is_deleted = false
        )
      )
    )
  `.trim();
}

/** Normalized packing number on ims_box_table. */
export function sqlBoxPackingNumber(alias = "b") {
  return `NULLIF(TRIM(${alias}.packing_number::text), '-')`;
}

/** Item dcode resolved per box (SA first, then dailyprod). */
export function sqlBoxItemDcode(saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(${saAlias}.item_dcode::text, ${dpAlias}.item_dcode::text, '-')`;
}

/** Item dcode — inventory report / box_agg grouping (em-dash fallback). */
export function sqlBoxItemDcodeReport(saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(${saAlias}.item_dcode::text, ${dpAlias}.item_dcode::text, '—')`;
}

/** Customer code per box — per-box override wins over packing / dailyprod customer. */
export function sqlBoxCustomerCode(boxAlias = "b", dpAlias = "dp") {
  return `COALESCE(NULLIF(TRIM(${boxAlias}.override_cust::text), ''), NULLIF(TRIM(${dpAlias}.acc_code::text), ''), '-')`;
}

/** Customer code for audit / SA boxes — stock adjustment acc_code before dailyprod. */
export function sqlBoxCustomerCodeWithSa(boxAlias = "b", saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(
    NULLIF(NULLIF(TRIM(${boxAlias}.override_cust::text), ''), '-'),
    NULLIF(NULLIF(TRIM(${saAlias}.acc_code::text), ''), '-'),
    NULLIF(NULLIF(TRIM(${dpAlias}.acc_code::text), ''), '-'),
    '-'
  )`;
}

/** Customer code — inventory report / box_agg grouping (no dash fallback). */
export function sqlBoxCustomerCodeReport(boxAlias = "b", dpAlias = "dp") {
  return `COALESCE(NULLIF(TRIM(${boxAlias}.override_cust::text), ''), NULLIF(TRIM(${dpAlias}.acc_code::text), ''))`;
}

/** Match ims_dailyprod.doc_no to a packing number (text or numeric). */
export function sqlDailyprodDocNoMatch(dpDocCol, packingExpr) {
  return `(
    NULLIF(TRIM(${dpDocCol}::text), '') = NULLIF(TRIM(${packingExpr}::text), '')
    OR NULLIF(TRIM(${dpDocCol}::text), '-') = NULLIF(TRIM(${packingExpr}::text), '-')
    OR (
      NULLIF(TRIM(${dpDocCol}::text), '') ~ '^[0-9]+$'
      AND NULLIF(TRIM(${packingExpr}::text), '') ~ '^[0-9]+$'
      AND TRIM(${dpDocCol}::text)::numeric = TRIM(${packingExpr}::text)::numeric
    )
  )`;
}

/**
 * Dailyprod lateral for a box row: prefers SA item match, then override_cust match.
 * @param {string} pnExpr packing number expression (must match the box alias)
 */
export function sqlDailyprodLateralForBox(boxAlias = "b", saAlias = "sa", pnExpr) {
  const pn = pnExpr || sqlBoxPackingNumber(boxAlias);
  return `LEFT JOIN LATERAL (
    SELECT dp2.doc_dt, dp2.job_card_no, dp2.item_dcode, dp2.acc_code, dp2.total_qty
    FROM ims_dailyprod dp2
    WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", pn)}
    ORDER BY
      (CASE WHEN ${saAlias}.item_dcode IS NOT NULL AND dp2.item_dcode = ${saAlias}.item_dcode THEN 0 ELSE 1 END) ASC,
      (CASE WHEN NULLIF(TRIM(${boxAlias}.override_cust::text), '') IS NOT NULL
                 AND TRIM(dp2.acc_code::text) = TRIM(${boxAlias}.override_cust::text) THEN 0 ELSE 1 END) ASC
    LIMIT 1
  ) dp ON true`;
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
      WHERE o.out_uid::text = ${alias}.out_uid::text
        AND o.approved = true
        AND o.is_deleted = false
    )
  `.trim();
}
