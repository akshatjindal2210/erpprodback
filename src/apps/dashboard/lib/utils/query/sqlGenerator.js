const MAX_ROWS = 1000;
const BLOCKED_PATTERNS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /\bcreate\b/i,
  /\breplace\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcommit\b/i,
  /\brollback\b/i,
  /\bdo\b\s+\$\$/i,
  /\bcopy\b/i,
];

const COMMENT_PATTERN = /(--.*$)|(\/\*[\s\S]*?\*\/)/gm;

function normalizeSql(rawSql = "") {
  return String(rawSql).replace(COMMENT_PATTERN, "").trim();
}

function hasMultipleStatements(sql) {
  const cleaned = sql.trim().replace(/;\s*$/, "");
  return cleaned.includes(";");
}

function assertSelectOnly(sql) {
  const upper = sql.toUpperCase();
  if (!(upper.startsWith("SELECT") || upper.startsWith("WITH"))) {
    throw new Error("Only SELECT/CTE queries are allowed.");
  }

  if (hasMultipleStatements(sql)) {
    throw new Error("Multiple SQL statements are not allowed.");
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error("Only read-only SELECT queries are allowed.");
    }
  }
}

export function validateSelectSql(rawSql) {
  const normalized = normalizeSql(rawSql);
  if (!normalized) throw new Error("SQL query is required.");
  assertSelectOnly(normalized);
  return normalized.replace(/;\s*$/, "");
}

export function toSafeLimitedSql(rawSql) {
  const validSql = validateSelectSql(rawSql);
  return `SELECT * FROM (${validSql}) AS __widget_query LIMIT ${MAX_ROWS}`;
}
