import { RMSTORE_TABLES as T } from "../../../../config/db/dbTables.js";

/** One QC row per coil — direct qc_uid link, or via RM rejection when qc_uid is empty. */
export function coilQcJoinForAlias(cAlias = "c", qAlias = "q") {
  return `LEFT JOIN LATERAL (
    SELECT qx.*
    FROM ${T.QC_CHECK} qx
    WHERE qx.is_deleted = false
      AND (
        qx.qc_check_uid = ${cAlias}.qc_uid
        OR (
          ${cAlias}.qc_uid IS NULL
          AND ${cAlias}.rm_uid IS NOT NULL
          AND qx.qc_reject_uid = ${cAlias}.rm_uid
        )
      )
    ORDER BY qx.qc_check_uid DESC
    LIMIT 1
  ) ${qAlias} ON true`;
}

export const COIL_QC_JOIN = coilQcJoinForAlias("c", "q");

export function coilQcStatusExpr(cAlias = "c", qAlias = "q") {
  return `CASE
  WHEN ${cAlias}.sa_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM ${T.STOCK_ADJUSTMENT} sa
    WHERE sa.adjustment_id = ${cAlias}.sa_id
      AND sa.is_deleted = false
      AND sa.approved = true
  ) THEN 'passed'
  ELSE LOWER(TRIM(COALESCE(${qAlias}.status, '')))
END`;
}

/** Resolved QC status for API reads (alias as qc_check_status). */
export const COIL_QC_STATUS_EXPR = coilQcStatusExpr("c", "q");

export const COIL_QC_PASSED_COND = `(${COIL_QC_STATUS_EXPR}) = 'passed'`;

export const COIL_QC_NOT_FINAL_COND = `((${COIL_QC_STATUS_EXPR}) = '' OR (${COIL_QC_STATUS_EXPR}) NOT IN ('passed', 'failed'))`;
