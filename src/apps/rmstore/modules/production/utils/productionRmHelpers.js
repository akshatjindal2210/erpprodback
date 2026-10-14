/** Normalize rm_items from DB/API row (JSONB array or legacy flat fields). */
export function normalizeRmItems(row) {
  if (!row) return [];
  const raw = row.rm_items;
  if (Array.isArray(raw) && raw.length) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  if (row.rm_item_dcode != null || row.rm_item_code) {
    return [
      {
        rm_item_dcode: row.rm_item_dcode ?? null,
        rm_item_code: row.rm_item_code ?? null,
        rm_item_desc: row.rm_item_desc ?? null,
      },
    ];
  }
  return [];
}

export function rmFieldList(row, key) {
  return normalizeRmItems(row)
    .map((r) => r?.[key])
    .filter((v) => v != null && String(v).trim() !== "");
}

export function productionAllowedRmCodes(prod) {
  return rmFieldList(prod, "rm_item_code").map((c) => String(c).trim()).filter(Boolean);
}

function normalizeJsonObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizePrimeProcess(row) {
  return normalizeJsonObject(row?.prime_process);
}

export function normalizeFinishProcess(row) {
  return normalizeJsonObject(row?.finish_process);
}

/** Flatten rm_items onto row for list consumers expecting legacy flat columns. */
export function enrichProductionRow(row) {
  if (!row) return row;
  const rmItems = normalizeRmItems(row);
  const rmCodes = rmFieldList(row, "rm_item_code");
  const rmDescs = rmFieldList(row, "rm_item_desc");
  const rmDcodes = rmFieldList(row, "rm_item_dcode");
  return {
    ...row,
    rm_items: rmItems,
    prime_process: normalizePrimeProcess(row),
    finish_process: normalizeFinishProcess(row),
    rm_item_code: rmCodes.join(", ") || row.rm_item_code || "",
    rm_item_desc: rmDescs.join(", ") || row.rm_item_desc || "",
    rm_item_dcode: rmDcodes[0] ?? row.rm_item_dcode ?? null,
  };
}
