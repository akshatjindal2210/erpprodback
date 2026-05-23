import { parseFilters } from "./requestQueryParser.js";

const OPERATOR_SQL = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  in: "IN",
  nin: "NOT IN",
  like: "ILIKE"
};

const ALLOWED_LOGICS = new Set(["AND", "OR"]);

const getLogic = (logic = "AND") => (ALLOWED_LOGICS.has(String(logic).toUpperCase()) ? String(logic).toUpperCase() : "AND");

const normalizeOperator = (operator = "eq") => {
  const op = String(operator).toLowerCase();
  return OPERATOR_SQL[op] ? op : "eq";
};

const isAllowedField = (field, allowedFields) => allowedFields.includes(field);

const buildSingleFilterClause = ({ filter, values, allowedFields }) => {
  const operator = normalizeOperator(filter.operator);
  const field = filter.field;

  if (!field || !isAllowedField(field, allowedFields)) return null;

  if ((operator === "in" || operator === "nin") && Array.isArray(filter.value)) {
    if (filter.value.length === 0) return null;
    const placeholders = filter.value.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `${field} ${OPERATOR_SQL[operator]} (${placeholders.join(", ")})`;
  }

  if (filter.isRaw) {
    return `${field} ${OPERATOR_SQL[operator]} ${filter.value}`;
  }

  values.push(operator === "like" ? `%${filter.value}%` : filter.value);
  return `${field} ${OPERATOR_SQL[operator]} $${values.length}`;
};

const buildAdvancedGroup = ({ group, values, allowedFields }) => {
  if (!group || typeof group !== "object") return null;

  const logic = getLogic(group.logic);
  const clauses = [];

  for (const item of group.conditions ?? []) {
    if (item?.conditions) {
      const nestedGroup = buildAdvancedGroup({ group: item, values, allowedFields });
      if (nestedGroup) clauses.push(`(${nestedGroup})`);
      continue;
    }

    const clause = buildSingleFilterClause({ filter: item, values, allowedFields });
    if (clause) clauses.push(clause);
  }

  return clauses.length ? clauses.join(` ${logic} `) : null;
};

export const buildWhereClauses = ({
  filters = [],
  search,
  searchableFields = [],
  allowedFields = [],
  advancedSearch
} = {}) => {
  const values = [];
  const whereParts = [];

  const normalizedFilters = parseFilters(filters);
  normalizedFilters.forEach((filter, index) => {
    const clause = buildSingleFilterClause({ filter, values, allowedFields });
    if (!clause) return;

    if (whereParts.length === 0) {
      whereParts.push(clause);
      return;
    }

    const logic = index === 0 ? "AND" : getLogic(filter.logic);
    whereParts.push(`${logic} ${clause}`);
  });

  const searchValue = typeof search === "string" ? search.trim() : search?.value?.trim();
  const searchFields = Array.isArray(search?.fields) && search.fields.length
    ? search.fields.filter((field) => searchableFields.includes(field))
    : searchableFields;
  const searchLogic = getLogic(search?.logic || "OR");

  if (searchValue && searchFields.length) {
    const searchClauses = searchFields.map((field) => {
      values.push(`%${searchValue}%`);
      return `${field} ILIKE $${values.length}`;
    });
    const clause = `(${searchClauses.join(` ${searchLogic} `)})`;
    whereParts.push(whereParts.length ? `AND ${clause}` : clause);
  }

  if (advancedSearch?.conditions?.length) {
    const advancedClause = buildAdvancedGroup({
      group: { logic: advancedSearch.logic ?? "AND", conditions: advancedSearch.conditions },
      values,
      allowedFields
    });
    if (advancedClause) {
      whereParts.push(whereParts.length ? `AND (${advancedClause})` : `(${advancedClause})`);
    }
  }

  return { values, whereClause: whereParts.length ? `WHERE ${whereParts.join(" ")}` : "" };
};
