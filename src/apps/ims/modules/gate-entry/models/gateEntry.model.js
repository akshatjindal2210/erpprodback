import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

const PENDING_WHERE = `
  o.is_deleted = false
  AND o.approved = true
  AND o.entry_type = 'forwarding_note'
  AND o.fuid IS NOT NULL
  AND (g.uid IS NULL OR g.approved = false)
`;

/** Join draft/approved gate to an out via scanned boxes or item-wise bill. */
const GATE_JOIN = `
  LEFT JOIN ${T.GATE_ENTRY} g
    ON g.is_deleted = false
   AND (
     EXISTS (
       SELECT 1
       FROM ${T.GATE_ENTRY_SCANNED_BOX} sb
       INNER JOIN ${T.BOX_TABLE} b
         ON b.box_no_uid::text = sb.box_no_uid AND b.is_deleted = false
       WHERE sb.uid = g.uid AND b.out_uid = o.out_uid
     )
     OR EXISTS (
       SELECT 1
       FROM ${T.FORWARDING_NOTE_ITEM_WISE} fi
       WHERE fi.fuid = o.fuid
         AND fi.is_deleted = false
         AND NULLIF(TRIM(g.bill_no), '') IS NOT NULL
         AND LOWER(TRIM(fi.bill_no)) = LOWER(TRIM(g.bill_no))
     )
   )
`;

export async function findPendingGateRows() {
  return dbQuery(
    `
    SELECT
      o.out_uid, o.fuid, o.approved_at, o.total_qty,
      f.acc_code, f.transporter_name, f.vehicle_number, f.po_number,
      f.total_items, f.cartage, f.timestamp,
      f.created_by AS created_by_name, f.created_at,
      f.updated_by AS updated_by_name, f.updated_at,
      f.approved_by AS approved_by_name, f.approved_at AS fn_approved_at,
      COALESCE(
        g.bill_no,
        (
          SELECT string_agg(DISTINCT NULLIF(TRIM(fi.bill_no), ''), ', ')
          FROM ${T.FORWARDING_NOTE_ITEM_WISE} fi
          WHERE fi.fuid = f.fuid AND fi.is_deleted = false
            AND NULLIF(TRIM(fi.bill_no), '') IS NOT NULL
        )
      ) AS bill_no,
      COALESCE(
        g.bill_dt,
        (
          SELECT MAX(NULLIF(TRIM(fi.bill_dt), ''))
          FROM ${T.FORWARDING_NOTE_ITEM_WISE} fi
          WHERE fi.fuid = f.fuid AND fi.is_deleted = false
            AND NULLIF(TRIM(fi.bill_dt), '') IS NOT NULL
        )
      ) AS bill_dt,
      g.uid,
      g.scan_complete AS gate_scan_complete,
      g.approved AS gate_approved
    FROM ${T.OUT_ENTRY} o
    INNER JOIN ${T.FORWARDING_NOTE_MASTER} f
      ON f.fuid = o.fuid AND f.is_deleted = false
    ${GATE_JOIN}
    WHERE ${PENDING_WHERE}
    ORDER BY o.approved_at DESC NULLS LAST, o.out_uid DESC
    `
  );
}

