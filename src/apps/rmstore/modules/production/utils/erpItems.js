import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";

const MASTER_CACHE_MS = 2 * 60 * 1000; // 2 min
const masterCache = { rm: { loadedAt: 0, data: null }, fg: { loadedAt: 0, data: null } };

function isMasterCacheFresh(entry) {
  return entry.data != null && Date.now() - entry.loadedAt < MASTER_CACHE_MS;
}

async function rmItemMap() {
  if (isMasterCacheFresh(masterCache.rm)) return masterCache.rm.data;
  const map = new Map();
  for (const row of await loadMappedItems("item", { type: "rm" })) {
    const key = canonicalCode(row.itemdcode);
    if (!key) continue;
    map.set(key, { item_code: row.item_code ?? null, item_desc: row.itemdesc ?? null });
  }
  masterCache.rm = { loadedAt: Date.now(), data: map };
  return map;
}

async function fgItemRows() {
  if (isMasterCacheFresh(masterCache.fg)) return masterCache.fg.data;
  const rows = await loadMappedItems("prdprimitem");
  masterCache.fg = { loadedAt: Date.now(), data: rows };
  return rows;
}

// 1. Data Loaders & Mappers
export async function loadMappedItems(reqData, filter) {
  const rows = (await fetchFromIMS(reqData, filter)) || [];
  return rows
    .map((r) => ({
      itemdcode: r.ItemDcode ?? r.itemdcode ?? r.item_dcode,
      item_code: r.Item_Code ?? r.item_code ?? r.itemcode ?? null,
      itemdesc: r.ItemDesc ?? r.itemdesc ?? r.item_desc ?? null,
      grpname: r.Grpname ?? r.grpname ?? null,
    }))
    .filter((r) => r.itemdcode);
}

export async function loadMappedPrdRunJc() {
  const rows = (await fetchFromIMS("prdrunjc")) || [];
  return rows
    .map((r) => ({
      pjobcardno: String(r.pjobcardno ?? r.Pjobcardno ?? r.PJobCardNo ?? "").trim(),
      pldt: r.pldt ?? r.Pldt ?? r.PLDt ?? null,
      item_code: r.item_code ?? r.Item_Code ?? r.itemcode ?? r.ItemCode ?? null,
      itemdcode: r.itemdcode ?? r.ItemDcode ?? r.item_dcode ?? r.ItemDCode ?? null,
      planqty: Number(r.planqty ?? r.PlanQty ?? r.plan_qty ?? r.Planqty ?? 0) || 0,
      itemdesc: r.itemdesc ?? r.ItemDesc ?? r.item_desc ?? r.Item_Desc ?? null,
      macname: r.macname ?? r.MacName ?? r.mac_name ?? r.machine ?? r.Machine ?? r.MachineName ?? null,
      part_weight: Number(r.part_weight ?? r.partweight ?? r.PartWeight ?? r.PartWt ?? r.partwt ?? r.pwt ?? 0) || 0,
      rm_weight: Number(r.rm_weight ?? r.rmweight ?? r.RMWeight ?? r.RmWt ?? r.rmwt ?? r.rm_wt ?? 0) || 0,
    }))
    .filter((r) => r.pjobcardno);
}

// 2. Picker Formatters
export function toPickerRow(item) {
  return {
    id: item.itemdcode,
    itemdcode: item.itemdcode,
    item_code: item.item_code,
    itemdesc: item.itemdesc,
  };
}

export function toPrdRunJcPickerRow(row) {
  const pjobcardno = row.pjobcardno;
  const item_code = row.item_code ? String(row.item_code).trim() : "";
  const itemdesc = row.itemdesc ? String(row.itemdesc).trim() : "";
  const macname = row.macname ? String(row.macname).trim() : "";
  const label = item_code ? `${pjobcardno} (${item_code})` : pjobcardno;
  return {
    id: pjobcardno,
    pjobcardno,
    pldt: row.pldt,
    item_code: row.item_code,
    itemdcode: row.itemdcode,
    planqty: row.planqty,
    itemdesc: row.itemdesc,
    macname: row.macname,
    part_weight: row.part_weight,
    rm_weight: row.rm_weight,
    label,
    sub: [itemdesc, macname].filter(Boolean).join(" | "),
  };
}

