export function productionStickerPanelKey(pn, item, cust) {
  const itemNorm = String(item ?? "").trim() === "—" ? "-" : String(item ?? "").trim();
  return `${String(pn).trim()}:${itemNorm}:${String(cust ?? "").trim()}`;
}

/** Resolve sticker panel meta for a packing row (prefers ERP customer match). */
export function pickProductionStickerPanelMeta(panelMap, pn, item, cust) {
  if (!pn || !panelMap?.size) return undefined;
  const itemStr = String(item ?? "").trim();
  const itemAlt = itemStr === "—" ? "-" : itemStr;
  const c = String(cust ?? "").trim();
  const keys = [
    productionStickerPanelKey(pn, itemStr, c),
    productionStickerPanelKey(pn, itemAlt, c),
    productionStickerPanelKey(pn, itemStr, c || "-"),
    productionStickerPanelKey(pn, itemAlt, c || "-"),
    String(pn).trim(),
  ];
  for (const key of keys) {
    if (panelMap.has(key)) return panelMap.get(key);
  }
  const prefixes = [`${String(pn).trim()}:${itemStr}:`, `${String(pn).trim()}:${itemAlt}:`];
  for (const [key, val] of panelMap.entries()) {
    if (prefixes.some((p) => key.startsWith(p))) return val;
  }
  for (const [key, val] of panelMap.entries()) {
    if (key.startsWith(`${String(pn).trim()}:`)) return val;
  }
  return undefined;
}
