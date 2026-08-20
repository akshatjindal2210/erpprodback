import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { filterItemsBySearch, filterPrdRunJcBySearch, loadMappedItems, loadMappedPrdRunJc, slicePage, toPickerRow, toPrdRunJcPickerRow } from "../utils/erpItems.js";

// Common Generic Runner
async function fetchAndPaginate(req, res, loader, filterFn, mapper, idKey) {
  try {
    const { id, ids } = req.body || {};
    const { page, limit, search } = extractListParams(req.body || {});
    const rows = await loader();

    // 1. Single ID
    if (id != null && id !== "") {
      const match = rows.find(r => String(r[idKey]) === String(id));
      return res.json({ success: true, data: match ? mapper(match) : null });
    }

    // 2. Multiple IDs
    if (Array.isArray(ids) && ids.length) {
      const set = new Set(ids.map(String));
      return res.json({ success: true, data: rows.filter(r => set.has(String(r[idKey]))).map(mapper) });
    }

    // 3. Search & Pagination
    const filtered = filterFn(rows, sanitizeSearch(search));
    const out = slicePage(filtered, page, limit);

    return res.json({
      success: true,
      data: out.data.map(mapper),
      total: out.total,
      page: out.page,
      limit: out.limit,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Exported Handlers
export const getProductionItemsViews = (req, res) =>
  fetchAndPaginate(req, res, () => loadMappedItems("prdprimitem"), filterItemsBySearch, toPickerRow, "itemdcode");

export const getRmItemsViews = (req, res) =>
  fetchAndPaginate(req, res, () => loadMappedItems("item", { type: "rm" }), filterItemsBySearch, toPickerRow, "itemdcode");

export const getPrdRunJcViews = (req, res) =>
  fetchAndPaginate(req, res, loadMappedPrdRunJc, filterPrdRunJcBySearch, toPrdRunJcPickerRow, "pjobcardno");