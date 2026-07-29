import { findCoilTransactions } from "../models/coilTransaction.model.js";
import { listCoilDownloadLogs } from "../../../modules/coil/models/coilDownloadLog.model.js";
import { findCoilsByUids } from "../../../modules/coil/models/coil.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { COIL_TX_TYPE_LABELS } from "../../../lib/constants/coilTransactionTypes.js";
import { hydrateCoilTransactionStickerEntries } from "../../../lib/utils/transactions/coilTransactionDetails.js";

export const listCoilTransactionLogs = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search, isExport } = extractListParams(req.body || {}, {
      sortBy: "created_at",
      order: "DESC",
    });
    const result = await findCoilTransactions({
      filters: sanitizeFilters(filters || {}, [
        "from_date", "to_date", "fromDate", "toDate",
        "transaction_type", "source_module", "mrn_no", "journey",
      ]),
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: isExport === "true" ? 1 : page,
      limit: isExport === "true" ? 100000 : (limit || 100),
      permission: req.permission,
    });

    const rows = result.data || [];
    const allUids = new Set();
    for (const row of rows) {
      const d = typeof row.details === "string"
        ? (() => { try { return JSON.parse(row.details); } catch { return {}; } })()
        : (row.details || {});
      if (Array.isArray(d.coil_no_uids)) {
        d.coil_no_uids.forEach((uid) => {
          if (uid != null) allUids.add(String(uid));
        });
      }
      if (d.coil_no_uid) allUids.add(String(d.coil_no_uid));
    }

    let coilsMap = new Map();
    if (allUids.size > 0) {
      const coils = await findCoilsByUids(Array.from(allUids));
      for (const coil of coils || []) {
        if (coil.coil_no_uid) coilsMap.set(String(coil.coil_no_uid), coil);
      }
    }

    const findCoilsBatch = async (uids) =>
      uids.map((uid) => coilsMap.get(String(uid))).filter(Boolean);

    const data = await Promise.all(
      rows.map((row) => hydrateCoilTransactionStickerEntries(row, findCoilsBatch))
    );

    return res.json({
      success: true,
      ...result,
      data,
      typeLabels: COIL_TX_TYPE_LABELS,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const listCoilDownloadLog = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "downloaded_at",
      order: "DESC",
    });
    const result = await listCoilDownloadLogs({
      filters: sanitizeFilters(filters || {}, ["from_date", "to_date", "journey", "download_type"]),
      search: sanitizeSearch(search),
      page,
      limit: limit || 100,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
