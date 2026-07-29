import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";

/** Normalize ERP item rows from `prdprimitem` or `item` (+ type rm). */
export function mapErpItemRecord(r = {}) {
  return {
    itemdcode: r.ItemDcode ?? r.Itemdcode ?? r.itemdcode ?? r.item_dcode,
    item_code: r.Item_Code ?? r.item_code ?? r.ItemCode ?? r.itemcode ?? null,
    itemdesc: r.ItemDesc ?? r.Itemdesc ?? r.itemdesc ?? r.item_desc ?? r.primItemDesc ?? null,
    grpname: r.Grpname ?? r.grpname ?? null,
  };
}

/** Normalize ERP production-run job cards from `prdrunjc`. */
export function mapPrdRunJcRecord(r = {}) {
  const pjobcardno = String(r.pjobcardno ?? r.Pjobcardno ?? r.pJobCardNo ?? "").trim();
  const itemdcode = r.itemdcode ?? r.ItemDcode ?? r.Itemdcode ?? r.item_dcode ?? null;
  return {
    pjobcardno,
    pldt: r.pldt ?? r.Pldt ?? r.pl_dt ?? null,
    item_code: r.item_code ?? r.Item_Code ?? r.ItemCode ?? null,
    itemdcode,
    planqty: Number(r.planqty ?? r.PlanQty ?? r.plan_qty ?? 0) || 0,
    itemdesc: r.itemdesc ?? r.ItemDesc ?? r.Itemdesc ?? r.item_desc ?? null,
    macname: r.macname ?? r.MacName ?? r.mac_name ?? null,
  };
}

export async function loadMappedItems(requestedData, filter = null) {
  const records = await fetchFromIMS(requestedData, filter);
  return (records || [])
    .map(mapErpItemRecord)
    .filter((r) => r.itemdcode != null && String(r.itemdcode).trim() !== "");
}

export async function loadMappedPrdRunJc() {
  const records = await fetchFromIMS("prdrunjc");
  return (records || [])
    .map(mapPrdRunJcRecord)
    .filter((r) => r.pjobcardno);
}

export function toPickerRow(item) {
  return {
    id: item.itemdcode,
    itemdcode: item.itemdcode,
    item_code: item.item_code,
    itemdesc: item.itemdesc,
  };
}

export function toPrdRunJcPickerRow(row) {
  return {
    id: row.pjobcardno,
    pjobcardno: row.pjobcardno,
    pldt: row.pldt,
    item_code: row.item_code,
    itemdcode: row.itemdcode,
    planqty: row.planqty,
    itemdesc: row.itemdesc,
    macname: row.macname,
    label: row.pjobcardno,
    sub: [row.item_code, row.itemdesc].filter(Boolean).join(" · "),
  };
}

export function filterItemsBySearch(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    [row.item_code, row.itemdesc, row.grpname].some((v) =>
      String(v ?? "").toLowerCase().includes(q)
    )
  );
}

export function filterPrdRunJcBySearch(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    [row.pjobcardno, row.item_code, row.itemdesc, row.macname, row.itemdcode].some((v) =>
      String(v ?? "").toLowerCase().includes(q)
    )
  );
}

export function slicePage(rows, page = 1, limit = 1000) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const start = (safePage - 1) * safeLimit;
  return {
    data: rows.slice(start, start + safeLimit),
    total: rows.length,
    page: safePage,
    limit: safeLimit,
  };
}

/** Resolve denormalized code/desc from ERP for DB storage (write path only). */
export async function resolveProductionSnapshot(item_dcode, rm_item_dcode) {
  const [prodRows, rmRows] = await Promise.all([
    loadMappedItems("prdprimitem"),
    loadMappedItems("item", { type: "rm" }),
  ]);

  const prod = prodRows.find((r) => String(r.itemdcode) === String(item_dcode));
  const rm = rmRows.find((r) => String(r.itemdcode) === String(rm_item_dcode));

  return {
    item_dcode: prod?.itemdcode != null ? Number(prod.itemdcode) : Number(item_dcode) || null,
    item_code: prod?.item_code ?? null,
    item_desc: prod?.itemdesc ?? null,
    rm_item_dcode: rm?.itemdcode != null ? Number(rm.itemdcode) : Number(rm_item_dcode) || null,
    rm_item_code: rm?.item_code ?? null,
    rm_item_desc: rm?.itemdesc ?? null,
  };
}
