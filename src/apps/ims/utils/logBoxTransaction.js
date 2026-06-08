import dbQuery from "../../../config/db.js";
import { BOX_TX_TYPES } from "../constants/boxTransactionTypes.js";
import { buildBoxLogDetails } from "./boxTransactionDetails.js";

/** One packing when all rows share it; else null. */
export function singlePackingFromRows(rows = []) {
  const seen = new Set();
  for (const r of rows) {
    const pn = r?.packing_number;
    if (pn != null && String(pn).trim() !== "") seen.add(String(pn).trim());
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/**
 * source_module = kis feature se (packing_entry, inventory_inward, ims_out_entry, ims_stock_adjustment)
 * source_id     = us record ki id (in_uid, out_uid, adjustment_id, packing no)
 * transaction_type = kya hua (inward_link, sa_stock_in, out_link, …)
 */
export async function logBoxTransaction({ client = null, transaction_type, source_module, source_id = null, packing_number = null, user_id = null, details = {}, rows = [] }) {
  if (!transaction_type || !source_module) return;

  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  const merged = buildBoxLogDetails(rows, details);
  const detailsJson = JSON.stringify(merged);

  await run(
    `INSERT INTO ims_transaction_box
      (transaction_type, source_module, source_id, packing_number, user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      String(transaction_type),
      String(source_module),
      source_id != null && source_id !== "" ? String(source_id) : null,
      packing_number != null && packing_number !== "" ? String(packing_number) : null,
      user_id != null && user_id !== "" ? Number(user_id) : null,
      detailsJson,
    ]
  );
}

export function logBoxTransactionSafe(payload) {
  logBoxTransaction(payload).catch((err) => {
    console.error("[ims_transaction_box] log failed:", err?.message || err);
  });
}

/** One inward save → one log row (all locations combined). */
export function logInwardLinkBatch({ in_uid, userId, rowGroups = [] }) {
  const rows = rowGroups.flat().filter(Boolean);
  if (!rows.length) return;
  logBoxTransactionSafe({
    transaction_type: BOX_TX_TYPES.INWARD_LINK,
    source_module: "inventory_inward",
    source_id: String(in_uid),
    packing_number: singlePackingFromRows(rows),
    user_id: userId,
    rows,
    details: {
      in_uid,
      location_count: rowGroups.filter((g) => g?.length).length,
      packing_numbers: [...new Set(rows.map((r) => r.packing_number).filter(Boolean))],
    },
  });
}

/** Customer override applied on one or more boxes (sticker customer updated). */
export function logOverrideCustomerBatch({request_id = null, user_id = null, boxes = [], from_customer = null, to_customer = null, remarks = null}) {
  const rows = Array.isArray(boxes) ? boxes.filter(Boolean) : [];
  if (!rows.length) return;
  logBoxTransactionSafe({
    transaction_type: BOX_TX_TYPES.OVERRIDE_CUSTOMER,
    source_module: "change_override_customer",
    source_id: request_id != null && request_id !== "" ? String(request_id) : null,
    packing_number: singlePackingFromRows(rows),
    user_id,
    rows,
    details: {
      from_customer:
        from_customer != null && String(from_customer).trim() !== ""
          ? String(from_customer).trim()
          : null,
      to_customer:
        to_customer != null && String(to_customer).trim() !== ""
          ? String(to_customer).trim()
          : null,
      remarks: remarks != null && String(remarks).trim() !== "" ? String(remarks).trim() : undefined,
      request_id: request_id != null ? request_id : undefined,
    },
  });
}
