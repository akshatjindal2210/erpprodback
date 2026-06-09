import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../services/ims.service.js";
import { getProductionStickerPanelMetaByPackingNumbers, getProductionStickerPackingDocNos, findItemDcodesWithInHandStock } from "../models/box.model.js";
import { pickProductionStickerPanelMeta } from "../utils/productionStickerPanelMeta.js";
import { enrichRowsWithIMS, resolvePartyRateCustCodeFromIms, getImsMapsSafe } from "../utils/imsLookup.js";
import dbQuery from "../../../config/db.js";
import { getDefaultListViewSpanDays } from "../../core/models/appConfig.model.js";
import { resolveStandardQtyPerBoxForPacking } from "../utils/stockAdjustmentPacking.js";
import { sanitizeSearch } from "../../core/utils/helper.js";
import { resolveItemViewsSelectFields } from "../config/view-fields/item.js";
import { resolveLedgerViewsSelectFields } from "../config/view-fields/ledger.js";
import { extractListParams } from "../../core/utils/queryHelper.js";
import { findPackingEntryCustomerByAccCode, listPackingEntryCustomersForItem } from "../utils/packingEntryCustomers.js";

const LEDGER_ITEM_CUSTOMER_MODULES = new Set(["packing_entry", "stock_adjustment"]);

function mapItemRecord(r) {
  return {
    itemdcode: r.ItemDcode,
    item_code: r.Item_Code,
    itemdesc: r.ItemDesc,
    grpname: r.Grpname,
    minqty: r.minqty,
    maxqty: r.maxqty,
    reorderqty: r.Reorderqty,
    primitemdcode: r.PrimItemdcode,
    primitemdesc: r.PrimItemdesc,
    apvitem: r.apvitem,
    unit: r.Unit ?? r.unit,
    category_id: r.Category_Id ?? r.category_id
  };
}

function mapLedgerRecord(r) {
  return {
    acc_code: r.Acc_Code,
    acc_name: r.Acc_Name,
    city: r.City,
    group_code: r.GrpCode
  };
}

function sortItems(arr, sortBy = "item_code", order = "ASC") {
  const key = String(sortBy).toLowerCase();
  const mul = String(order).toUpperCase() === "DESC" ? -1 : 1;
  const pick = (row) => {
    const v = row[key];
    if (v == null) return "";
    return typeof v === "number" ? v : String(v).toLowerCase();
  };
  return [...arr].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
}

