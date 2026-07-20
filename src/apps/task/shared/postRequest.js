/** POST body preferred; query still accepted for compatibility. */
export function paramsFromReq(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

export function parseNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/** Body-first id for POST action routes. */
export function idFromReq(req, ...keys) {
  const body = req.body || {};
  const params = req.params || {};
  for (const key of keys) {
    const n = parseNumber(body[key] ?? params[key] ?? params.id);
    if (n) return n;
  }
  return null;
}

/** Cap list page size — prefer large payloads over many round-trips. */
export function listLimit(value, fallback = 1000, max = 5000) {
  return Math.min(parseNumber(value) || fallback, max);
}
