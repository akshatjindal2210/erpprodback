import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { filterItemsBySearch, slicePage } from "../../production/utils/erpItems.js";

function mapItemRecord(r) {
  const itemdcode = r.ItemDcode ?? r.Itemdcode ?? r.itemdcode ?? null;
  return {
    id: itemdcode,
    itemdcode,
    item_code: r.Item_Code ?? r.item_code ?? null,
    itemdesc: r.ItemDesc ?? r.Itemdesc ?? r.itemdesc ?? null,
    grpname: r.Grpname ?? r.grpname ?? null,
    minqty: r.minqty ?? r.Minqty ?? 0,
    maxqty: r.maxqty ?? r.Maxqty ?? 0,
    reorderqty: r.Reorderqty ?? r.reorderqty ?? 0,
    primitem_code: r.primitem_code ?? r.Primitem_code ?? r.PrimItem_Code ?? null,
    primitemdesc: r.PrimItemdesc ?? r.primItemDesc ?? r.primitemdesc ?? null,
    weight: r.weight ?? r.Weight ?? null,
    apvitem: r.apvitem ?? r.Apvitem ?? r.ITAPV ?? null,
  };
}

export const getRmProducts = async (req, res) => {
  try {
    const records = await fetchFromIMS("item", { type: "rm" });
    const rows = (Array.isArray(records) ? records : []).map(mapItemRecord);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getRmProductById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.json({ success: true, data: null });
    const records = await fetchFromIMS("item", { type: "rm" });
    const raw = (records || []).find((r) => String(r.ItemDcode) === String(id));
    if (!raw) return res.json({ success: true, data: null });
    res.json({ success: true, data: mapItemRecord(raw) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

function toHelperRow(item) {
  return {
    id: item.itemdcode,
    itemdcode: item.itemdcode,
    item_code: item.item_code,
    itemdesc: item.itemdesc,
    grpname: item.grpname,
  };
}

export const getRmProductsViews = async (req, res) => {
  try {
    const { id, ids } = req.body || {};
    const { page, limit, search } = extractListParams(req.body || {});
    const records = await fetchFromIMS("item", { type: "rm" });
    const rows = (Array.isArray(records) ? records : []).map(mapItemRecord);

    if (id != null && id !== "") {
      const match = rows.find((r) => String(r.itemdcode) === String(id));
      return res.json({ success: true, data: match ? toHelperRow(match) : null });
    }

    if (Array.isArray(ids) && ids.length) {
      const set = new Set(ids.map(String));
      return res.json({ success: true, data: rows.filter((r) => set.has(String(r.itemdcode))).map(toHelperRow) });
    }

    const out = slicePage(filterItemsBySearch(rows, sanitizeSearch(search)), page, limit);
    res.json({ success: true, data: out.data.map(toHelperRow), total: out.total, page: out.page, limit: out.limit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
