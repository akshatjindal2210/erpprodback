import { fetchFromIMS } from "../../services/ims.service.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";

const IMS_IN_MEMORY_MAX_LIMIT = 100000;

function mapItemRecord(r) {
  return {
    itemdcode: r.ItemDcode ?? r.Itemdcode ?? r.itemdcode,
    item_code: r.Item_Code ?? r.item_code,
    itemdesc: r.ItemDesc ?? r.Itemdesc ?? r.itemdesc,
    grpname: r.Grpname ?? r.grpname,
    minqty: r.minqty ?? r.Minqty ?? 0,
    maxqty: r.maxqty ?? r.Maxqty ?? 0,
    reorderqty: r.Reorderqty ?? r.reorderqty ?? 0,
    primitemdcode: r.PrimItemdcode ?? r.primitemdcode,
    primitem_code: r.primitem_code ?? r.Primitem_code ?? r.PrimItem_Code ?? null,
    primitemdesc: r.PrimItemdesc ?? r.primItemDesc ?? r.primitemdesc ?? null,
    weight: r.weight ?? r.Weight ?? null,
    apvitem: r.apvitem ?? r.Apvitem ?? r.ITAPV,
    unit: r.Unit ?? r.unit,
    category_id: r.Category_Id ?? r.category_id,
  };
}

function filterBySearch(rows, search, pickFields) {
  if (!search) return rows;
  const s = String(search).toLowerCase();
  return rows.filter((row) =>
    pickFields.some((fn) => {
      const v = fn(row);
      return v != null && String(v).toLowerCase().includes(s);
    })
  );
}

function slicePage(rows, page = 1, limit = 50) {
  const total = rows.length;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const parsed = parseInt(limit, 10);
  const effectiveLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : total > 0 ? total : 50;
  const safeLimit = Math.min(IMS_IN_MEMORY_MAX_LIMIT, Math.max(1, effectiveLimit));
  const start = (safePage - 1) * safeLimit;
  return {
    data: rows.slice(start, start + safeLimit),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  };
}

function itemFetchIsFg(filters) {
  if (filters === "fg") return true;
  if (filters && typeof filters === "object") {
    return filters.type === "fg" || filters.fg === true;
  }
  return false;
}

export function createGroupMasterControllers({ groupName }) {
  const lockedGroup = String(groupName || "").trim();
  const lockedNeedle = lockedGroup.toLowerCase();
  const matchesLockedGroup = (row) => String(row?.grpname ?? "").trim().toLowerCase() === lockedNeedle;

  const getItems = async (req, res) => {
    try {
      const records = await fetchFromIMS("item");
      const rows = (Array.isArray(records) ? records : []).map(mapItemRecord).filter(matchesLockedGroup);
      res.json({ success: true, data: rows, total: rows.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };

  const getItemById = async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.json({ success: true, data: null });
      const records = await fetchFromIMS("item");
      const raw = (records || []).find((r) => String(r.ItemDcode ?? r.itemdcode) === String(id));
      if (!raw) return res.json({ success: true, data: null });
      const item = mapItemRecord(raw);
      if (!matchesLockedGroup(item)) return res.json({ success: true, data: null });
      res.json({ success: true, data: item });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };

  const getItemsViews = async (req, res) => {
    try {
      const { id } = req.body;
      const { page, limit, search, filters } = extractListParams(req.body);
      const records = await fetchFromIMS("item", itemFetchIsFg(filters) ? { type: "fg" } : null);
      const rows = (records || []).map(mapItemRecord).filter(matchesLockedGroup);

      if (id) {
        const item = rows.find((r) => String(r.itemdcode) === String(id));
        if (!item) return res.json({ success: true, data: null });
        return res.json({
          success: true,
          data: {
            id: item.itemdcode,
            itemdcode: item.itemdcode,
            item_code: item.item_code,
            itemdesc: item.itemdesc,
            grpname: item.grpname ?? null,
          },
        });
      }

      let filtered = rows;
      const s = sanitizeSearch(search);
      if (s) {
        filtered = filterBySearch(filtered, s, [(r) => r.itemdcode, (r) => r.item_code, (r) => r.itemdesc, (r) => r.grpname]);
      }

      const out = slicePage(filtered, page || 1, limit || filtered.length || 1000);
      res.json({
        success: true,
        data: out.data.map((item) => ({
          id: item.itemdcode,
          itemdcode: item.itemdcode,
          item_code: item.item_code,
          itemdesc: item.itemdesc,
          grpname: item.grpname ?? null,
        })),
        total: out.total,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };

  return { getItems, getItemById, getItemsViews };
}
