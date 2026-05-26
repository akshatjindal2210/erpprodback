import { findTransactionBoxes } from "../models/transactionBox.model.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { BOX_TX_TYPE_LABELS } from "../constants/boxTransactionTypes.js";
import {
  hydrateTransactionBoxStickerEntries,
} from "../utils/boxTransactionDetails.js";
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

    const data = await Promise.all(
      (result.data || []).map((row) => hydrateTransactionBoxStickerEntries(row, findBoxesByUids))
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
