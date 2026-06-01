const permissionsCache = new Map();

const TTL = 60 * 60 * 1000; // 1 hour in ms

/**
 * Set permissions in cache
 * @param {number|string} userId
 * @param {Array} permissions
 */
export const setCachedPermissions = (userId, permissions) => {
  const expiresAt = Date.now() + TTL;
  permissionsCache.set(userId, { permissions, expiresAt });
};

/**
 * Get permissions from cache
 * @param {number|string} userId
 * @returns {Array|null}
 */
export const getCachedPermissions = (userId) => {
  const entry = permissionsCache.get(userId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    permissionsCache.delete(userId);
    return null;
  }

  return entry.permissions;
};

export const clearCachedPermissions = (userId) => {
  permissionsCache.delete(userId);
};

export const clearAllCachedPermissions = () => {
  permissionsCache.clear();
};

setInterval(() => {
  const now = Date.now();
  for (const [userId, { expiresAt }] of permissionsCache.entries()) {
    if (now > expiresAt) {
      permissionsCache.delete(userId);
      console.log(`Cache expired for user ${userId}`);
    }
  }
}, 5 * 60 * 1000); // 5 min interval

export default permissionsCache;