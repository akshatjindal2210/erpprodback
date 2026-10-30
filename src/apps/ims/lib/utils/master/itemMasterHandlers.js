import { fetchFromIMS } from "../../services/ims.service.js";

/** Purchase/Production Product Master — `item` + `{ type }` only. */
export function itemMasterHandlers(type) {
  const load = () => fetchFromIMS("item", { type });
  const idOf = (r) => r.ItemDcode ?? r.Itemdcode ?? r.itemdcode;
  const view = (r) => {
    const id = idOf(r);
    return {
      id,
      itemdcode: id,
      item_code: r.Item_Code ?? r.item_code,
      itemdesc: r.ItemDesc ?? r.Itemdesc ?? r.itemdesc,
      grpname: r.Grpname ?? r.grpname ?? null,
    };
  };

  return {
    getItems: async (_req, res) => {
      try {
        const data = await load();
        res.json({ success: true, data, total: data.length });
      } catch (e) {
        res.status(500).json({ success: false, message: e.message });
      }
    },
    getItemById: async (req, res) => {
      try {
        const { id } = req.body || {};
        if (!id) return res.json({ success: true, data: null });
        const data = await load();
        res.json({ success: true, data: data.find((r) => String(idOf(r)) === String(id)) || null });
      } catch (e) {
        res.status(500).json({ success: false, message: e.message });
      }
    },
    getItemsViews: async (req, res) => {
      try {
        const { id } = req.body || {};
        const data = await load();
        if (id) {
          const row = data.find((r) => String(idOf(r)) === String(id));
          return res.json({ success: true, data: row ? view(row) : null });
        }
        const views = data.map(view);
        res.json({ success: true, data: views, total: views.length });
      } catch (e) {
        res.status(500).json({ success: false, message: e.message });
      }
    },
  };
}
