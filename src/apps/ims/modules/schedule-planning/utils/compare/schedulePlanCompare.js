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

/** Empty DB snapshot field → treat as IMS (avoids false mismatch after shortage-only plan create). */
function planSnapVal(planVal, imsVal) {
  if (planVal == null || planVal === "") return imsVal;
  return planVal;
}

/** Fields shown in Comparison tab mismatch (party name/code excluded). */
export function comparisonFieldMismatch(fields, { ignoreCustomer = true } = {}) {
  if (!fields || typeof fields !== "object") return false;
  return Object.entries(fields).some(([key, f]) => {
    if (ignoreCustomer && (key === "acc_name" || key === "acc_code")) return false;
    return Boolean(f?.mismatch);
  });
}

/** Compare live ERP row (API) with our DB plan snapshot. */
export function buildScheduleComparison(imsRow, planRow) {
  if (!imsRow || !planRow) {
    return { has_mismatch: false, fields: {} };
  }
  const imsQty = imsRow.totalqty ?? imsRow.total_qty;
  const fields = {
    schmonth: compareField(imsRow.schmonth, planSnapVal(planRow.schmonth, imsRow.schmonth), normMonth),
    schdt: compareDateField(imsRow.schdt, planSnapVal(planRow.schdt, imsRow.schdt)),
    acc_code: compareField(imsRow.acc_code, planSnapVal(planRow.acc_code, imsRow.acc_code), normText),
    acc_name: compareField(imsRow.acc_name, planSnapVal(planRow.acc_name, imsRow.acc_name), normText),
    item_code: compareField(imsRow.item_code, planSnapVal(planRow.item_code, imsRow.item_code), normText),
    itemdesc: compareField(imsRow.itemdesc, planSnapVal(planRow.itemdesc, imsRow.itemdesc), normText),
    totalqty: compareField(imsQty, planSnapVal(planRow.totalqty, imsQty), normQty),
  };
  return {
    has_mismatch: comparisonFieldMismatch(fields),
    fields,
  };
}

export function hasScheduleComparisonMismatch(row) {
  if (!row) return false;
  if (row.comparison?.missing_ims) return false;
  return comparisonFieldMismatch(row.comparison?.fields);
}
