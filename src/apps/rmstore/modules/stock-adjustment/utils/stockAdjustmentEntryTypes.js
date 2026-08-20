/** RM Stock Adjustment entry types — Add/Minus unchanged; Old is add-like with lot gate. */

export function normalizeSaEntryType(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "new") return "old";
  if (t === "add" || t === "minus" || t === "old") return t;
  return null;
}

export function isSaAddLikeEntryType(entryType) {
  const t = normalizeSaEntryType(entryType);
  return t === "add" || t === "old";
}

export function isSaLotGateEntryType(entryType) {
  return normalizeSaEntryType(entryType) === "old";
}

export function saEntryTypeNeedsFinancialYear(entryType) {
  const t = normalizeSaEntryType(entryType);
  return t === "add" || t === "old";
}

/** SQL: qty sums on an MRN (includes legacy `new` rows). */
export const SA_ADD_LIKE_ENTRY_TYPES_SQL = "('add', 'new', 'old')";

function readTrimmed(body, ...keys) {
  for (const key of keys) {
    const v = body?.[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/** Gate meta parsed for DB — null fields when not applicable for type. */
export function parseSaGateMeta(body = {}, entryType = null) {
  const t = normalizeSaEntryType(entryType || body?.entry_type);
  return {
    entry_type: t,
    financial_year: saEntryTypeNeedsFinancialYear(t)
      ? readTrimmed(body, "financial_year", "financialYear")
      : null,
    it_lot_no: isSaLotGateEntryType(t) ? readTrimmed(body, "it_lot_no", "itLotNo") : null,
  };
}

/** Only non-null meta columns to INSERT (Add: FY; Old: FY + lot; Minus: none). */
export function saMetaFieldsForSave(body = {}, entryType = null) {
  const { financial_year, it_lot_no } = parseSaGateMeta(body, entryType);
  const out = {};
  if (financial_year != null) out.financial_year = financial_year;
  if (it_lot_no != null) out.it_lot_no = it_lot_no;
  return out;
}

/** Parse approved flag from DB/API (boolean, 0/1, t/f). */
export function normalizeSaApproved(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === "") return false;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "t", "yes", "y", "approved", "authorized"].includes(s)) return true;
  if (["false", "0", "f", "no", "n", "pending", "draft"].includes(s)) return false;
  return false;
}

export function assertSaGateMetaFields(body = {}, entryType = null) {
  const { entry_type: t, financial_year, it_lot_no } = parseSaGateMeta(body, entryType);
  if (!t) return;
  if (saEntryTypeNeedsFinancialYear(t) && !financial_year) {
    const err = new Error("Financial year is required for this adjustment type.");
    err.statusCode = 400;
    throw err;
  }
  if (isSaLotGateEntryType(t) && !it_lot_no) {
    const err = new Error("Lot number is required for Old adjustments.");
    err.statusCode = 400;
    throw err;
  }
}
