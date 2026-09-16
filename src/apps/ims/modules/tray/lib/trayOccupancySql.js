import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

export const TRAY_OCC_JOIN = `LEFT JOIN ${T.BOX_TABLE} b ON b.box_uid = t.box_uid AND b.is_deleted = false`;

export const TRAY_POOL_EXPR = `CASE
  WHEN t.box_uid IS NULL THEN 'vacant'
  WHEN b.out_uid IS NOT NULL THEN 'with_customer'
  WHEN b.location_id IS NOT NULL THEN 'storage'
  ELSE 'in_use'
END`;
