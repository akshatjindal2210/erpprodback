/** IMS pack row parsing + calendar dates + list date-range filters (shared by daily-prod list). */

const IMS_PACK_DOC_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseLocalYyyyMmDd(s) {
  if (s == null || s === "") return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatImsPackDocdtToken(d) {
  return `${d.getDate()}${IMS_PACK_DOC_MON[d.getMonth()]}${d.getFullYear()}`;
}

function resolvePackSqlDateRange(filters, defaultSpanDays = 7) {
  const span = Math.max(1, Math.min(3650, Number(defaultSpanDays) || 7));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const fromStr = filters?.from_date != null && String(filters.from_date).trim() !== "" ? String(filters.from_date).trim() : "";
  const toStr = filters?.to_date != null && String(filters.to_date).trim() !== "" ? String(filters.to_date).trim() : "";

  const fromD = fromStr ? parseLocalYyyyMmDd(fromStr) : null;
  const toD = toStr ? parseLocalYyyyMmDd(toStr) : null;

  if (!fromStr && !toStr) {
    const start = new Date(today);
    start.setDate(start.getDate() - (span - 1));
    return { from: start, to: today };
  }
  if (fromStr && !toStr) {
    const f = fromD || today;
    return { from: f, to: today };
  }
  if (!fromStr && toStr) {
    const end = toD || today;
    const start = new Date(end);
    start.setDate(start.getDate() - (span - 1));
    return { from: start, to: end };
  }
  const f = fromD || today;
  const t = toD || today;
  if (f > t) return { from: t, to: f };
  return { from: f, to: t };
}

/** Body sent to IMS: `dailyprod.docdt >= '2Apr2026' and dailyprod.docdt <= '6Apr2026'` */
export function buildImsPackDocdtFilter(filters = {}, defaultSpanDays = 7) {
  const { from, to } = resolvePackSqlDateRange(filters, defaultSpanDays);
  const a = formatImsPackDocdtToken(from);
  const b = formatImsPackDocdtToken(to);
  return `dailyprod.docdt >= '${a}' and dailyprod.docdt <= '${b}'`;
}

export function formatPackDocDate(raw) {
  if (raw == null || raw === "") return null;
  const s0 = String(raw).trim();
  if (!s0) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s0)) {
    const [y, m, d] = s0.split("-");
    return `${y}-${m}-${d}`;
  }

  const monTok = /^(\d{1,2})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{4})$/i.exec(s0);
  if (monTok) {
    const day = parseInt(monTok[1], 10);
    const year = parseInt(monTok[3], 10);
    const monIdx = IMS_PACK_DOC_MON.findIndex((x) => x.toLowerCase() === monTok[2].toLowerCase());
    if (monIdx >= 0 && year > 0 && day >= 1 && day <= 31) {
      const dt = new Date(year, monIdx, day);
      if (dt.getFullYear() === year && dt.getMonth() === monIdx && dt.getDate() === day) {
        return `${year}-${String(monIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }

  if (s0.includes("/") && !s0.includes("-")) {
    const parts = s0.split("/").map((p) => p.trim());
    if (parts.length === 3 && /^\d{4}$/.test(parts[2])) {
      const dd = parseInt(parts[0], 10);
      const mm = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        const dt = new Date(y, mm - 1, dd);
        if (dt.getFullYear() === y && dt.getMonth() === mm - 1 && dt.getDate() === dd) {
          return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
      }
    }
  }

  if (s0.includes("-")) {
    const parts = s0.split("-").map((p) => p.trim());
    if (parts.length !== 3) return s0;
    const [p0, p1, p2] = parts;
    if (p0.length === 4) return `${p0}-${p1.padStart(2, "0")}-${p2.padStart(2, "0")}`;
    if (p2.length === 4) return `${p2}-${p1.padStart(2, "0")}-${p0.padStart(2, "0")}`;
    return s0;
  }

  return s0;
}

function isYyyyMmDd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

export function packRowInYmdRange(docDt, fromYmd, toYmd) {
  const row = formatPackDocDate(docDt);
  if (!isYyyyMmDd(row)) return true;
  if (isYyyyMmDd(fromYmd) && row < String(fromYmd).trim()) return false;
  if (isYyyyMmDd(toYmd) && row > String(toYmd).trim()) return false;
  return true;
}

/** Calendar date → YYYY-MM-DD (no timezone shift). */
export function toCalendarDateKey(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s || /invalid/i.test(s)) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  const mon = s.match(/^(\d{1,2})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{4})$/i);
  if (mon) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monIdx = monthNames.indexOf(mon[2].toLowerCase());
    if (monIdx >= 0) {
      return `${mon[3]}-${String(monIdx + 1).padStart(2, "0")}-${String(parseInt(mon[1], 10)).padStart(2, "0")}`;
    }
  }
  const formatted = formatPackDocDate(s);
  if (formatted && /^\d{4}-\d{2}-\d{2}$/.test(formatted)) return formatted;
  return "";
}

/** YYYY-MM-DD for PostgreSQL ::date, API JSON, and display — use at every doc_dt boundary. */
export function normalizeDocDtForDb(v) {
  const key = toCalendarDateKey(v);
  return key || null;
}

/** Match ERP pack doc_no with panel `packing_number` / `ims_dailyprod.doc_no` (30637 vs "30637.0"). */
export function normalizePackingDocNo(v) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  if (/^-?\d+(\.0+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.trunc(n));
  }
  return s;
}

/** Parse one IMS `pack` record (mixed legacy / lowercase keys). */
export function parsePackRow(r) {
  const doc_no = r.docno ?? r.doc_no ?? r["Doc No"] ?? r.Doc_No ?? r.DocNo;
  const rawDate = r.docdt ?? r.doc_dt ?? r["Doc Dt"] ?? r.Doc_Dt ?? r.DocDt ?? r.doc_dt;
  const itemDcode = r.itemdcode ?? r.ItemDcode ?? r.Itemdcode;
  const accCode = r.acc_code ?? r.Acc_Code ?? r.AccCode;
  const job_card_no = r.jobcardno ?? r.job_card_no ?? r["Job Card No"] ?? r.Job_Card_No ?? r.JobCardNo;
  const acc_name_row = r.acc_name ?? r.Acc_Name ?? r.AccName;
  const item_code_row = r.item_code ?? r.Item_Code ?? r.ItemCode;
  const itemdesc_row = r.itemdesc ?? r.ItemDesc ?? r.item_desc;
  const qty = r.QTY ?? r.qty ?? r.Total_Qty ?? r.TotalQty ?? r.total_qty;
  const internal_create_user = r.userc ?? r.Userc ?? r.UserC;
  const internal_create_date = r.datec ?? r.Datec ?? r.DateC;
  const doc_dt =
    normalizeDocDtForDb(formatPackDocDate(rawDate) ?? rawDate) ||
    (rawDate != null ? String(rawDate) : null);

  return {
    doc_no,
    doc_dt,
    job_card_no,
    acc_code: accCode,
    acc_name_row,
    itemdcode: itemDcode,
    item_code_row,
    itemdesc_row,
    qty,
    internal_create_user,
    internal_create_date,
  };
}

export function trimYmdFilter(from_date, to_date) {
  return {
    from: from_date != null && String(from_date).trim() !== "" ? String(from_date).trim() : "",
    to: to_date != null && String(to_date).trim() !== "" ? String(to_date).trim() : "",
  };
}
