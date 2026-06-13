import Inbox from "../models/inbox.model.js";

function userId(req) {
  return req.user?.id;
}

function parsePage(req) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

export async function getInbox(req, res) {
  try {
    const app_type = req.query.app_type || null;
    const { limit, offset } = parsePage(req);
    const uid = userId(req);

    const [items, total] = await Promise.all([
      Inbox.listUnread(uid, { app_type, limit, offset }),
      Inbox.countUnread(uid, { app_type }),
    ]);

    res.json({
      success: true,
      data: items,
      meta: { total, limit, offset, has_more: offset + items.length < total },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getInboxUnreadCount(req, res) {
  try {
    const app_type = req.query.app_type || null;
    const count = await Inbox.countUnread(userId(req), { app_type });
    res.json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function markInboxRead(req, res) {
  try {
    await Inbox.markRead(req.params.id, userId(req));
    res.json({ success: true, message: "Marked as read" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function markAllInboxRead(req, res) {
  try {
    const app_type = req.query.app_type || null;
    await Inbox.markAllRead(userId(req), { app_type });
    res.json({ success: true, message: "All marked as read" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