export async function findGateRows() {
  return dbQuery(
    `
    SELECT
      g.*,
      x.out_uid, x.fuid, x.total_qty,
      f.acc_code, f.transporter_name, f.vehicle_number, f.po_number, f.total_items
    FROM ${T.GATE_ENTRY} g
    LEFT JOIN LATERAL (
      SELECT b.out_uid, o.fuid, o.total_qty
      FROM ${T.GATE_ENTRY_SCANNED_BOX} sb
      INNER JOIN ${T.BOX_TABLE} b
        ON b.box_no_uid::text = sb.box_no_uid AND b.is_deleted = false
      INNER JOIN ${T.OUT_ENTRY} o ON o.out_uid = b.out_uid AND o.is_deleted = false
      WHERE sb.uid = g.uid
      LIMIT 1
    ) x ON true
    LEFT JOIN ${T.FORWARDING_NOTE_MASTER} f
      ON f.fuid = x.fuid AND f.is_deleted = false
    WHERE g.is_deleted = false
    ORDER BY g.uid DESC
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

/** Find pending approved store-out by out_uid, bill, or packing numbers. */
export async function findPendingOut({ out_uid, bill_no, packing_numbers = [] } = {}) {
  const params = [];
  let extra = "";

  if (out_uid != null && out_uid !== "") {
    params.push(Number(out_uid));
    extra = `AND o.out_uid = $${params.length}`;
  } else if (bill_no != null && String(bill_no).trim()) {
    params.push(String(bill_no).trim());
    extra = `
      AND (
        EXISTS (
          SELECT 1 FROM ${T.FORWARDING_NOTE_ITEM_WISE} fi
          WHERE fi.fuid = f.fuid AND fi.is_deleted = false
            AND LOWER(TRIM(fi.bill_no)) = LOWER($${params.length})
        )
        OR EXISTS (
          SELECT 1 FROM ${T.GATE_ENTRY} gx
          INNER JOIN ${T.GATE_ENTRY_SCANNED_BOX} sb ON sb.uid = gx.uid
          INNER JOIN ${T.BOX_TABLE} b
            ON b.box_no_uid::text = sb.box_no_uid AND b.is_deleted = false
          WHERE gx.is_deleted = false AND gx.approved = false
            AND LOWER(TRIM(gx.bill_no)) = LOWER($${params.length})
            AND b.out_uid = o.out_uid
        )
      )
    `;
  } else if (Array.isArray(packing_numbers) && packing_numbers.length) {
    const packs = [...new Set(packing_numbers.map((p) => String(p).trim()).filter(Boolean))];
    if (!packs.length) return null;
    params.push(packs);
    extra = `
      AND EXISTS (
        SELECT 1 FROM ${T.FORWARDING_NOTE_ITEM_WISE} fi
        WHERE fi.fuid = f.fuid AND fi.is_deleted = false
          AND TRIM(fi.packing_number::text) = ANY($${params.length}::text[])
      )
    `;
  } else {
    return null;
  }

  const [row] = await dbQuery(
    `
    SELECT o.out_uid, o.fuid, g.uid, g.scan_complete, g.approved,
           g.bill_no AS gate_bill_no, g.bill_dt AS gate_bill_dt
    FROM ${T.OUT_ENTRY} o
    INNER JOIN ${T.FORWARDING_NOTE_MASTER} f
      ON f.fuid = o.fuid AND f.is_deleted = false
    ${GATE_JOIN}
    WHERE ${PENDING_WHERE}
      ${extra}
    ORDER BY o.approved_at DESC NULLS LAST, o.out_uid DESC
    LIMIT 1
    `,
    params
  );
  return row || null;
}

/** Resolve out_uid / fuid from scanned boxes, else pending match, else out_uid. */
export async function resolveOutForGate({ uid, out_uid, bill_no, packing_numbers = [] } = {}) {
  if (uid) {
    const [row] = await dbQuery(
      `
      SELECT b.out_uid, o.fuid
      FROM ${T.GATE_ENTRY_SCANNED_BOX} sb
      INNER JOIN ${T.BOX_TABLE} b
        ON b.box_no_uid::text = sb.box_no_uid AND b.is_deleted = false
      INNER JOIN ${T.OUT_ENTRY} o ON o.out_uid = b.out_uid AND o.is_deleted = false
      WHERE sb.uid = $1
      LIMIT 1
      `,
      [uid]
    );
    if (row) return row;
  }

  if (out_uid != null && out_uid !== "") {
    const [row] = await dbQuery(
      `
      SELECT o.out_uid, o.fuid
      FROM ${T.OUT_ENTRY} o
      WHERE o.out_uid = $1 AND o.is_deleted = false
      LIMIT 1
      `,
      [Number(out_uid)]
    );
    if (row) return row;
  }

  return findPendingOut({ bill_no, packing_numbers });
}

export async function insertGateDraft({ bill_no, bill_dt, remarks, created_by }) {
  const [row] = await dbQuery(
    `
    INSERT INTO ${T.GATE_ENTRY}
      (bill_no, bill_dt, remarks, scan_complete, approved, created_by)
    VALUES ($1, $2, $3, false, false, $4)
    RETURNING *
    `,
    [bill_no, bill_dt, remarks ?? null, created_by]
  );
  return row;
}

export async function updateGateDraft(uid, { bill_no, bill_dt, remarks, scan_complete, updated_by }) {
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET bill_no = COALESCE($2, bill_no),
        bill_dt = COALESCE($3, bill_dt),
        remarks = COALESCE($4, remarks),
        scan_complete = COALESCE($5, scan_complete),
        updated_by = $6,
        updated_at = NOW()
    WHERE uid = $1 AND is_deleted = false AND approved = false
    RETURNING *
    `,
    [uid, bill_no ?? null, bill_dt ?? null, remarks ?? null, scan_complete ?? null, updated_by]
  );
  return row || null;
}

