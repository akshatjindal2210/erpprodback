import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES, PRODUCTION_TABLES } from "../../../../../config/db/dbTables.js";
import { fetchFromIMS } from "../../../../ims/lib/services/ims.service.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { enrichProductionRow, normalizeRmItems } from "./productionRmHelpers.js";
import { issueQtyKg } from "../../../../production/modules/job-card/jobCard.config.js";

const MASTER_CACHE_MS = 2 * 60 * 1000; // 2 min
const masterCache = { rm: { loadedAt: 0, data: null }, fg: { loadedAt: 0, data: null } };

function isMasterCacheFresh(entry) {
  return entry.data != null && Date.now() - entry.loadedAt < MASTER_CACHE_MS;
}

export async function rmItemMap() {
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

/**
 * Overlay Maintain Job Card (prod_job_card) onto ERP prdrunjc rows — simple:
 *   Required Qty (rm_weight) = (prime gweight × planqty) + extra %
 *   RM wire + macname from process_plan
 */
async function enrichPrdRunJcFromProdJobCards(erpRows = []) {
  if (!erpRows.length) return erpRows;

  const byNo = new Map();
  for (const r of erpRows) {
    const k = String(r.pjobcardno || "").trim().toUpperCase();
    if (k) byNo.set(k, { ...r });
  }
  if (!byNo.size) return erpRows;

  const cards = await dbQuery(
    `SELECT pjobcardno, itemdcode, shortage_ids, process_plan
     FROM ${PRODUCTION_TABLES.JOB_CARD}
     WHERE is_deleted = false
       AND UPPER(TRIM(pjobcardno)) = ANY($1::text[])`,
    [[...byNo.keys()]]
  );
  if (!cards.length) return erpRows;

  const allIds = [...new Set(cards.flatMap((c) => c.shortage_ids || []).map(Number).filter(Boolean))];
  const lines = allIds.length
    ? await dbQuery(
        `SELECT id, itemdcode, qty FROM ${IMS_TABLES.SHORTAGE}
         WHERE id = ANY($1::int[]) AND is_deleted = false`,
        [allIds]
      )
    : [];
  const bySid = new Map(lines.map((r) => [Number(r.id), r]));
  const { itemMap } = await getImsMapsSafe();
  const gweightOf = (dcode) => {
    const n = Number(itemMap.get(canonicalCode(dcode))?.gweight);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  for (const c of cards) {
    const key = String(c.pjobcardno || "").trim().toUpperCase();
    const erp = byNo.get(key);
    if (!erp) continue;

    let planqty = 0;
    for (const sid of c.shortage_ids || []) {
      const line = bySid.get(Number(sid));
      if (!line) continue;
      planqty += Number(line.qty) || 0;
    }
    const rm_weight = issueQtyKg(gweightOf(c.itemdcode), planqty) || 0;
    const part_weight =
      planqty > 0 && rm_weight > 0 ? Math.round((rm_weight / planqty) * 1e6) / 1e6 : 0;

    let rm_item_dcode = null;
    let rm_item_code = null;
    let macname = erp.macname;
    for (const step of Array.isArray(c.process_plan) ? c.process_plan : []) {
      if (!rm_item_code && (step.rm_items || []).length) {
        const rm = step.rm_items[0];
        rm_item_dcode = rm.rm_item_dcode ?? null;
        rm_item_code = rm.rm_item_code ? String(rm.rm_item_code).trim() : null;
      }
      if (!macname && (step.machines || []).length) {
        macname = step.machines[0].machine_name || null;
      }
      if (rm_item_code && macname) break;
    }

    byNo.set(key, {
      ...erp,
      itemdcode: c.itemdcode || erp.itemdcode,
      planqty: planqty > 0 ? planqty : erp.planqty,
      rm_weight: rm_weight > 0 ? rm_weight : erp.rm_weight,
      part_weight: part_weight > 0 ? part_weight : erp.part_weight,
      macname: macname || erp.macname,
      rm_item_dcode: rm_item_dcode ?? erp.rm_item_dcode ?? null,
      rm_item_code: rm_item_code || erp.rm_item_code || null,
      from_prod_job_card: true,
    });
  }

  return erpRows.map((r) => {
    const k = String(r.pjobcardno || "").trim().toUpperCase();
    return byNo.get(k) || r;
  });
}

export async function loadMappedPrdRunJc() {
  const rows = (await fetchFromIMS("prdrunjc")) || [];
  const mapped = rows
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
      rm_item_dcode: null,
      rm_item_code: null,
    }))
    .filter((r) => r.pjobcardno);
  return enrichPrdRunJcFromProdJobCards(mapped);
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
  const rmCode = row.rm_item_code ? String(row.rm_item_code).trim() : "";
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
    rm_item_dcode: row.rm_item_dcode ?? null,
    rm_item_code: rmCode || null,
    from_prod_job_card: Boolean(row.from_prod_job_card),
    label,
    sub: [itemdesc, macname, rmCode].filter(Boolean).join(" | "),
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