function sortLedgers(arr, sortBy = "acc_name", order = "DESC") {
  const key = String(sortBy).toLowerCase();
  const mul = String(order).toUpperCase() === "ASC" ? 1 : -1;
  const norm = { acc_code: "acc_code", acc_name: "acc_name" };
  const field = norm[key] || "acc_code";
  return [...arr].sort((a, b) => {
    const va = a[field] == null ? "" : String(a[field]).toLowerCase();
    const vb = b[field] == null ? "" : String(b[field]).toLowerCase();
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
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

/** IMS rows are already in memory; allow one response with the full catalog for client search. */
const IMS_IN_MEMORY_MAX_LIMIT = 100000;

function slicePage(rows, page = 1, limit = 50) {
  const total = rows.length;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const parsed = parseInt(limit, 10);
  const effectiveLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : total > 0 ? total : 50;
  const safeLimit = Math.min(IMS_IN_MEMORY_MAX_LIMIT, Math.max(1, effectiveLimit));
  const start = (safePage - 1) * safeLimit;
  const data = rows.slice(start, start + safeLimit);
  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1
  };
}

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

/** IMS expects e.g. `2Apr2026` (day without leading zero + Mon + year). */
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

/** Body sent to IMS: `filter: "dailyprod.docdt >= '2Apr2026' and dailyprod.docdt <= '6Apr2026'"` */
export function buildImsPackDocdtFilter(filters = {}, defaultSpanDays = 7) {
  const { from, to } = resolvePackSqlDateRange(filters, defaultSpanDays);
  const a = formatImsPackDocdtToken(from);
  const b = formatImsPackDocdtToken(to);
  return `dailyprod.docdt >= '${a}' and dailyprod.docdt <= '${b}'`;
}

/** Normalize pack `docdt` to YYYY-MM-DD when parseable (IMS often sends `11May2026`, `04-05-2026`, or `04/05/2026`). */
function formatPackDocDate(raw) {
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

/** Compare row doc_dt to filter bounds (filters use YYYY-MM-DD from the client). */
function packRowInYmdRange(docDt, fromYmd, toYmd) {
  const row = formatPackDocDate(docDt);
  if (!isYyyyMmDd(row)) return true;
  if (isYyyyMmDd(fromYmd) && row < String(fromYmd).trim()) return false;
  if (isYyyyMmDd(toYmd) && row > String(toYmd).trim()) return false;
  return true;
}

/**
 * IMS `pack` payload: new API uses lowercase keys (docno, docdt, jobcardno, acc_code, …).
 * Legacy responses used mixed keys (Doc_No, ItemDcode, …). Both are handled here.
 */
function parsePackRow(r) {
  const doc_no =
    r.docno ??
    r.doc_no ??
    r["Doc No"] ??
    r.Doc_No ??
    r.DocNo;

  const rawDate =
    r.docdt ??
    r.doc_dt ??
    r["Doc Dt"] ??
    r.Doc_Dt ??
    r.DocDt ??
    r.doc_dt;

  const itemDcode = r.itemdcode ?? r.ItemDcode ?? r.Itemdcode;

  const accCode = r.acc_code ?? r.Acc_Code ?? r.AccCode;

  const job_card_no =
    r.jobcardno ??
    r.job_card_no ??
    r["Job Card No"] ??
    r.Job_Card_No ??
    r.JobCardNo;

  const acc_name_row = r.acc_name ?? r.Acc_Name ?? r.AccName;
  const item_code_row = r.item_code ?? r.Item_Code ?? r.ItemCode;
  const itemdesc_row = r.itemdesc ?? r.ItemDesc ?? r.item_desc;

  const qty = r.QTY ?? r.qty ?? r.Total_Qty ?? r.TotalQty ?? r.total_qty;

  const doc_dt = formatPackDocDate(rawDate) ?? (rawDate != null ? String(rawDate) : null);

  return {
    doc_no,
    doc_dt,
    job_card_no,
    acc_code: accCode,
    acc_name_row,
    itemdcode: itemDcode,
    item_code_row,
    itemdesc_row,
    qty
  };
}

/** Match ERP pack doc_no with panel `packing_number` / `ims_dailyprod.doc_no` (30637 vs "30637.0"). */
function normalizePackingDocNo(v) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  if (/^-?\d+(\.0+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.trunc(n));
  }
  return s;
}

/**
 * IMS `custcode` (party rate): API often returns Acc_code, ItemDcode, narr1, ITAPV ("APPROVED"),
 * acc_name, item_code, itemdesc, grpname inline — with fallbacks from cust/item masters.
 */
function buildLedgerMap(ledgers) {
  const m = new Map();
  for (const l of ledgers || []) {
    const code = l.Acc_Code ?? l.Acc_code ?? l.acc_code;
    if (code != null) m.set(String(code), l);
  }
  return m;
}

function buildItemMap(items) {
  const m = new Map();
  for (const i of items || []) {
    const d = i.ItemDcode ?? i.Itemdcode ?? i.itemdcode;
    if (d != null) m.set(String(d), i);
  }
  return m;
}

function parseCustCodeRow(r, ledger, item) {
  const acc_code = r.Acc_code ?? r.Acc_Code ?? r.acc_code ?? null;
  const itemdcode = r.ItemDcode ?? r.Itemdcode ?? r.itemdcode ?? r.ItemCode ?? r.item_code ?? null;

  const narr1 = r.narr1 ?? r.Narr1 ?? null;
  const itapv = r.ITAPV ?? r.ItApv ?? r.itapv ?? null;

  const acc_name = r.acc_name ?? r.Acc_Name ?? ledger?.Acc_Name ?? null;

  const item_code = r.item_code ?? r.Item_Code ?? item?.Item_Code ?? null;

  const itemdesc = r.itemdesc ?? r.ItemDesc ?? item?.ItemDesc ?? null;

  const grpname = r.grpname ?? r.Grpname ?? item?.Grpname ?? null;

  const primitemdesc = r.primitemdesc ?? r.PrimItemdesc ?? item?.PrimItemdesc ?? null;

  return { acc_code, itemdcode, narr1, itapv, acc_name, item_code, itemdesc, grpname, primitemdesc };
}

export const getItems = async (req, res) => {
  try {
    const { search, page, limit, sortBy, order } = req.body;
    const sortByProvided = sortBy != null && String(sortBy).trim() !== "";
    const orderProvided = order != null && String(order).trim() !== "";
    const shouldSort = sortByProvided || orderProvided;

    const records = await fetchFromIMS("item");
    let rows = (records || []).map(mapItemRecord);
    rows = filterBySearch(rows, sanitizeSearch(search), [
      (r) => r.item_code,
      (r) => r.itemdesc,
      (r) => r.grpname
    ]);
    if (shouldSort) {
      rows = sortItems(rows, sortBy, order);
    }
    const out = slicePage(rows, page, limit || rows.length || 1000);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getItemById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ItemDcode required" });
    const records = await fetchFromIMS("item");
    const raw = (records || []).find((r) => String(r.ItemDcode) === String(id));
    if (!raw) return res.status(404).json({ success: false, message: "Item not found" });
    const item = mapItemRecord(raw);
    res.json({
      success: true,
      data: { ...item, ims_category: raw.Grpname ?? item.grpname }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

function filterImsCustRows(rawRows, search) {
  const s = sanitizeSearch(search);
  if (!s) return rawRows || [];
  const low = s.toLowerCase();
  return (rawRows || []).filter((r) => {
    const code = r.Acc_Code ?? r.Acc_code ?? r.acc_code;
    const name = String(r.Acc_Name ?? r.Acc_name ?? r.acc_name ?? "");
    return (String(code ?? "").toLowerCase().includes(low) || name.toLowerCase().includes(low));
  });
}

export const getLedgers = async (req, res) => {
  try {
    const { search, page, limit, sortBy, order } = req.body;
    const imsRows = await fetchFromIMS("cust");
    let orderedRaw = filterImsCustRows(imsRows, search);

    // Keep IMS row order unless client explicitly requests sort
    const sortByProvided = sortBy != null && String(sortBy).trim() !== "";
    const orderProvided = order != null && String(order).trim() !== "";
    const shouldSort = sortByProvided || orderProvided;

    if (shouldSort) {
      const norm = orderedRaw.map(mapLedgerRecord);
      const sortedNorm = sortLedgers(norm, sortBy, order);
      const byCode = new Map(
        orderedRaw.map((r) => [String(r.Acc_Code ?? r.Acc_code ?? r.acc_code), r])
      );
      orderedRaw = sortedNorm
        .map((n) => byCode.get(String(n.acc_code)))
        .filter(Boolean);
    }

    const normalized = orderedRaw.map(mapLedgerRecord);
    const pageLimit =
      limit != null && limit !== "" ? limit : normalized.length || 1000;
    const out = slicePage(normalized, page, pageLimit);
    const start = (out.page - 1) * out.limit;
    const pageRaw = orderedRaw.slice(start, start + out.data.length);

    const records = pageRaw.map((r) => ({
      Acc_Code: r.Acc_Code ?? r.Acc_code ?? r.acc_code,
      Acc_Name: r.Acc_Name ?? r.Acc_name ?? r.acc_name ?? "",
    }));

    res.json({
      success: true,
      records,
      ...out,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLedgerById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "Acc_Code required" });
    const records = await fetchFromIMS("cust");
    const raw = (records || []).find((r) => String(r.Acc_Code) === String(id));
    if (!raw) return res.status(404).json({ success: false, message: "Customer not found" });
    res.json({ success: true, data: { acc_code: raw.Acc_Code, acc_name: raw.Acc_Name } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPartyRates = async (req, res) => {
  try {
    const { search, page, limit, sortBy, order } = req.body || {};
    const [records, ledgers, items] = await Promise.all([
      fetchFromIMS("custcode"),
      fetchFromIMS("cust"),
      fetchFromIMS("item")
    ]);

    const ledgerByCode = buildLedgerMap(ledgers);
    const itemByDCode = buildItemMap(items);

    let data = (records || []).map((r) => {
      const acc = r.Acc_code ?? r.Acc_Code ?? r.acc_code;
      const idcode = r.ItemDcode ?? r.Itemdcode ?? r.itemdcode;
      const ledger = acc != null ? ledgerByCode.get(String(acc)) : null;
      const item = idcode != null ? itemByDCode.get(String(idcode)) : null;
      return parseCustCodeRow(r, ledger, item);
    });

    const s = sanitizeSearch(search);
    if (s) {
      const low = s.toLowerCase();
      data = data.filter((row) =>
        [
          row.acc_code,
          row.itemdcode,
          row.narr1,
          row.itapv,
          row.acc_name,
          row.itemdesc,
          row.item_code,
          row.grpname
        ].some((v) => v != null && String(v).toLowerCase().includes(low))
      );
    }

    const sortByProvided = req.body?.sortBy != null && String(req.body.sortBy).trim() !== "";
    const orderProvided = req.body?.order != null && String(req.body.order).trim() !== "";
    const shouldSort = sortByProvided || orderProvided;
    if (shouldSort) {
      const sortKey = String(sortBy || "acc_name").toLowerCase();
      const mul = String(order || "ASC").toUpperCase() === "DESC" ? -1 : 1;
      data.sort((a, b) => {
        const va = a[sortKey] == null ? "" : String(a[sortKey]).toLowerCase();
        const vb = b[sortKey] == null ? "" : String(b[sortKey]).toLowerCase();
        if (va < vb) return -1 * mul;
        if (va > vb) return 1 * mul;
        return 0;
      });
    }

    const out = slicePage(data, page, limit || data.length || 1000);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getDailyProd = async (req, res) => {
  try {
    const { search, page, limit, sortBy, order, filters } = req.body;
    const { acc_code, item_dcode, from_date, to_date, sticker_generated } = filters || {};
    const defaultSpanDays = await getDefaultListViewSpanDays();
    const imsPackFilter = buildImsPackDocdtFilter({ from_date, to_date }, defaultSpanDays);

    const [records, items, ledgers] = await Promise.all([
      fetchFromIMS("pack", imsPackFilter),
      fetchFromIMS("item"),
      fetchFromIMS("cust")
    ]);

    const itemMap = new Map((items || []).map((i) => [String(i.ItemDcode), i]));
    const ledgerMap = new Map((ledgers || []).map((l) => [String(l.Acc_Code), l]));

    const [localGenerated, packingWithStickers] = await Promise.all([
      dbQuery(`SELECT doc_no::text AS doc_no FROM ims_dailyprod WHERE sticker_generated = true`),
      getProductionStickerPackingDocNos(),
    ]);
    const generatedMap = new Set();
    for (const r of localGenerated || []) {
      const n = normalizePackingDocNo(r.doc_no);
      if (n) generatedMap.add(n);
    }
    for (const docNo of packingWithStickers || []) {
      const n = normalizePackingDocNo(docNo);
      if (n) generatedMap.add(n);
    }

    const generatedDocList = [...generatedMap];

    const [panelMetaMap, dailyprodAccRows] = await Promise.all([
      generatedMap.size
        ? getProductionStickerPanelMetaByPackingNumbers(generatedDocList)
        : Promise.resolve(new Map()),
      generatedMap.size
        ? dbQuery(
            `SELECT trim(doc_no::text) AS doc_no, acc_code::text AS acc_code
             FROM ims_dailyprod
             WHERE trim(doc_no::text) = ANY($1::text[])`,
            [generatedDocList.map(String)]
          )
        : Promise.resolve([]),
    ]);

    const dailyprodAccByDoc = new Map();
    for (const r of dailyprodAccRows || []) {
      const key = normalizePackingDocNo(r.doc_no);
      const acc = r.acc_code != null ? String(r.acc_code).trim() : "";
      if (key && acc) dailyprodAccByDoc.set(key, acc);
    }

    const applyPanelMetaToDailyProdRow = (row) => {
      const docKey = normalizePackingDocNo(row.doc_no);
      const panel =
        pickProductionStickerPanelMeta(
          panelMetaMap,
          row.doc_no,
          row.itemdcode,
          row.acc_code
        ) ??
        (docKey ? panelMetaMap.get(docKey) : undefined);
      let next = { ...row };

      if (row.sticker_generated) {
        // Packing entry customer = chosen at sticker generate (ims_dailyprod). Never per-box override (C3).
        const stickerCustomer = docKey ? dailyprodAccByDoc.get(docKey) : null;
        if (stickerCustomer) {
          const ledgerDetail = ledgerMap.get(String(stickerCustomer));
          next.acc_code = stickerCustomer;
          next.acc_name =
            ledgerDetail?.Acc_Name ??
            (stickerCustomer != null ? `Customer ${stickerCustomer}` : next.acc_name);
        }
      }

      if (row.sticker_generated && panel) {
        if (panel.itemdcode) {
          const itemDetail = itemMap.get(String(panel.itemdcode));
          next.itemdcode = panel.itemdcode;
          next.item_code = itemDetail?.Item_Code ?? next.item_code;
          next.item_desc = itemDetail?.ItemDesc ?? next.item_desc;
        }
        if (panel.dailyprod_job_card_no) {
          next.job_card_no = panel.dailyprod_job_card_no;
        }
        if (panel.dailyprod_total_qty != null && panel.dailyprod_total_qty !== "") {
          next.total_qty = String(panel.dailyprod_total_qty);
        }
      }

      if (panel) {
        next.sticker_count = panel.sticker_count ?? null;
        next.sticker_created_at = panel.sticker_created_at ?? null;
        next.sticker_created_by_name = panel.sticker_created_by_name ?? null;
        next.sticker_updated_at = panel.sticker_updated_at ?? null;
        next.sticker_updated_by_name = panel.sticker_updated_by_name ?? null;
      }

      return next;
    };

    let data = (records || []).map((r) => {
      const p = parsePackRow(r);
      const itemDetail = itemMap.get(String(p.itemdcode));
      const ledgerDetail = ledgerMap.get(String(p.acc_code));
      const docKey = normalizePackingDocNo(p.doc_no);

      const base = {
        doc_no: p.doc_no,
        doc_dt: p.doc_dt,
        job_card_no: p.job_card_no,
        acc_code: p.acc_code,
        acc_name:
          p.acc_name_row ?? ledgerDetail?.Acc_Name ?? (p.acc_code != null ? `Customer ${p.acc_code}` : null),
        itemdcode: p.itemdcode,
        item_code: p.item_code_row ?? itemDetail?.Item_Code ?? "N/A",
        item_desc: p.itemdesc_row ?? itemDetail?.ItemDesc ?? "N/A",
        total_qty: String(p.qty ?? "0"),
        sticker_generated: docKey ? generatedMap.has(docKey) : false,
      };

      return base.sticker_generated ? applyPanelMetaToDailyProdRow(base) : base;
    });

    if (acc_code != null && acc_code !== "")
      data = data.filter((r) => String(r.acc_code) === String(acc_code));
    if (item_dcode != null && item_dcode !== "")
      data = data.filter((r) => String(r.itemdcode) === String(item_dcode));
    const fromTrim = from_date != null && String(from_date).trim() !== "" ? String(from_date).trim() : "";
    const toTrim = to_date != null && String(to_date).trim() !== "" ? String(to_date).trim() : "";
    if (fromTrim || toTrim) data = data.filter((r) => packRowInYmdRange(r.doc_dt, fromTrim || null, toTrim || null));
    if (sticker_generated !== undefined && sticker_generated !== "")
      data = data.filter((r) => String(r.sticker_generated) === String(sticker_generated === true || sticker_generated === "true"));

    const s = sanitizeSearch(search);
    if (s) {
      const low = s.toLowerCase();
      data = data.filter((row) =>
        [row.doc_no, row.job_card_no, row.item_code, row.item_desc, row.acc_name, row.total_qty]
          .some((v) => v != null && String(v).toLowerCase().includes(low))
      );
    }

    const sortKey = String(sortBy || "doc_dt").toLowerCase();
    const mul = String(order || "DESC").toUpperCase() === "ASC" ? 1 : -1;
    data.sort((a, b) => {
      const va = a[sortKey] == null ? "" : String(a[sortKey]).toLowerCase();
      const vb = b[sortKey] == null ? "" : String(b[sortKey]).toLowerCase();
      if (va < vb) return -1 * mul;
      if (va > vb) return 1 * mul;
      return 0;
    });

    const out = slicePage(data, page, limit || data.length || 1000);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Party-rate narration (`narr1`) for customer + item — sticker creation customer picker. */
export const resolvePartyRateCustCodeForSticker = async (req, res) => {
  try {
    const acc_code = req.body?.acc_code;
    const itemdcode = req.body?.itemdcode ?? req.body?.item_dcode;
    const item_code = req.body?.item_code ?? null;
    if (acc_code == null || String(acc_code).trim() === "") {
      return res.status(400).json({ success: false, message: "acc_code is required" });
    }
    if (itemdcode == null || String(itemdcode).trim() === "") {
      return res.status(400).json({ success: false, message: "itemdcode is required" });
    }
    const party_rate_cust_code = await resolvePartyRateCustCodeFromIms({acc_code, itemdcode, item_code});
    res.json({
      success: true,
      party_rate_cust_code:
        party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
          ? String(party_rate_cust_code).trim()
          : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** IMS `pack` for selected Indian financial year + doc no (packing) — stock adjustment gate / previews. */
export const getPackByFinancialYearDoc = async (req, res) => {
  try {
    const fy = req.body?.financial_year != null ? String(req.body.financial_year).trim() : "";
    const doc = String(req.body?.doc_no ?? req.body?.packing_number ?? "").trim();
    if (!fy) return res.status(400).json({ success: false, message: "financial_year required", records: [] });
    if (!doc) return res.status(400).json({ success: false, message: "doc_no or packing_number required", records: [] });
    const out = await fetchPackRowsForFinancialYearDoc(fy, doc);
    let party_rate_cust_code = null;
    let standard_qty_per_box = null;
    if (out.success && Array.isArray(out.records) && out.records.length > 0) {
      const r0 = out.records[0];
      party_rate_cust_code = await resolvePartyRateCustCodeFromIms({
        itemdcode: r0.itemdcode,
        item_code: r0.item_code,
        acc_code: r0.acc_code,
      });
      standard_qty_per_box = await resolveStandardQtyPerBoxForPacking({
        packingNumber: doc,
        itemDcode: r0.itemdcode
      });
    }
    res.json({
      success: out.success,
      records: out.records,
      message: out.message || "",
      filter: out.filter,
      soft_message: out.softMessage === true,
      party_rate_cust_code:
        party_rate_cust_code != null && String(party_rate_cust_code).trim() !== ""
          ? String(party_rate_cust_code).trim()
          : null,
      standard_qty_per_box:
        standard_qty_per_box != null && Number.isFinite(Number(standard_qty_per_box))
          ? Number(standard_qty_per_box)
          : null,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message, records: [] });
  }
};

export const getItemsViews = async (req, res) => {
  try {
    const { id, permission_module, permission_action } = req.body;
    const { page, limit, search, filters } = extractListParams(req.body);

    const records = await fetchFromIMS("item");
    const rows = (records || []).map(mapItemRecord);

    if (id) {
      const item = rows.find((r) => String(r.itemdcode) === String(id));
      if (!item) return res.json({ success: true, data: null });
      return res.json({
        success: true,
        data: {
          id: item.itemdcode,
          itemdcode: item.itemdcode,
          item_code: item.item_code,
          itemdesc: item.itemdesc
        }
      });
    }

    const fields = resolveItemViewsSelectFields({ permission_module, permission_action });
    if (fields == null) {
      return res.status(400).json({
        success: false,
        message: "Invalid permission_module / permission_action for item views"
      });
    }

    let filtered = rows;
    const s = sanitizeSearch(search);
    if (s) {
      filtered = filterBySearch(filtered, s, [
        (r) => r.item_code,
        (r) => r.itemdesc,
        (r) => r.grpname
      ]);
    }
    const onlyStickerGenerated =
      filters?.sticker_generated === true ||
      String(filters?.sticker_generated || "").toLowerCase() === "true";
    const onlyInHandInventory =
      filters?.in_hand_inventory === true ||
      String(filters?.in_hand_inventory || "").toLowerCase() === "true";

    if (onlyStickerGenerated) {
      const stickerRows = await dbQuery(
        `SELECT DISTINCT item_dcode AS itemdcode FROM ims_dailyprod WHERE sticker_generated = true`
      );
      const allowed = new Set((stickerRows || []).map((r) => String(r.itemdcode)));
      filtered = filtered.filter((r) => allowed.has(String(r.itemdcode)));
    }

    if (onlyInHandInventory) {
      const stockRows = await findItemDcodesWithInHandStock();
      const allowed = new Set((stockRows || []).map((r) => String(r.itemdcode)));
      filtered = filtered.filter((r) => allowed.has(String(r.itemdcode)));
      const present = new Set(filtered.map((r) => String(r.itemdcode)));
      for (const row of stockRows || []) {
        const id = String(row.itemdcode);
        if (!present.has(id)) {
          filtered.push({
            itemdcode: id,
            item_code: id,
            itemdesc: "",
          });
          present.add(id);
        }
      }
      filtered = await enrichRowsWithIMS(filtered, {
        itemCodeField: "itemdcode",
        itemCodeOut: "item_code",
        itemDescOut: "itemdesc",
      });
    }

    // Natural IMS order (no sorting)
    const out = slicePage(filtered, page || 1, limit || filtered.length || 1000);

    const wantUnit = fields.some((f) => String(f).includes("unit"));
    const wantCategory = fields.some((f) => String(f).includes("category_id"));
    const miniData = out.data.map((item) => {
      const row = {
        id: item.itemdcode,
        itemdcode: item.itemdcode,
        item_code: item.item_code,
        itemdesc: item.itemdesc
      };
      if (wantUnit) row.unit = item.unit;
      if (wantCategory) row.category_id = item.category_id;
      return row;
    });

    res.json({ success: true, data: miniData, total: out.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getItemViewById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ItemDcode required" });
    const records = await fetchFromIMS("item");
    const raw = (records || []).find((r) => String(r.ItemDcode) === String(id));
    if (!raw) return res.status(404).json({ success: false, message: "Item not found" });
    const item = mapItemRecord(raw);
    res.json({
      success: true,
      data: {
        id: item.itemdcode,
        itemdcode: item.itemdcode,
        item_code: item.item_code,
        itemdesc: item.itemdesc
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLedgersViews = async (req, res) => {
  try {
    const { id, permission_module, permission_action, itemdcode, item_dcode } = req.body;
    const { page, limit, search } = extractListParams(req.body);
    const itemFilter = itemdcode ?? item_dcode;

    const records = await fetchFromIMS("cust");
    const rows = (records || []).map(mapLedgerRecord);

    if (id) {
      const itemScopedLookup =
        LEDGER_ITEM_CUSTOMER_MODULES.has(permission_module) &&
        itemFilter != null &&
        String(itemFilter).trim() !== "";

      if (itemScopedLookup) {
        const match = await findPackingEntryCustomerByAccCode(itemFilter, id, rows);
        if (match) {
          return res.json({
            success: true,
            data: { id: match.acc_code, acc_code: match.acc_code, acc_name: match.acc_name },
          });
        }
      }

      const ledger = rows.find((r) => String(r.acc_code) === String(id));
      if (!ledger) return res.json({ success: true, data: null });
      return res.json({
        success: true,
        data: { id: ledger.acc_code, acc_code: ledger.acc_code, acc_name: ledger.acc_name },
      });
    }

    const fields = resolveLedgerViewsSelectFields({ permission_module, permission_action });
    if (fields == null) {
      return res.status(400).json({
        success: false,
        message: "Invalid permission_module / permission_action for ledger views"
      });
    }

    const itemScopedCustomer =
      LEDGER_ITEM_CUSTOMER_MODULES.has(permission_module) &&
      itemFilter != null &&
      String(itemFilter).trim() !== "";

    let filtered = rows;

    if (itemScopedCustomer) {
      filtered = await listPackingEntryCustomersForItem(itemFilter, rows);
    }

    const s = sanitizeSearch(search);
    if (s) filtered = filterBySearch(filtered, s, [(r) => r.acc_name, (r) => r.acc_code]);

    const out = slicePage(filtered, page || 1, limit || filtered.length || 1000);

    const wantGroup = fields.some((f) => String(f).includes("group_code"));
    const wantCity = fields.some((f) => String(f).includes("city"));
    const miniData = out.data.map((ledger) => {
      const row = {
        id: ledger.id ?? ledger.acc_code,
        acc_name: ledger.acc_name,
        ...(ledger.acc_code !== undefined ? { acc_code: ledger.acc_code } : {}),
      };
      if (wantGroup) row.group_code = ledger.group_code;
      if (wantCity) row.city = ledger.city;
      return row;
    });

    res.json({ success: true, data: miniData, total: out.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLedgerViewById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "Acc_Code required" });
    const records = await fetchFromIMS("cust");
    const raw = (records || []).find((r) => String(r.Acc_Code) === String(id));
    if (!raw) return res.status(404).json({ success: false, message: "Ledger not found" });
    res.json({
      success: true,
      data: { id: raw.Acc_Code, acc_code: raw.Acc_Code, acc_name: raw.Acc_Name }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPartyRatesViews = async (req, res) => {
  try {
    const sortByProvided = req.body?.sortBy != null && String(req.body.sortBy).trim() !== "";
    const orderProvided = req.body?.order != null && String(req.body.order).trim() !== "";
    const shouldSort = sortByProvided || orderProvided;

    const { page, limit, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "acc_name",
      order: "DESC"
    });
    const [records, ledgers, items] = await Promise.all([
      fetchFromIMS("custcode"),
      fetchFromIMS("cust"),
      fetchFromIMS("item")
    ]);

    const ledgerByCode = buildLedgerMap(ledgers);
    const itemByDCode = buildItemMap(items);

    let data = (records || []).map((r) => {
      const acc = r.Acc_code ?? r.Acc_Code ?? r.acc_code;
      const idcode = r.ItemDcode ?? r.Itemdcode ?? r.itemdcode;
      const ledger = acc != null ? ledgerByCode.get(String(acc)) : null;
      const item = idcode != null ? itemByDCode.get(String(idcode)) : null;
      return parseCustCodeRow(r, ledger, item);
    });

    const s = sanitizeSearch(search);
    if (s) {
      const low = s.toLowerCase();
      data = data.filter((row) =>
        [
          row.acc_code,
          row.itemdcode,
          row.narr1,
          row.itapv,
          row.acc_name,
          row.itemdesc,
          row.item_code,
          row.grpname
        ].some((v) => v != null && String(v).toLowerCase().includes(low))
      );
    }

    if (shouldSort) {
      const sortKey = String(sortBy || "acc_name").toLowerCase();
      const mul = String(order || "DESC").toUpperCase() === "ASC" ? 1 : -1;
      data.sort((a, b) => {
        const va = a[sortKey] == null ? "" : String(a[sortKey]).toLowerCase();
        const vb = b[sortKey] == null ? "" : String(b[sortKey]).toLowerCase();
        if (va < vb) return -1 * mul;
        if (va > vb) return 1 * mul;
        return 0;
      });
    }

    const out = slicePage(data, page || 1, limit || data.length || 1000);
    const miniData = out.data.map((pr) => ({
      id: `${pr.acc_code}_${pr.itemdcode}`,
      acc_code: pr.acc_code,
      acc_name: pr.acc_name,
      itemdcode: pr.itemdcode,
      item_code: pr.item_code,
      itemdesc: pr.itemdesc
    }));
    res.json({ success: true, data: miniData, total: out.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getDailyProdViews = async (req, res) => {
  try {
    const { page, limit, sortBy, order, search, filters } = extractListParams(req.body, {
      sortBy: "doc_dt",
      order: "DESC"
    });
    const defaultSpanDays = await getDefaultListViewSpanDays();
    const imsPackFilter = buildImsPackDocdtFilter(filters || {}, defaultSpanDays);
    const [records, items, ledgers] = await Promise.all([
      fetchFromIMS("pack", imsPackFilter),
      fetchFromIMS("item"),
      fetchFromIMS("cust")
    ]);

    const itemMap = new Map((items || []).map((i) => [String(i.ItemDcode), i]));
    const ledgerMap = new Map((ledgers || []).map((l) => [String(l.Acc_Code), l]));

    let data = (records || []).map((r) => {
      const p = parsePackRow(r);
      const itemDetail = itemMap.get(String(p.itemdcode));
      const ledgerDetail = ledgerMap.get(String(p.acc_code));

      return {
        doc_no: p.doc_no,
        doc_dt: p.doc_dt,
        acc_name: p.acc_name_row ?? ledgerDetail?.Acc_Name ?? null,
        item_code: p.item_code_row ?? itemDetail?.Item_Code ?? "N/A",
        total_qty: p.qty
      };
    });

    const s = sanitizeSearch(search);
    if (s) {
      const low = s.toLowerCase();
      data = data.filter((row) =>
        [row.doc_no, row.doc_dt, row.acc_name, row.item_code, row.total_qty]
          .some((v) => v != null && String(v).toLowerCase().includes(low))
      );
    }

    const sortKey = String(sortBy || "doc_dt").toLowerCase();
    const mul = String(order || "DESC").toUpperCase() === "ASC" ? 1 : -1;
    data.sort((a, b) => {
      const va = a[sortKey] == null ? "" : String(a[sortKey]).toLowerCase();
      const vb = b[sortKey] == null ? "" : String(b[sortKey]).toLowerCase();
      if (va < vb) return -1 * mul;
      if (va > vb) return 1 * mul;
      return 0;
    });

    const out = slicePage(data, page || 1, limit || data.length || 1000);
    const miniData = out.data.map((dp) => ({
      id: dp.doc_no,
      doc_no: dp.doc_no,
      doc_dt: dp.doc_dt,
      acc_name: dp.acc_name,
      item_code: dp.item_code,
      total_qty: dp.total_qty
    }));
    res.json({ success: true, data: miniData, total: out.total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
