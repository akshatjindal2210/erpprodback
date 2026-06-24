import { findTransactionBoxes } from "../models/transactionBox.model.js";
import { extractListParams, sanitizeFilters } from "../../core/utils/queryHelper.js";
import { getCrudModuleConfig } from "../../core/config/crudModules.js";
import { BOX_TX_TYPE_LABELS } from "../constants/boxTransactionTypes.js";
import {
  hydrateTransactionBoxStickerEntries,
} from "../utils/box/boxTransactionDetails.js";
import { findBoxesByUids } from "../models/box.model.js";

const CFG = getCrudModuleConfig("box_transaction_logs");

export const listTransactionBoxes = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC",
    });

    const result = await findTransactionBoxes(
      {
        filters: sanitizeFilters(filters, CFG.filterFields),
        search,
        sort: { by: sortBy, order },
        page,
        limit,
        fields: CFG.listFields,
        permission: req.permission,
      },
      req.user
    );

    // Batch hydration to avoid N+1 queries
    const rows = result.data || [];
    const allBoxUids = new Set();
    rows.forEach(row => {
      const d = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
      if (Array.isArray(d.box_uids)) {
        d.box_uids.forEach(uid => {
          if (uid != null) allBoxUids.add(String(uid));
        });
      }
    });

    let boxesMap = new Map();
    if (allBoxUids.size > 0) {
      const boxes = await findBoxesByUids(Array.from(allBoxUids));
      boxes.forEach(box => {
        if (box.box_uid) boxesMap.set(String(box.box_uid), box);
      });
    }

    const findBoxesBatch = async (uids) => {
      return uids.map(uid => boxesMap.get(String(uid))).filter(Boolean);
    };

    const data = await Promise.all(
      rows.map((row) => hydrateTransactionBoxStickerEntries(row, findBoxesBatch))
    );

    res.json({
      success: true,
      ...result,
      data,
      typeLabels: BOX_TX_TYPE_LABELS,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
