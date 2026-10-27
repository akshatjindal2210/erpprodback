/**
 * Optional field conditions on notification templates.
 * Empty conditions = always match (backward compatible).
 */

export const CONDITION_OPERATORS = ["equals", "not_equals", "in", "contains", "greater_than", "less_than"];

export function normalizeConditions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const field = String(c.field ?? c.attribute ?? "").trim();
      const operator = String(c.operator ?? "equals").trim().toLowerCase();
      if (!field || !CONDITION_OPERATORS.includes(operator)) return null;
      let value = c.value;
      if (value == null) value = "";
      if (Array.isArray(value)) value = value.map((v) => String(v).trim()).filter(Boolean);
      else value = String(value).trim();
      return { field, operator, value };
    })
    .filter(Boolean);
}

export function normalizeConditionLogic(raw) {
  return String(raw || "AND").toUpperCase() === "OR" ? "OR" : "AND";
}

function getRecordValue(recordVars, field) {
  if (!recordVars || !field) return undefined;
  const key = String(field).trim();
  if (Object.prototype.hasOwnProperty.call(recordVars, key)) return recordVars[key];
  const slug = key.toLowerCase().replace(/\s+/g, "_");
  if (Object.prototype.hasOwnProperty.call(recordVars, slug)) return recordVars[slug];
  const found = Object.keys(recordVars).find(
    (k) => k.toLowerCase() === slug || k.toLowerCase() === key.toLowerCase()
  );
  return found ? recordVars[found] : undefined;
}

function toComparable(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function toNumber(v) {
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function evaluateCondition(condition, recordVars) {
  if (!condition?.field) return true;
  const left = getRecordValue(recordVars, condition.field);
  const leftStr = toComparable(left);
  const op = String(condition.operator || "equals").toLowerCase();
  const rawRight = condition.value;

  if (op === "in") {
    const list = Array.isArray(rawRight)
      ? rawRight.map(toComparable)
      : String(rawRight || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    return list.some((v) => v.toLowerCase() === leftStr.toLowerCase());
  }
  if (op === "contains") {
    return leftStr.toLowerCase().includes(toComparable(rawRight).toLowerCase());
  }
  if (op === "greater_than" || op === "less_than") {
    const a = toNumber(left);
    const b = toNumber(rawRight);
    if (a == null || b == null) return false;
    return op === "greater_than" ? a > b : a < b;
  }
  const rightStr = toComparable(rawRight);
  if (op === "not_equals") return leftStr.toLowerCase() !== rightStr.toLowerCase();
  return leftStr.toLowerCase() === rightStr.toLowerCase();
}

/** Empty conditions → true (current behaviour). */
export function evaluateTemplateConditions(tpl, recordVars) {
  const conditions = normalizeConditions(tpl?.conditions);
  if (!conditions.length) return true;
  const logic = normalizeConditionLogic(tpl?.condition_logic);
  if (logic === "OR") return conditions.some((c) => evaluateCondition(c, recordVars));
  return conditions.every((c) => evaluateCondition(c, recordVars));
}
