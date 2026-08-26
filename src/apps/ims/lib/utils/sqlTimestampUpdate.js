/**
 * TIMESTAMP WITHOUT TIME ZONE updates / inserts.
 *
 * Never bind `new Date().toISOString()` into these columns — that stores UTC
 * wall-clock while `created_at DEFAULT NOW()` stores local IST.
 * Non-null clock fields use SQL NOW() so they match create time.
 *
 * Explicit `null` still clears the column (e.g. un-approve).
 */

const DEFAULT_NOW_KEYS = ["updated_at", "approved_at", "inspected_at", "deleted_at"];

/**
 * @param {Record<string, unknown>} fields
 * @param {{ nowKeys?: string[], jsonKeys?: Set<string>|string[] }} [opts]
 * @returns {{ setParts: string[], values: unknown[], nextIndex: number }}
 */
export function buildNaiveTimestampUpdateParts(fields = {}, opts = {}) {
  const nowKeys = new Set(opts.nowKeys || DEFAULT_NOW_KEYS);
  const jsonKeys = opts.jsonKeys instanceof Set
    ? opts.jsonKeys
    : new Set(opts.jsonKeys || []);

  const setParts = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (nowKeys.has(key) && value != null) {
      setParts.push(`${key} = NOW()`);
      continue;
    }
    if (jsonKeys.has(key)) {
      setParts.push(`${key} = $${i++}::jsonb`);
      if (value == null) values.push(null);
      else if (typeof value === "string") values.push(value);
      else values.push(JSON.stringify(value));
      continue;
    }
    setParts.push(`${key} = $${i++}`);
    values.push(value);
  }

  return { setParts, values, nextIndex: i };
}

/**
 * Same NOW() rules for INSERT column lists.
 * @returns {{ cols: string[], placeholders: string[], values: unknown[] }}
 */
export function buildNaiveTimestampInsertParts(fields = {}, opts = {}) {
  const nowKeys = new Set(opts.nowKeys || DEFAULT_NOW_KEYS);
  const jsonKeys = opts.jsonKeys instanceof Set
    ? opts.jsonKeys
    : new Set(opts.jsonKeys || []);

  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    cols.push(key);
    if (nowKeys.has(key) && value != null) {
      placeholders.push("NOW()");
      continue;
    }
    if (jsonKeys.has(key)) {
      placeholders.push(`$${i++}::jsonb`);
      if (value == null) values.push(null);
      else if (typeof value === "string") values.push(value);
      else values.push(JSON.stringify(value));
      continue;
    }
    placeholders.push(`$${i++}`);
    values.push(value);
  }

  return { cols, placeholders, values };
}
