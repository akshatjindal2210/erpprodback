function normText(v) {
  if (v == null) return "";
  return String(v).trim().toUpperCase();
}

function normQty(v) {
  const n = parseFloat(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normMonth(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normDateKey(v) {
  if (v == null || String(v).trim() === "") return "";
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return normText(s);
  return d.toISOString().slice(0, 10);
}

function compareField(imsVal, localVal, normalize) {
  const normIms = normalize(imsVal);
  const normLocal = normalize(localVal);
  return {
    ims: normIms || imsVal,
    local: normLocal || localVal,
    mismatch: normIms !== normLocal,
  };
}

function compareDateField(imsVal, localVal) {
  const imsKey = normDateKey(imsVal);
  const localKey = normDateKey(localVal);
  return {
    ims: imsKey || imsVal,
    local: localKey || localVal,
    mismatch: imsKey !== localKey && Boolean(imsKey || localKey),
  };
}

/** Compare live IMS row with DB plan snapshot. */
export function buildScheduleComparison(imsRow, planRow) {
  if (!imsRow || !planRow) {
    return { has_mismatch: false, fields: {} };
  }
  const fields = {
    schmonth: compareField(imsRow.schmonth, planRow.schmonth, normMonth),
    schdt: compareDateField(imsRow.schdt, planRow.schdt),
    acc_code: compareField(imsRow.acc_code, planRow.acc_code, normText),
    acc_name: compareField(imsRow.acc_name, planRow.acc_name, normText),
    item_code: compareField(imsRow.item_code, planRow.item_code, normText),
    itemdesc: compareField(imsRow.itemdesc, planRow.itemdesc, normText),
    totalqty: compareField(
      imsRow.totalqty ?? imsRow.total_qty,
      planRow.totalqty,
      normQty
    ),
  };
  return {
    has_mismatch: Object.values(fields).some((f) => f.mismatch),
    fields,
  };
}

export function hasScheduleComparisonMismatch(row) {
  if (!row) return false;
  if (row.comparison?.missing_ims) return true;
  return Boolean(row.has_comparison_mismatch ?? row.comparison?.has_mismatch);
}
