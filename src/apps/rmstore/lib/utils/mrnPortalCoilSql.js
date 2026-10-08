import { RMSTORE_TABLES as T } from "../../../../config/db/dbTables.js";

const PRODUCTION_RETURN = "production_return";

/** sticker_status values that count as generated (generate or approved). */
export function mrnStickerGeneratedSql(mAlias = "m") {
  return `LOWER(TRIM(COALESCE(${mAlias}.sticker_status, ''))) IN ('generate', 'approved')`;
}

/** sticker_status = approved. */
export function mrnStickerApprovedSql(mAlias = "m") {
  return `LOWER(TRIM(COALESCE(${mAlias}.sticker_status, ''))) = 'approved'`;
}

/** MRN Portal coils — excludes Stock Adjustment and Production Return balances. */
export function portalMrnCoilBaseSql(cAlias = "c") {
  return `(
    ${cAlias}.sa_id IS NULL
    AND NULLIF(TRIM(${cAlias}.mrn_uid::text), '') IS NOT NULL
    AND LOWER(COALESCE(${cAlias}.sa_entry_type, '')) <> '${PRODUCTION_RETURN}'
  )`;
}

/** MRN Portal coils whose stickers were generated (approve not required). */
export function mrnPortalGeneratedCoilSql(cAlias = "c", mAlias = "m") {
  return `(
    ${portalMrnCoilBaseSql(cAlias)}
    AND ${mrnStickerGeneratedSql(mAlias)}
  )`;
}

/** MRN Portal coils whose stickers were generated and scan-approved. */
export function mrnPortalStickerCoilSql(cAlias = "c", mAlias = "m") {
  return `(
    ${portalMrnCoilBaseSql(cAlias)}
    AND ${mrnStickerGeneratedSql(mAlias)}
    AND ${mrnStickerApprovedSql(mAlias)}
  )`;
}

/** EXISTS — generated stickers only (Store In / Unassigned queue). */
export function mrnPortalGeneratedCoilExistsSql(cAlias = "c") {
  return `EXISTS (
    SELECT 1
    FROM ${T.MRN} mx
    WHERE mx.uid = ${cAlias}.mrn_uid
      AND ${mrnStickerGeneratedSql("mx")}
  )`;
}

/** EXISTS — generated + approved stickers (QC / downstream). */
export function mrnPortalStickerCoilExistsSql(cAlias = "c") {
  return `EXISTS (
    SELECT 1
    FROM ${T.MRN} mx
    WHERE mx.uid = ${cAlias}.mrn_uid
      AND ${mrnStickerGeneratedSql("mx")}
      AND ${mrnStickerApprovedSql("mx")}
  )`;
}

/**
 * Physical warehouse status for Unassigned / Coil Area / Store In.
 * Independent of QC pass/fail. IPR-rejected coils (still on shop floor) also
 * appear here so they can be racked; other RM Rejection holds do not.
 */
export function iprRejectedCoilSql(cAlias = "c") {
  return `(LOWER(COALESCE(${cAlias}.status, '')) = 'rejected' AND ${cAlias}.ipr_uid IS NOT NULL)`;
}

export function coilAreaPhysicalStatusSql(cAlias = "c") {
  return `(
    ${cAlias}.out_uid IS NULL
    AND (
      (
        ${cAlias}.rm_uid IS NULL
        AND LOWER(COALESCE(${cAlias}.status, 'active')) NOT IN ('consumed', 'out', 'rejected', 'returned')
      )
      OR ${iprRejectedCoilSql(cAlias)}
    )
  )`;
}

/** Coil-area source filter — MRN portal stickers + production-return + SA stock-in add. */
export function coilAreaEligibleSql(cAlias = "c") {
  return `(
    (
      ${portalMrnCoilBaseSql(cAlias)}
      AND ${mrnPortalGeneratedCoilExistsSql(cAlias)}
    )
    OR LOWER(COALESCE(${cAlias}.sa_entry_type, '')) = '${PRODUCTION_RETURN}'
    OR (
      ${cAlias}.sa_id IS NOT NULL
      AND COALESCE(${cAlias}.sa_entry_type, '') = 'stock_in'
    )
    OR ${iprRejectedCoilSql(cAlias)}
  )`;
}

/** QC Pending — MRN portal coils with approved stickers (Store In not required). */
export function qcPendingMrnCoilSql(cAlias = "c", mAlias = "m") {
  return mrnPortalStickerCoilSql(cAlias, mAlias);
}