export function productionJcMetaKey(jc) {
  return String(jc || "")
    .replace(/^JC[\s\-]*/i, "")
    .trim()
    .toUpperCase();
}

/** Running job card master (prdrunjc) — FG + machine; JC may not exist on Issue Request yet. */
export async function findProductionJcMetaByPjobcardnos(pjobcardnos = []) {
  const keys = new Set((pjobcardnos || []).map(productionJcMetaKey).filter(Boolean));
  if (!keys.size) return new Map();

  const rows = await loadMappedPrdRunJc();
  const map = new Map();
  for (const r of rows) {
    const key = productionJcMetaKey(r.pjobcardno);
    if (!key || !keys.has(key) || map.has(key)) continue;
    map.set(key, {
      pjobcardno: r.pjobcardno,
      macname: r.macname ? String(r.macname).trim() : null,
      fg_item_code: r.item_code ? String(r.item_code).trim() : null,
      fg_item_desc: r.itemdesc ? String(r.itemdesc).trim() : null,
      itemdcode: r.itemdcode ?? null,
    });
  }
  return map;
}

/** Pending display — production master wins for FG/mac; IR adds RM when issued. */
export function mergePendingJcDisplayMeta(prodHit, irHit) {
  const prod = prodHit || {};
  const ir = irHit || {};
  return {
    pjobcardno: prod.pjobcardno || ir.pjobcardno || null,
    macname: prod.macname || ir.macname || null,
    fg_item_code: prod.fg_item_code || ir.fg_item_code || null,
    fg_item_desc: prod.fg_item_desc ?? ir.fg_item_desc ?? null,
    rm_item_code: ir.rm_item_code || null,
    rm_item_desc: ir.rm_item_desc ?? null,
  };
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

/** List/export display only — latest FG + RM labels from IMS; DB snapshot unchanged. */
export async function enrichProductionMasterRows(rows = []) {
  if (!rows.length) return rows;
  const [prodRows, rmMap] = await Promise.all([fgItemRows(), rmItemMap()]);
  const fgMap = new Map();
  for (const r of prodRows) {
    const key = canonicalCode(r.itemdcode);
    if (key) fgMap.set(key, { item_code: r.item_code ?? null, item_desc: r.itemdesc ?? null });
  }
  return rows.map((row) => {
    const fg = fgMap.get(canonicalCode(row.item_dcode));
    const rm_items = normalizeRmItems(row).map((rm) => {
      const live = rmMap.get(canonicalCode(rm.rm_item_dcode));
      return {
        ...rm,
        rm_item_code: live?.item_code ?? rm.rm_item_code ?? null,
        rm_item_desc: live?.item_desc ?? rm.rm_item_desc ?? null,
      };
    });
    return enrichProductionRow({
      ...row,
      item_code: fg?.item_code ?? row.item_code ?? null,
      item_desc: fg?.item_desc ?? row.item_desc ?? null,
      rm_items,
    });
  });
}

/** RM code / desc on stage RM items (DB keeps only rm_item_dcode). */
export async function labelStageRm(stages = [], rmMap = null) {
  const map = rmMap || (await rmItemMap());
  return stages.map((st) => ({
    ...st,
    processes: st.processes.map((p) => ({
      ...p,
      rm_items: p.rm_items.map((r) => {
        const live = map.get(canonicalCode(r.rm_item_dcode));
        return { ...r, rm_item_code: live?.item_code || `RM ${r.rm_item_dcode}`, rm_item_desc: live?.item_desc ?? null };
      }),
    })),
  }));
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