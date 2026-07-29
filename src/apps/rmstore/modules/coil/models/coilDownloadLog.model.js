import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { logCoilTransaction } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import {
  buildCoilTxJourneyFilter,
  hasCoilJourneyFilter,
} from "../../../lib/utils/logJourneyFilter.js";

const TBL = T.COIL_TRANSACTION;

function textOrNull(val, max = 0) {
  if (val == null || String(val).trim() === "") return null;
  const s = String(val).trim();
  return max > 0 ? s.slice(0, max) : s;
}

/** Map tx row → IMS-compatible sticker download list shape. */
function mapDownloadRow(row) {
  if (!row) return null;
  const d = row.details && typeof row.details === "object" ? row.details : {};
  const type = String(d.download_type ?? "single").toLowerCase();
  const isBulk = type === "bulk" || type === "bulk_qc" || type === "batch_qc";
  const coilUid = d.coil_no_uid ?? (Array.isArray(d.coil_no_uids) ? d.coil_no_uids[0] : null) ?? null;
  const stickerCount = Number(d.sticker_count) || (isBulk ? 0 : 1) || 1;
  const mrn = row.mrn_no ?? null;
  const downloadedBy = row.user_name ?? null;
  const downloadedAt = row.created_at;
  const source = d.download_source ?? row.source_module ?? null;

  return {
    log_id: row.id,
    coil_no_uid: coilUid,
    mrn_no: mrn,
    packing_number: mrn != null ? String(mrn) : null,
    heat_no: d.heat_no ?? null,
    item_code: d.item_code ?? null,
    itemdcode: d.item_dcode ?? null,
    acc_name: d.acc_name ?? null,
    downloaded_by: downloadedBy,
    downloaded_at: downloadedAt,
    download_type: type,
    sticker_count: stickerCount,
    download_source: source,
    // IMS Sticker Download Logs column aliases
    primary_label: isBulk ? "ALL" : (coilUid ? String(coilUid) : `log-${row.id}`),
    last_download_type: type,
    last_bulk_sticker_count: stickerCount,
    event_sticker_count: stickerCount,
    last_downloaded_by_name: downloadedBy,
    last_downloaded_at: downloadedAt,
  };
}

/** Sticker download row → coil_transaction (type=sticker_download). */
export async function insertCoilDownloadLog({
  coil_no_uid = null,
  mrn_no = null,
  heat_no = null,
  item_code = null,
  acc_name = null,
  downloaded_by,
  download_type = "single",
  sticker_count = 1,
  download_source = null,
}) {
  const type = String(download_type || "single").toLowerCase();
  const isBulk = type === "bulk" || type === "bulk_qc";
  const uid = isBulk ? null : textOrNull(coil_no_uid, 120);
  const mrn = textOrNull(mrn_no, 50);

  if (!isBulk && !uid && type !== "batch_qc") {
    throw new Error("Coil UID is required for a single or QC sticker download.");
  }
  if (isBulk && !mrn) {
    throw new Error("MRN number is required for a bulk sticker download.");
  }

  const count = Math.max(1, Number(sticker_count) || 1);

  await logCoilTransaction({
    transaction_type: COIL_TX_TYPES.STICKER_DOWNLOAD,
    source_module: textOrNull(download_source, 48) || "sticker",
    source_id: uid || mrn,
    mrn_no: mrn,
    user_name: downloaded_by ?? "unknown",
    details: {
      download_type: type,
      sticker_count: isBulk || type === "batch_qc" ? count : 1,
      coil_no_uid: uid,
      coil_no_uids: uid ? [uid] : [],
      heat_no: textOrNull(heat_no, 100),
      item_code: textOrNull(item_code, 100),
      acc_name: textOrNull(acc_name),
      download_source: textOrNull(download_source, 48),
    },
  });

  return {
    coil_no_uid: uid,
    mrn_no: mrn,
    heat_no: textOrNull(heat_no, 100),
    item_code: textOrNull(item_code, 100),
    acc_name: textOrNull(acc_name),
    downloaded_by: downloaded_by ?? "unknown",
    download_type: type,
    sticker_count: isBulk || type === "batch_qc" ? count : 1,
    download_source: textOrNull(download_source, 48),
  };
}

export async function listCoilDownloadLogs(options = {}) {
  const { filters = {}, search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [`l.transaction_type = $${i++}`];
  values.push(COIL_TX_TYPES.STICKER_DOWNLOAD);

  let cte = "";
  const journeyMode = hasCoilJourneyFilter(filters);
  if (journeyMode) {
    const built = buildCoilTxJourneyFilter({ alias: "tb", journey: filters.journey, values });
    if (built) {
      cte = `WITH ${built.cte}`;
      // rewrite alias tb → l in condition
      conditions.push(built.condition.replace(/\btb\./g, "l."));
      i = values.length + 1;
    }
  } else {
    if (filters.from_date) {
      values.push(filters.from_date);
      conditions.push(`l.created_at >= $${i++}::timestamp`);
    }
    if (filters.to_date) {
      values.push(filters.to_date);
      conditions.push(`l.created_at <= $${i++}::timestamp`);
    }
  }

  if (filters.download_type) {
    values.push(String(filters.download_type).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(l.details->>'download_type','')) = $${i++}`);
  }
  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(l.mrn_no,'') ILIKE $${idx} OR
      COALESCE(l.user_name,'') ILIKE $${idx} OR
      COALESCE(l.source_module,'') ILIKE $${idx} OR
      COALESCE(l.details->>'coil_no_uid','') ILIKE $${idx} OR
      COALESCE(l.details->>'heat_no','') ILIKE $${idx} OR
      COALESCE(l.details->>'item_code','') ILIKE $${idx} OR
      COALESCE(l.details->>'acc_name','') ILIKE $${idx} OR
      COALESCE(l.details->>'download_type','') ILIKE $${idx} OR
      COALESCE(l.details->>'download_source','') ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(
    `${cte ? `${cte} ` : ""}SELECT COUNT(*)::int AS count FROM ${TBL} l ${where}`,
    values
  );
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `${cte ? `${cte} ` : ""}SELECT l.*
     FROM ${TBL} l
     ${where}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: (rows || []).map(mapDownloadRow),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
}
