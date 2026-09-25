/**
 * Gate Entry model — independent (no Forwarding Note link).
 * Light row only; invmnote / invfnote always come live from IMS.
 */
import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

export async function findSavedGateBillSet() {
  const rows = await dbQuery(`SELECT LOWER(TRIM(bill_no)) AS bill_key FROM ${T.GATE_ENTRY} WHERE is_deleted = false AND NULLIF(TRIM(bill_no), '') IS NOT NULL`);
  return new Set((rows || []).map((r) => String(r.bill_key || "").trim()).filter(Boolean));
}

export async function findGateRows({ from_date, to_date, type, permission } = {}) {
  const values = [];
  let i = 1;
  const conditions = ["is_deleted = false"];

  const viewDays = Number(permission?.can_view_days);
  if (Number.isFinite(viewDays) && viewDays > 0) {
    const days = Math.max(1, Math.floor(viewDays)) - 1;
    conditions.push(`created_at >= CURRENT_DATE - INTERVAL '${days} days'`);
  }

  if (from_date) {
    values.push(from_date);
    conditions.push(`created_at >= $${i++}`);
  }
  if (to_date) {
    values.push(to_date);
    conditions.push(`created_at <= $${i++}`);
  }

  const typeVal = String(type || "").trim().toLowerCase();
  if (typeVal && typeVal !== "all") {
    values.push(typeVal);
    conditions.push(`LOWER(COALESCE(type, 'out')) = $${i++}`);
  }

  return dbQuery(
    `
    SELECT
      uid, type, bill_no, bill_dt, remarks, transporter_name, vehicle_number, created_by, created_at, updated_by, updated_at, approved_at
    FROM ${T.GATE_ENTRY}
    WHERE ${conditions.join(" AND ")}
    ORDER BY uid DESC
    `,
    values
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

/** Preview next OUT-/IN- id before save (MAX+1). Actual uid still comes from INSERT. */
export async function findNextGateUid() {
  const [row] = await dbQuery(`SELECT COALESCE(MAX(uid), 0)::int + 1 AS next_uid FROM ${T.GATE_ENTRY}`);
  const n = Number(row?.next_uid);
  return Number.isFinite(n) && n > 0 ? n : 1;
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

const IR_GATE_SELECT = `
  uid, type, bill_no, bill_dt, remarks, transporter_name, vehicle_number,
  created_by, created_at, updated_by, updated_at, approved_at,
  invoice_matched, receiving_file, receiving_meta
`;

/** Gate Out rows not yet invoice-received (IR Pending). */
export async function findUnmatchedOutGateRows() {
  return dbQuery(
    `
    SELECT ${IR_GATE_SELECT}
    FROM ${T.GATE_ENTRY}
    WHERE is_deleted = false
      AND LOWER(COALESCE(type, 'out')) = 'out'
      AND invoice_matched = false
      AND NULLIF(TRIM(bill_no), '') IS NOT NULL
    ORDER BY uid DESC
    `
  );
}

/**
 * Gate Out rows with invoice receiving saved (IR Register).
 * Date filter = Gate Entry created_at (IR does not change updated_at).
 */
export async function findMatchedOutGateRows({ from_date, to_date } = {}) {
  const values = [];
  let i = 1;
  const conditions = [
    "is_deleted = false",
    "LOWER(COALESCE(type, 'out')) = 'out'",
    "invoice_matched = true",
    "NULLIF(TRIM(COALESCE(receiving_file, '')), '') IS NOT NULL",
  ];

  const dateExpr = `(created_at AT TIME ZONE 'Asia/Kolkata')::date`;

  if (from_date) {
    values.push(String(from_date).slice(0, 10));
    conditions.push(`${dateExpr} >= $${i++}::date`);
  }
  if (to_date) {
    values.push(String(to_date).slice(0, 10));
    conditions.push(`${dateExpr} <= $${i++}::date`);
  }

  return dbQuery(
    `
    SELECT ${IR_GATE_SELECT}
    FROM ${T.GATE_ENTRY}
    WHERE ${conditions.join(" AND ")}
    ORDER BY uid DESC
    `,
    values
  );
}

/** Save invoice receiving attachment + audit meta on the gate row (no ERP).
 * Does NOT touch Gate Entry updated_at / updated_by — IR-only columns. */
export async function saveGateInvoiceReceiving(bill_no, { receiving_file, receiving_meta }) {
  const bill = String(bill_no || "").trim();
  if (!bill) return null;
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET
      invoice_matched = true,
      receiving_file = $2,
      receiving_meta = $3
    WHERE is_deleted = false
      AND LOWER(TRIM(bill_no)) = LOWER($1)
    RETURNING *
    `,
    [bill, receiving_file ?? null, receiving_meta ?? null]
  );
  return row || null;
}

/** Clear invoice receiving on gate — row returns to IR Pending.
 * Does NOT touch Gate Entry updated_at / updated_by. */
export async function clearGateInvoiceReceiving(bill_no) {
  const bill = String(bill_no || "").trim();
  if (!bill) return null;
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET
      invoice_matched = false,
      receiving_file = NULL,
      receiving_meta = NULL
    WHERE is_deleted = false
      AND LOWER(TRIM(bill_no)) = LOWER($1)
    RETURNING *
    `,
    [bill]
  );
  return row || null;
}
