import { findCoils, findCoilByUid } from "../models/coil.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";

export const getCoils = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body || {}, {
      sortBy: "coil_uid",
      order: "DESC",
    });
    const result = await findCoils({
      filters: sanitizeFilters(filters || {}, [
        "mrn_uid",
        "mrn_id",
        "mrn_no",
        "heat_no",
        "in_uid",
        "location_id",
        "coil_area",
        "stored",
        "status",
        "item_code",
        "item_dcode",
        "from_date",
        "to_date",
        "journey",
      ]),
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy,
      order,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getCoilByUid = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid || req.body?.uid || "").trim();
    if (!coil_no_uid) return res.status(400).json({ success: false, message: "Coil UID is required." });
    const data = await findCoilByUid(coil_no_uid);
    if (!data) return res.status(404).json({ success: false, message: "Coil not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
