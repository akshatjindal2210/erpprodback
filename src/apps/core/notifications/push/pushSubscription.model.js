import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";

const PushSubscription = {
  async upsert({
    device_id,
    user_id = null,
    user_name = null,
    device_name = null,
    endpoint,
    p256dh,
    auth,
    user_agent = null,
  }) {
    const rows = await dbQuery(
      `INSERT INTO ${M.PUSH_SUBSCRIPTIONS}
         (device_id, user_id, user_name, device_name, endpoint, p256dh, auth, user_agent, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
       ON CONFLICT (endpoint) DO UPDATE SET
         device_id = EXCLUDED.device_id,
         user_id = COALESCE(EXCLUDED.user_id, ${M.PUSH_SUBSCRIPTIONS}.user_id),
         user_name = COALESCE(EXCLUDED.user_name, ${M.PUSH_SUBSCRIPTIONS}.user_name),
         device_name = COALESCE(EXCLUDED.device_name, ${M.PUSH_SUBSCRIPTIONS}.device_name),
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = COALESCE(EXCLUDED.user_agent, ${M.PUSH_SUBSCRIPTIONS}.user_agent),
         linked_at = CASE
           WHEN EXCLUDED.user_id IS NOT NULL THEN CURRENT_TIMESTAMP
           ELSE ${M.PUSH_SUBSCRIPTIONS}.linked_at
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING subscription_id, device_id, device_name, user_id, user_name, endpoint, p256dh, auth`,
      [device_id, user_id, user_name, device_name, endpoint, p256dh, auth, user_agent, user_id]
    );
    return rows[0] ?? null;
  },

  async linkDeviceToUser(device_id, user_id, { user_name = null, device_name = null } = {}) {
    if (!device_id || !user_id) return { count: 0 };
    const rows = await dbQuery(
      `UPDATE ${M.PUSH_SUBSCRIPTIONS}
       SET user_id = ?,
           user_name = ?,
           device_name = COALESCE(?, device_name),
           linked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?
       RETURNING subscription_id, device_id, user_id, user_name, device_name`,
      [user_id, user_name, device_name, device_id]
    );
    return { count: rows.length, rows };
  },

  async unlinkDevice(device_id, { user_id = null, force = false } = {}) {
    if (!device_id) return { count: 0 };
    const whereClauses = ["device_id = ?"];
    const params = [device_id];

    if (!force && user_id) {
      whereClauses.push("user_id = ?");
      params.push(user_id);
    }

    const rows = await dbQuery(
      `UPDATE ${M.PUSH_SUBSCRIPTIONS}
       SET user_id = NULL,
           user_name = NULL,
           linked_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE ${whereClauses.join(" AND ")}
       RETURNING subscription_id`,
      params
    );
    return { count: rows.length };
  },

  async removeByEndpoint(endpoint) {
    if (!endpoint) return;
    await dbQuery(`DELETE FROM ${M.PUSH_SUBSCRIPTIONS} WHERE endpoint = ?`, [endpoint]);
  },

  async removeByDevice(device_id) {
    if (!device_id) return;
    await dbQuery(`DELETE FROM ${M.PUSH_SUBSCRIPTIONS} WHERE device_id = ?`, [device_id]);
  },

  /** All linked devices for a user — multi-device delivery. */
  async listByUserId(userId) {
    const rows = await dbQuery(
      `SELECT subscription_id, device_id, device_name, user_id, user_name, endpoint, p256dh, auth
       FROM ${M.PUSH_SUBSCRIPTIONS}
       WHERE user_id = ?
       ORDER BY linked_at DESC NULLS LAST, updated_at DESC`,
      [userId]
    );
    return rows;
  },

  async listByDeviceId(deviceId) {
    const rows = await dbQuery(
      `SELECT subscription_id, device_id, device_name, user_id, user_name, endpoint, p256dh, auth
       FROM ${M.PUSH_SUBSCRIPTIONS}
       WHERE device_id = ?`,
      [deviceId]
    );
    return rows;
  },

  async touchLastUsed(subscriptionId) {
    await dbQuery(
      `UPDATE ${M.PUSH_SUBSCRIPTIONS}
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE subscription_id = ?`,
      [subscriptionId]
    );
  },
};

export default PushSubscription;
