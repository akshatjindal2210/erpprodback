import dbQuery from "../../../../../config/db/db.js";
import { MST_TABLES as C, RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

function singleMrnFromRows(rows = []) {
  const seen = new Set();
  for (const r of rows) {
    const mrn = r?.mrn_no;
    if (mrn != null && String(mrn).trim() !== "") seen.add(String(mrn).trim());
  }
  return seen.size === 1 ? [...seen][0] : null;
}

function buildCoilLogDetails(rows = [], details = {}) {
  const coil_no_uids = [];
  const coil_sticker_entries = [];
  let total_qty = 0;
  let qtyKnown = false;

  for (const r of rows) {
    const uid = r?.coil_no_uid;
    if (uid != null && String(uid).trim() !== "") {
      const key = String(uid).trim();
      coil_no_uids.push(key);
      const qty = Number(r?.qty);
      const entry = { coil_no_uid: key };
      if (Number.isFinite(qty)) {
        entry.qty = qty;
        total_qty += qty;
        qtyKnown = true;
      }
      coil_sticker_entries.push(entry);
    }
  }

  return {
    ...details,
    coil_count: details.coil_count ?? coil_no_uids.length,
    coil_no_uids: details.coil_no_uids ?? [...new Set(coil_no_uids)],
    coil_sticker_entries: details.coil_sticker_entries ?? coil_sticker_entries,
    ...(qtyKnown && details.total_qty == null ? { total_qty } : {}),
  };
}

export async function logCoilTransaction({
  client = null,
  transaction_type,
  source_module,
  source_id = null,
  mrn_no = null,
  user_id = null,
  user_name = null,
  details = {},
  rows = [],
}) {
  if (!transaction_type || !source_module) return;

  const run = client?.query ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);

  let finalUserName = user_name;
  if (!finalUserName && user_id) {
    try {
      const [u] = await dbQuery(`SELECT name FROM ${C.USERS} WHERE id = $1 LIMIT 1`, [user_id]);
      if (u) finalUserName = u.name;
    } catch (err) {
      console.error("[logCoilTransaction] failed to fetch user name:", err.message);
    }
  }

  const resolvedMrn =
    mrn_no != null && String(mrn_no).trim() !== ""
      ? String(mrn_no).trim()
      : singleMrnFromRows(rows);

  const detailsJson = JSON.stringify(buildCoilLogDetails(rows, details));

  await run(
    `INSERT INTO ${T.COIL_TRANSACTION}
      (transaction_type, source_module, source_id, mrn_no, user_id, user_name, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      String(transaction_type),
      String(source_module),
      source_id != null && source_id !== "" ? String(source_id) : null,
      resolvedMrn,
      user_id != null && user_id !== "" ? Number(user_id) : null,
      finalUserName != null && finalUserName !== "" ? String(finalUserName) : null,
      detailsJson,
    ]
  );
}

export function logCoilTransactionSafe(payload) {
  logCoilTransaction(payload).catch((err) => {
    console.error("[rmstore_coil_transaction] log failed:", err?.message || err);
  });
}
