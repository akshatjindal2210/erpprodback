/**
 * PostgreSQL: order modules by `sort_order` as numbers when the value is all digits
 * (VARCHAR like "1","2","10"); non-numeric values sort last.
 * @param {string} alias Table alias (e.g. "m")
 */
export function moduleSortOrderNumericExpr(alias = "m") {
  const col = `${alias}.sort_order`;
  return `(
    CASE
      WHEN trim(COALESCE(${col}::text, '')) ~ '^[0-9]+$'
      THEN trim(${col})::bigint
      ELSE 2147483647::bigint
    END
  )`;
}
