/** Small in-memory cache — TTL + max keys (same idea as permissionCache.js). */

export function createBoundedTtlCache({ ttlMs, maxEntries = 64, label = "cache" }) {
  const map = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (now - entry.at > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  function has(key) {
    const entry = map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.at > ttlMs) {
      map.delete(key);
      return false;
    }
    return true;
  }

  function get(key) {
    if (!has(key)) return null;
    return map.get(key).value;
  }

  function set(key, value) {
    map.set(key, { at: Date.now(), value });
    sweep();
  }

  function del(key) {
    map.delete(key);
  }

  return { get, has, set, delete: del, sweep, size: () => map.size };
}

export function startCacheSweep(cache, intervalMs = 5 * 60 * 1000) {
  const id = setInterval(() => cache.sweep(), intervalMs);
  if (typeof id.unref === "function") id.unref();
  return id;
}