// 3. Search & Pagination Helpers
export function filterItemsBySearch(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.item_code, r.itemdesc, r.grpname, r.itemdcode].some((v) =>
      String(v ?? "").toLowerCase().includes(q)
    )
  );
}

export function filterPrdRunJcBySearch(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.pjobcardno, r.item_code, r.itemdesc, r.macname, r.itemdcode].some((v) =>
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

// 4. DB Snapshot Resolver
export async function resolveProductionSnapshot(item_dcode, rm_items = []) {
  const [prodRows, rmMap] = await Promise.all([fgItemRows(), rmItemMap()]);
  const prod = prodRows.find((r) => String(r.itemdcode) === String(item_dcode));

  const mappedRm = rm_items
    .map((rm) => {
      const dcode = rm?.rm_item_dcode ?? rm?.itemdcode ?? rm;
      const rm_item_dcode = Number(dcode);
      if (!Number.isFinite(rm_item_dcode) || rm_item_dcode <= 0) return null;
      const found = rmMap.get(canonicalCode(rm_item_dcode));
      return {
        rm_item_dcode,
        rm_item_code: found?.item_code || rm?.rm_item_code || "",
        rm_item_desc: found?.item_desc || rm?.rm_item_desc || "",
      };
    })
    .filter(Boolean);

  if (!mappedRm.length) {
    const err = new Error("At least one valid RM item is required.");
    err.statusCode = 400;
    throw err;
  }

  return {
    item_dcode: Number(item_dcode),
    item_code: prod?.item_code || "",
    item_desc: prod?.itemdesc || "",
    rm_items: mappedRm,
  };
}

export async function applyRmMasterLabels(fields, existing = {}) {
  const dcode = canonicalCode(fields.item_dcode ?? existing.item_dcode);
  const acc = canonicalCode(fields.acc_code ?? existing.acc_code);
  const [items, ims] = await Promise.all([dcode ? rmItemMap() : null, acc ? getImsMapsSafe() : null]);
  if (dcode && items) Object.assign(fields, items.get(dcode) || {});
  if (acc && ims) {
    const name = ims.ledgerMap.get(acc);
    if (name?.trim()) fields.acc_name = String(name).trim();
  }
  return fields;
}

export async function enrichRmMasterRows(rows = []) {
  if (!rows.length) return rows;
  const [items, { ledgerMap }] = await Promise.all([rmItemMap(), getImsMapsSafe()]);
  return rows.map((row) => {
    const item = items.get(canonicalCode(row.item_dcode));
    const acc = canonicalCode(row.acc_code);
    return {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? null,
      item_desc: item?.item_desc ?? row.item_desc ?? null,
      acc_name: (acc && ledgerMap.get(acc)) || row.acc_name || null,
    };
  });
}

export async function mergeProductionSnapshot(base, prod, cache = null) {
  const key = String(prod?.production_id ?? prod?.item_dcode ?? "");
  if (cache?.has(key)) return cache.get(key);
  try {
    const f = await resolveProductionSnapshot(prod.item_dcode, prod.rm_items ?? base.rm_items);
    const rm = f.rm_items;
    const out = {
      ...base,
      item_code: f.item_code || base.item_code,
      item_desc: f.item_desc || base.item_desc,
      rm_items: rm,
      rm_item_dcode: rm[0]?.rm_item_dcode ?? base.rm_item_dcode,
      rm_item_code: rm[0]?.rm_item_code ?? base.rm_item_code,
      rm_item_desc: rm[0]?.rm_item_desc ?? base.rm_item_desc,
      rm_item_codes: rm.map((r) => r.rm_item_code).filter(Boolean),
    };
    cache?.set(key, out);
    return out;
  } catch {
    return base;
  }
}