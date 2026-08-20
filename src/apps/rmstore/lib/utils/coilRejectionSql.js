import { RMSTORE_TABLES as T } from "../../../../config/db/dbTables.js";

/** Join RM Rejection register — coil.rm_uid → rejection.qc_reject_uid (PK). */
export const COIL_REJECTION_JOIN = `LEFT JOIN ${T.REJECTION} rj ON rj.qc_reject_uid = c.rm_uid AND rj.is_deleted = false`;

export function coilRejectionJoinForAlias(cAlias = "c", rjAlias = "rj") {
  return `LEFT JOIN ${T.REJECTION} ${rjAlias} ON ${rjAlias}.qc_reject_uid = ${cAlias}.rm_uid AND ${rjAlias}.is_deleted = false`;
}

/** Register fields from rmstore_rejection (read-only on coil list). */
export const COIL_REJECTION_SELECT = `
  c.rm_uid,
  rj.approved AS rejection_approved,
  rj.reason AS rejection_reason,
  rj.bill_no AS rejection_bill_no
`;
