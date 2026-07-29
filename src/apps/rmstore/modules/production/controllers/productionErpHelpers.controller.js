import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { filterItemsBySearch, filterPrdRunJcBySearch, loadMappedItems, loadMappedPrdRunJc, slicePage, toPickerRow, toPrdRunJcPickerRow } from "../utils/erpItems.js";

async function handleItemHelper(req, res, { requestedData, filter = null }) {
  try {
    const { id } = req.body || {};
    const { page, limit, search } = extractListParams(req.body || {});

    const rows = await loadMappedItems(requestedData, filter);

    if (id != null && id !== "") {
      const item = rows.find((r) => String(r.itemdcode) === String(id));
      if (!item) return res.json({ success: true, data: null });
      return res.json({ success: true, data: toPickerRow(item) });
    }

    const filtered = filterItemsBySearch(rows, sanitizeSearch(search));
    const out = slicePage(filtered, page || 1, limit || filtered.length || 1000);

    return res.json({
      success: true,
      data: out.data.map(toPickerRow),
      total: out.total,
      page: out.page,
      limit: out.limit,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/** Production items — ERP `prdprimitem`. */
export const getProductionItemsViews = (req, res) =>
  handleItemHelper(req, res, { requestedData: "prdprimitem" });

/** RM items — ERP `item` with filter `{ type: "rm" }`. */
export const getRmItemsViews = (req, res) =>
  handleItemHelper(req, res, { requestedData: "item", filter: { type: "rm" } });

/** Production-run job cards — ERP `prdrunjc`. */
export const getPrdRunJcViews = async (req, res) => {
  try {
    const { id } = req.body || {};
    const { page, limit, search } = extractListParams(req.body || {});

    const rows = await loadMappedPrdRunJc();

    if (id != null && id !== "") {
      const row = rows.find((r) => String(r.pjobcardno) === String(id));
      if (!row) return res.json({ success: true, data: null });
      return res.json({ success: true, data: toPrdRunJcPickerRow(row) });
    }

    const filtered = filterPrdRunJcBySearch(rows, sanitizeSearch(search));
    const out = slicePage(filtered, page || 1, limit || filtered.length || 1000);

    return res.json({
      success: true,
      data: out.data.map(toPrdRunJcPickerRow),
      total: out.total,
      page: out.page,
      limit: out.limit,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
