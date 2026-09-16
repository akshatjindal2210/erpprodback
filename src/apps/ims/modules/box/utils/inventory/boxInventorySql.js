/**
 * SQL fragments for box inventory — mirrors backend/src/utils/box/boxInventory.js
 *
 * 1. out_uid empty  → in hand (inventory counts)
 * 2. out_uid set + stock_out (or legacy out_uid = sa_id when not stock_in) → not inventory
 * 3. out_uid set + not SA out (typical out entry; sa_id may stay from prior SA add) → not inventory
 */

export function sqlBoxOutUidEmpty(alias = "b") {
  return `${alias}.out_uid IS NULL`;
}

/** Packing category is tray (dailyprod or category master). Sticker type is always box. */
export function sqlPackingIsTray(packingExpr) {
  return `EXISTS (
    SELECT 1
    FROM ims_dailyprod dp
    LEFT JOIN ims_category c ON c.id = dp.category_id
    WHERE TRIM(dp.doc_no::text) = TRIM(${packingExpr}::text)
      AND (
        LOWER(TRIM(COALESCE(dp.category_name, ''))) = 'tray'
        OR LOWER(TRIM(COALESCE(c.name, ''))) = 'tray'
      )
  )`;
}

/** Tray packing is blocked in Store In until it has an active register row. */
export function sqlManageTrayPending(alias = "b") {
  return `(
    ${alias}.out_uid IS NULL
    AND (${alias}.sa_entry_type IS DISTINCT FROM 'stock_out')
    AND ${alias}.qc_hold_id IS NULL
    AND ${sqlPackingIsTray(`${alias}.packing_number`)}
    AND NOT EXISTS (
      SELECT 1 FROM ims_tray_manage m
      WHERE m.is_deleted = false
        AND m.approved = true
        AND TRIM(m.data->>'packing_number') = TRIM(${alias}.packing_number::text)
    )
  )`;
}

/** List/group SOURCE label — packing entry / SA stock_in / QC hold / manage tray. */
export function boxSourceSql(alias = "b") {
  return `CASE
    WHEN ${sqlManageTrayPending(alias)} THEN 'MANAGE TRAY'
    WHEN ${alias}.sa_id IS NOT NULL AND ${alias}.sa_entry_type = 'stock_in' THEN 'STOCK ADJUSTMENT'
    WHEN ${alias}.box_no_uid ~ '_QCH[0-9]+_' THEN 'QC HOLD'
    ELSE 'PACKING ENTRY'
  END`;
}

export function sqlBoxSaIdSet(alias = "b") {
  return `${alias}.sa_id IS NOT NULL`;
}

/**
 * Legacy minus marker: out_uid copied from sa_id.
 * Skip when sa_entry_type is stock_in — that sa_id is the *add* that created the box,
 * so a later out-entry with the same numeric id is dispatch, not minus.
 */
function sqlBoxLegacySaMinusMarker(alias = "b") {
  return `(
    ${sqlBoxSaIdSet(alias)}
    AND ${alias}.out_uid = ${alias}.sa_id
    AND (${alias}.sa_entry_type IS DISTINCT FROM 'stock_in')
  )`;
}

/** Case 1 — physically in hand (includes QC hold). */
export function sqlBoxInHand(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND ${sqlBoxOutUidEmpty(alias)}
    AND (${alias}.sa_entry_type IS DISTINCT FROM 'stock_out')
  `.trim();
}

/** Not linked to an active QC hold row. */
export function sqlBoxNotOnQcHold(alias = "b") {
  return `(${alias}.qc_hold_id IS NULL)`;
}

/** On QC hold — still in hand physically, excluded from sellable stock. */
export function sqlBoxOnQcHold(alias = "b") {
  return `(${alias}.qc_hold_id IS NOT NULL)`;
}

/** Sellable stock — in hand and not on QC hold. */
export function sqlBoxSellable(alias = "b") {
  return `(${sqlBoxInHand(alias)} AND ${sqlBoxNotOnQcHold(alias)})`;
}

/** Case 2 — removed via stock adjustment minus. */
export function sqlBoxStockAdjustmentOut(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND NOT ${sqlBoxOutUidEmpty(alias)}
    AND (
      ${alias}.sa_entry_type = 'stock_out'
      OR ${sqlBoxLegacySaMinusMarker(alias)}
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
          WHERE o.out_uid = ${alias}.out_uid
            AND o.approved = true
            AND o.is_deleted = false
            AND ${sqlOutEntryCustomerDispatch("o")}
        )
      )
    )
  `.trim();
}

/** Normalized packing number on ims_box_table. */
export function sqlBoxPackingNumber(alias = "b") {
  return `NULLIF(TRIM(${alias}.packing_number::text), '-')`;
}

