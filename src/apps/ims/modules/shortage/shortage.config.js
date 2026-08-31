import { IMS_TABLES as T } from "../../../../config/db/dbTables.js";

export const SHORTAGE_TYPES = ["PPC", "Deviation", "Additional"];

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Store as DATE (calendar day). Accepts YYYY-MM-DD, YYYY-MM, or ISO datetime.
 * YYYY-MM → that month's 1st; missing → today's date.
 */
export function normalizeShortageMonth(value, fallbackDate) {
  const pick = (rawIn) => {
    if (rawIn == null) return null;
    if (rawIn instanceof Date && !Number.isNaN(rawIn.getTime())) {
      const y = rawIn.getUTCFullYear();
      const m = String(rawIn.getUTCMonth() + 1).padStart(2, "0");
      const d = String(rawIn.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const raw = String(rawIn).trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
    return null;
  };

  return pick(value) || pick(fallbackDate) || todayYmd();
}
export const shortageCrudConfig = {
  table: T.SHORTAGE,
  alias: "s",
  idField: "id",
  entity: "shortage",
  defaultSort: { by: "id", order: "DESC" },
  fields: {
    itemdcode: { type: "int", required: true, filter: true, search: true },
    itemcode: { type: "text", search: true },
    type: { type: "enum", values: SHORTAGE_TYPES, required: true, filter: true, search: true },
    qty: { type: "int", required: true, min: 1 },
    month: { type: "date", filter: true, search: true },
    remarks: { type: "text" },
  },
  listSelect: [
    "s.id", "s.itemdcode", "s.itemcode", "s.type", "s.qty",
    "s.month", "s.remarks",
    "s.approved", "s.approved_by", "s.approved_at",
    "s.created_by", "s.created_at", "s.updated_by", "s.updated_at",
    "s.created_by AS created_by_name",
    "s.updated_by AS updated_by_name",
    "s.approved_by AS approved_by_name",
  ],
  sortable: [
    "id", "itemdcode", "itemcode", "type", "qty",
    "month", "approved", "created_at", "updated_at",
  ],
  filterFields: [
    "id", "itemdcode", "type", "approved", "month", "from_date", "to_date",
  ],
  dateFilterColumn: "month",
};
