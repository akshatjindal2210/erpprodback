/** Packing numbers allowed for a forwarding note row when a category is selected. */

function normalizePackingKey(packingNumber) {
  const pn = String(packingNumber ?? "").trim();
  if (!pn || pn === "-") return "";
  const asNum = Number(pn);
  if (Number.isFinite(asNum) && String(asNum) === pn) return String(asNum);
  return pn;
}

export function buildPackingNumberSet(rows = []) {
  const set = new Set();
  for (const row of rows || []) {
    const key = normalizePackingKey(row?.packing_number ?? row);
    if (key) set.add(key);
  }
  return set;
}

export function packingNumberAllowed(allowedSet, packingNumber) {
  if (!allowedSet) return true;
  if (!(allowedSet instanceof Set)) return true;
  if (allowedSet.size === 0) return true;
  const pn = normalizePackingKey(packingNumber);
  if (!pn) return false;
  if (allowedSet.has(pn)) return true;
  const asNum = Number(pn);
  if (Number.isFinite(asNum)) return allowedSet.has(String(asNum));
  return false;
}

export function filterForwardingBoxesByCategory(boxes = [], allowedSet) {
  if (allowedSet == null) return boxes;
  if (!(allowedSet instanceof Set)) return boxes;
  if (allowedSet.size === 0) return [];
  return (boxes || []).filter((box) => packingNumberAllowed(allowedSet, box?.packing_number));
}

/** Legacy rows without category_id are treated as OEM (same default as new stock adjustments). */
export const FORWARDING_DEFAULT_CATEGORY_ID = 1;

export function resolveForwardingBoxCategoryId(box) {
  const n = Number(box?.category_id);
  if (Number.isFinite(n) && n > 0) return n;
  return FORWARDING_DEFAULT_CATEGORY_ID;
}

/** Direct filter on resolved box category — no packing joins. */
export function filterForwardingBoxesByCategoryId(boxes = [], categoryId) {
  if (categoryId == null || categoryId === "") return boxes;
  const catId = Number(categoryId);
  if (!Number.isFinite(catId) || catId <= 0) return [];
  return (boxes || []).filter((box) => resolveForwardingBoxCategoryId(box) === catId);
}

export function filterErpStockByCategory(summary = {}, allowedSet) {
  if (allowedSet == null) {
    return {
      total: Number(summary?.total) || 0,
      byPacking: summary?.byPacking && typeof summary.byPacking === "object"
        ? summary.byPacking
        : {},
      records: Array.isArray(summary?.records) ? summary.records : [],
    };
  }

  if (!(allowedSet instanceof Set)) {
    return {
      total: Number(summary?.total) || 0,
      byPacking: summary?.byPacking && typeof summary.byPacking === "object"
        ? summary.byPacking
        : {},
      records: Array.isArray(summary?.records) ? summary.records : [],
    };
  }

  if (allowedSet.size === 0) {
    return { total: 0, byPacking: {}, records: [] };
  }

  const byPacking = {};
  let total = 0;
  const source =
    summary?.byPacking && typeof summary.byPacking === "object" ? summary.byPacking : {};

  for (const [pn, qty] of Object.entries(source)) {
    if (!packingNumberAllowed(allowedSet, pn)) continue;
    const n = Number(qty) || 0;
    byPacking[pn] = n;
    total += n;
  }

  const records = (Array.isArray(summary?.records) ? summary.records : []).filter((rec) =>
    packingNumberAllowed(allowedSet, rec?.doc_no)
  );

  return { total, byPacking, records };
}