/** Match packing on column (numeric-safe). */
export function sqlBoxPackingNumberMatch(alias, paramRef) {
  return `(
    ${alias}.packing_number = ${paramRef}::text
    OR (
      ${alias}.packing_number ~ '^[0-9]+$'
      AND ${paramRef}::text ~ '^[0-9]+$'
      AND ${alias}.packing_number::numeric = ${paramRef}::numeric
    )
  )`;
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
export function sqlBoxCustomerCodeReport(boxAlias = "b", saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(
    NULLIF(TRIM(${boxAlias}.override_cust::text), ''),
    NULLIF(TRIM(${saAlias}.acc_code::text), ''),
    NULLIF(TRIM(${dpAlias}.acc_code::text), '')
  )`;
}

/** Customer identity for report row split — code first, name when code is missing. */
export function sqlBoxCustomerKeyReport(boxAlias = "b", saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(
    NULLIF(TRIM(${boxAlias}.override_cust::text), ''),
    NULLIF(TRIM(${saAlias}.acc_code::text), ''),
    NULLIF(TRIM(${dpAlias}.acc_code::text), ''),
    NULLIF(TRIM(${saAlias}.acc_name::text), ''),
    NULLIF(TRIM(${dpAlias}.acc_name::text), '')
  )`;
}

/** Customer display name — SA / dailyprod name first, then per-box override text. */
export function sqlBoxCustomerNameReport(boxAlias = "b", saAlias = "sa", dpAlias = "dp") {
  return `COALESCE(
    NULLIF(TRIM(${saAlias}.acc_name::text), ''),
    NULLIF(TRIM(${dpAlias}.acc_name::text), ''),
    NULLIF(TRIM(${boxAlias}.override_cust::text), '')
  )`;
}

/** PostgreSQL DATE → `YYYY-MM-DD` text (avoids node-pg timezone shift on JS Date). */
export function sqlDocDtText(dateExpr) {
  return `CASE WHEN ${dateExpr} IS NULL THEN NULL::text ELSE to_char(${dateExpr}::date, 'YYYY-MM-DD') END`;
}

/** doc_dt from ims_dailyprod column. */
export function sqlDocDtFromDailyprod(dpAlias = "dp") {
  return sqlDocDtText(`${dpAlias}.doc_dt`);
}

/**
 * Pick one dailyprod row for a packing: item → customer → non-null doc_dt (never newest-by-default).
 * @param {string} itemExpr row item_dcode (treats '—' as no preference)
 * @param {string} customerExpr row acc_code / customer_code
 */
export function sqlDailyprodMatchOrder(itemExpr, customerExpr, dpAlias = "dp2") {
  return `
    (CASE WHEN ${itemExpr} IS NOT NULL AND TRIM(${itemExpr}::text) NOT IN ('', '—')
          AND TRIM(${dpAlias}.item_dcode::text) = TRIM(${itemExpr}::text) THEN 0 ELSE 1 END) ASC,
    (CASE WHEN ${customerExpr} IS NOT NULL AND TRIM(${customerExpr}::text) <> ''
          AND TRIM(${dpAlias}.acc_code::text) = TRIM(${customerExpr}::text) THEN 0 ELSE 1 END) ASC,
    (CASE WHEN ${dpAlias}.doc_dt IS NOT NULL THEN 0 ELSE 1 END) ASC,
    (CASE WHEN ${dpAlias}.doc_dt IS NOT NULL THEN 0 ELSE 1 END) ASC,
    ${dpAlias}.doc_dt ASC NULLS LAST`;
}

/** Match ims_dailyprod.doc_no to a packing number (text or numeric). */
export function sqlDailyprodDocNoMatch(dpDocCol, packingExpr) {
  return `(
    ${dpDocCol}::text = ${packingExpr}::text
    OR (
      ${packingExpr}::text ~ '^[0-9]+$'
      AND ${dpDocCol} = ${packingExpr}::integer
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
    SELECT
      dp2.doc_no,
      ${sqlDocDtFromDailyprod("dp2")} AS doc_dt,
      dp2.job_card_no,
      dp2.item_dcode,
      dp2.item_code,
      dp2.item_desc,
      dp2.acc_code,
      dp2.acc_name,
      dp2.total_qty
    FROM ims_dailyprod dp2
    WHERE ${sqlDailyprodDocNoMatch("dp2.doc_no", pn)}
    ORDER BY
      (CASE WHEN ${saAlias}.item_dcode IS NOT NULL AND dp2.item_dcode = ${saAlias}.item_dcode THEN 0 ELSE 1 END) ASC,
      (CASE WHEN NULLIF(TRIM(${boxAlias}.override_cust::text), '') IS NOT NULL
                 AND TRIM(dp2.acc_code::text) = TRIM(${boxAlias}.override_cust::text) THEN 0 ELSE 1 END) ASC,
      (CASE WHEN NULLIF(TRIM(${saAlias}.acc_code::text), '') IS NOT NULL
                 AND TRIM(dp2.acc_code::text) = TRIM(${saAlias}.acc_code::text) THEN 0 ELSE 1 END) ASC
    LIMIT 1
  ) dp ON true`;
}

/** Case 3 — dispatched via out entry (matches box list / isBoxOutwardDispatch). */
export function sqlBoxOutwardDispatchAny(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND NOT ${sqlBoxOutUidEmpty(alias)}
    AND NOT (
      ${alias}.sa_entry_type IS NOT DISTINCT FROM 'stock_out'
      OR ${sqlBoxLegacySaMinusMarker(alias)}
    )
  `.trim();
}

/** Customer dispatch out entries — excludes internal QC / packing area moves. */
export function sqlOutEntryCustomerDispatch(alias = "o") {
  return `COALESCE(NULLIF(TRIM(${alias}.entry_type::text), ''), 'forwarding_note') IN ('forwarding_note', 'inventory_out')`;
}

/** Case 3 — dispatched via approved out entry only (stock reflects on authorize). */
export function sqlBoxOutwardDispatch(alias = "b") {
  return `
    ${alias}.is_deleted = false
    AND NOT ${sqlBoxOutUidEmpty(alias)}
    AND NOT (
      ${alias}.sa_entry_type IS NOT DISTINCT FROM 'stock_out'
      OR ${sqlBoxLegacySaMinusMarker(alias)}
    )
    AND EXISTS (
      SELECT 1 FROM ims_out_entry o
      WHERE o.out_uid = ${alias}.out_uid
        AND o.approved = true
        AND o.is_deleted = false
    )
  `.trim();
}
