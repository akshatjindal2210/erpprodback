import { RMSTORE_TABLES as T } from "../../../../config/db/dbTables.js";

const PRODUCTION_RETURN = "production_return";

/** MRN Portal coils — excludes Stock Adjustment and Production Return balances. */
export function portalMrnCoilBaseSql(cAlias = "c") {
  return `(
    ${cAlias}.sa_id IS NULL
    AND NULLIF(TRIM(${cAlias}.mrn_uid::text), '') IS NOT NULL
    AND LOWER(COALESCE(${cAlias}.sa_entry_type, '')) <> '${PRODUCTION_RETURN}'
  )`;
}

/** MRN Portal coils whose stickers were generated. */
export function mrnPortalStickerCoilSql(cAlias = "c", mAlias = "m") {
  return `(
    ${portalMrnCoilBaseSql(cAlias)}
    AND ${mAlias}.sticker_generated = true
  )`;
}

/** EXISTS form for queries that do not already join MRN. */
export function mrnPortalStickerCoilExistsSql(cAlias = "c") {
  return `EXISTS (
    SELECT 1
    FROM ${T.MRN} mx
    WHERE mx.uid = ${cAlias}.mrn_uid
      AND mx.sticker_generated = true
  )`;
}

/**
 * Physical warehouse status for Unassigned / Coil Area / Store In.
 * Independent of QC pass/fail. Held RM Rejection / IPR-rejected coils belong
 * on Coil Finder as RM Rejection (REJECT-#), not in Store In Unassigned.
 */
export function coilAreaPhysicalStatusSql(cAlias = "c") {
  return `(
    ${cAlias}.out_uid IS NULL
    AND ${cAlias}.rm_uid IS NULL
    AND LOWER(COALESCE(${cAlias}.status, 'active')) NOT IN ('consumed', 'out', 'rejected', 'returned')
  )`;
}

/** Coil-area source filter — MRN portal stickers + production-return + SA stock-in add. */
export function coilAreaEligibleSql(cAlias = "c") {
  return `(
    (
      ${portalMrnCoilBaseSql(cAlias)}
      AND ${mrnPortalStickerCoilExistsSql(cAlias)}
    )
    OR LOWER(COALESCE(${cAlias}.sa_entry_type, '')) = '${PRODUCTION_RETURN}'
    OR (
      ${cAlias}.sa_id IS NOT NULL
      AND COALESCE(${cAlias}.sa_entry_type, '') = 'stock_in'
    )
  )`;
}

/** QC Pending — MRN portal sticker coils only (inspection queue; not tied to rack location). */
export function qcPendingMrnCoilSql(cAlias = "c", mAlias = "m") {
  return mrnPortalStickerCoilSql(cAlias, mAlias);
}