export async function findOutBoxes(out_uid) {
  if (!out_uid) return [];
  return dbQuery(
    `
    SELECT b.box_no_uid::text AS box_no_uid, b.packing_number, b.is_loose, b.qty, b.out_uid
    FROM ${T.BOX_TABLE} b
    WHERE b.out_uid = $1 AND b.is_deleted = false
    ORDER BY b.packing_number NULLS LAST, b.box_uid ASC
    `,
    [out_uid]
  );
}

export async function findScannedBoxes(uid) {
  if (!uid) return [];
  const rows = await dbQuery(
    `SELECT box_no_uid::text AS box_no_uid FROM ${T.GATE_ENTRY_SCANNED_BOX} WHERE uid = $1 ORDER BY box_no_uid`,
    [uid]
  );
  return (rows || []).map((r) => String(r.box_no_uid).trim()).filter(Boolean);
}

export async function replaceScannedBoxes(uid, scanned_boxes = []) {
  if (!uid) return [];
  await dbQuery(`DELETE FROM ${T.GATE_ENTRY_SCANNED_BOX} WHERE uid = $1`, [uid]);
  const list = [...new Set((scanned_boxes || []).map((u) => String(u).trim()).filter(Boolean))];
  if (!list.length) return [];
  const values = [];
  const placeholders = list.map((box, i) => {
    values.push(uid, box);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  });
  await dbQuery(
    `INSERT INTO ${T.GATE_ENTRY_SCANNED_BOX} (uid, box_no_uid) VALUES ${placeholders.join(", ")}`,
    values
  );
  return list;
}

export async function findFnItemIds(fuid) {
  if (!fuid) return [];
  const rows = await dbQuery(
    `SELECT id FROM ${T.FORWARDING_NOTE_ITEM_WISE} WHERE fuid = $1 AND is_deleted = false ORDER BY id`,
    [fuid]
  );
  return (rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
}

export async function findFnItems(fuid) {
  if (!fuid) return [];
  return dbQuery(
    `
    SELECT id, packing_number, item_dcode, total_qty, bill_no, bill_dt
    FROM ${T.FORWARDING_NOTE_ITEM_WISE}
    WHERE fuid = $1 AND is_deleted = false
    ORDER BY id
    `,
    [fuid]
  );
}

export async function findFnDispatch(fuid) {
  if (!fuid) return null;
  const [row] = await dbQuery(
    `
    SELECT fuid, acc_code, transporter_name, vehicle_number, po_number, total_items
    FROM ${T.FORWARDING_NOTE_MASTER}
    WHERE fuid = $1 AND is_deleted = false
    LIMIT 1
    `,
    [fuid]
  );
  return row || null;
}

export async function approveGate(uid, approved_by) {
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET approved = true, approved_by = $2, approved_at = NOW(),
        scan_complete = true, updated_by = $2, updated_at = NOW()
    WHERE uid = $1 AND is_deleted = false AND approved = false
    RETURNING *
    `,
    [uid, approved_by]
  );
  return row || null;
}

export async function softDeleteGate(uid, deleted_by) {
  const [row] = await dbQuery(
    `
    UPDATE ${T.GATE_ENTRY}
    SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
    WHERE uid = $1 AND is_deleted = false AND approved = false
    RETURNING uid
    `,
    [uid, deleted_by]
  );
  if (row) {
    await dbQuery(`DELETE FROM ${T.GATE_ENTRY_SCANNED_BOX} WHERE uid = $1`, [uid]);
  }
  return row || null;
}
