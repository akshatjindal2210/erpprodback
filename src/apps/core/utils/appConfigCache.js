/** Short TTL cache for `ims_app_config` reads (rarely changes; hit on every inward/scan/sticker). */

const TTL_MS = 120_000;
const cache = new Map();

export function getCachedAppConfig(key) {
  const entry = cache.get(String(key));
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(String(key));
    return undefined;
  }
  return entry.value;
}

export function setCachedAppConfig(key, value) {
  cache.set(String(key), { value, expires: Date.now() + TTL_MS });
}

export function invalidateAppConfigCache(config_key) {
  if (config_key != null && String(config_key).trim() !== "") {
    cache.delete(String(config_key));
    return;
  }
  cache.clear();
}
