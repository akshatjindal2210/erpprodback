/**
 * Gate Entry model — independent (no Forwarding Note link).
 * Light row only; invmnote / invfnote always come live from IMS.
 */
import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

export async function findSavedGateBillSet() {
  const rows = await dbQuery(
    `
    SELECT LOWER(TRIM(bill_no)) AS bill_key
    FROM ${T.GATE_ENTRY}
    WHERE is_deleted = false AND NULLIF(TRIM(bill_no), '') IS NOT NULL
    `
  );
  return new Set((rows || []).map((r) => String(r.bill_key || "").trim()).filter(Boolean));
}

export async function findGateRows() {
  return dbQuery(
    `
    SELECT
      uid, bill_no, bill_dt, remarks, transporter_name, vehicle_number,
      created_by, created_at, updated_by, updated_at, approved_at
    FROM ${T.GATE_ENTRY}
    WHERE is_deleted = false
    ORDER BY uid DESC
    `
  );
}

export async function findGateByUid(uid) {
  const [row] = await dbQuery(
    `SELECT * FROM ${T.GATE_ENTRY} WHERE uid = $1 AND is_deleted = false LIMIT 1`,
    [uid]
  );
  return row || null;
}

export async function findGateByBillNo(bill_no) {
  const bill = String(bill_no || "").trim();
  if (!bill) return null;
  const [row] = await dbQuery(
    `
    SELECT * FROM ${T.GATE_ENTRY}
    WHERE is_deleted = false AND LOWER(TRIM(bill_no)) = LOWER($1)
    ORDER BY uid DESC LIMIT 1
    `,
    [bill]
  );
  return row || null;
}

export async function insertGateEntry({
  bill_no,
  bill_dt,
  remarks,
  transporter_name,
  vehicle_number,
  created_by,
}) {
  const [row] = await dbQuery(
    `
    INSERT INTO ${T.GATE_ENTRY} (
      bill_no, bill_dt, remarks, transporter_name, vehicle_number,
      approved, approved_by, approved_at, created_by
    ) VALUES (
      $1, $2, $3, $4, $5,
      true, $6, NOW(), $6
    )
    RETURNING *
    `,
    [
      bill_no,
      bill_dt ?? null,
      remarks ?? null,
      transporter_name ?? null,
      vehicle_number ?? null,
      created_by,
    ]
  );
  return row;
}

export async function softDeleteGate(uid, deleted_by) {
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET is_deleted = true, deleted_by = $2, deleted_at = NOW(),
        updated_by = $2, updated_at = NOW()
    WHERE uid = $1 AND is_deleted = false
    RETURNING *
    `,
    [uid, deleted_by]
  );
  return row || null;
}

/** Update transporter / vehicle / remarks on an existing gate entry. */
export async function updateGateEntryMeta(uid, { remarks, transporter_name, vehicle_number, updated_by }) {
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET
      remarks = $2,
      transporter_name = $3,
      vehicle_number = $4,
      updated_by = $5,
      updated_at = NOW()
    WHERE uid = $1 AND is_deleted = false
    RETURNING *
    `,
    [
      uid,
      remarks ?? null,
      transporter_name ?? null,
      vehicle_number ?? null,
      updated_by,
    ]
  );
  return row || null;
}
