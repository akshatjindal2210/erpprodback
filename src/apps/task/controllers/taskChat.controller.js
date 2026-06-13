import Task from "../models/task.model.js";
import TargetDate from "../models/targetDate.model.js";
import { isChatLockedForUser } from "../shared/utils/targetDateHelper.js";
import fs   from "fs";
import path from "path";
import config from "../../../config/config.js";

const log = (task_id, user_id, performed_by, action, action_detail = null, assignment_id = null) => Task.addLog(task_id, user_id, performed_by, action, action_detail, assignment_id);

// GET CHAT — all messages for a task
export async function getChat(req, res) {
  try {
    const { id }        = req.params;
    const currentUserId = req.user.id;

    const messages = await Task.getChatMessages(id, currentUserId);

    const data = messages.map((m) => ({
      ...m,
      is_own:      !!m.is_own,
      attachments: m.attachments
        ? (typeof m.attachments === "string" ? JSON.parse(m.attachments) : m.attachments)
        : [],
      reply: m.reply_to_id
        ? {
            chat_id:     m.reply_to_id,
            message:     m.reply_message,
            sender_name: m.reply_sender_name,
            user_id:     m.reply_user_id,
          }
        : null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error("getChat:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


// SEND MESSAGE — text + optional files + optional reply_to_id
export async function sendMessage(req, res) {
  try {
    const { id }                               = req.params;
    const user_id                              = req.user.id;
    const { message = "", reply_to_id = null } = req.body;
    const files                                = req.files ?? [];

    if (!message.trim() && files.length === 0)
      return res.status(400).json({ success: false, message: "Message or attachment required" });

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const hasValidTarget = await TargetDate.hasValidCurrent(id);
    if (isChatLockedForUser(task, hasValidTarget, user_id)) {
      return res.status(403).json({
        success: false,
        message: "Chat is locked until target date is set. Only Assigned By can send messages.",
      });
    }

    if (reply_to_id) {
      const replied = await Task.getChatById(reply_to_id, id);
      if (!replied)
        return res.status(400).json({ success: false, message: "Invalid reply_to_id" });
    }

    const attachments = files.map((f) => {
      const relativePath = path.relative(path.resolve(config.uploadPath), f.path);
      return {
        file_name: f.originalname,
        file_path: path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/"),
        file_size: f.size,
        mime_type: f.mimetype,
      };
    });

    const result  = await Task.sendChatMessage(id, user_id, message, reply_to_id, attachments);
    const chat_id = result.insertId;

    if (task && task.status === "pending") {
      await Task.updateStatus(id, "in_progress", user_id);
      await log(
        id,
        user_id,
        req.user.name ?? "Someone",
        "status_changed",
        "Status changed to In Progress (user replied)",
        null
      );
    }

    const newMsg = await Task.getChatMessageWithSender(chat_id, user_id);

    res.status(201).json({
      success: true,
      message: "Message sent",
      data: { ...newMsg, is_own: true, attachments },
    });

  } catch (err) {
    console.error("sendMessage:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


export async function deleteMessage(req, res) {
  try {
    const { id, chatId } = req.params;
    const user_id        = req.user.id;

    const msg = await Task.getRawChatMessage(chatId, id);
    if (!msg)
      return res.status(404).json({ success: false, message: "Message not found" });

    if (Number(msg.user_id) !== Number(user_id))
      return res.status(403).json({ success: false, message: "Cannot delete someone else's message" });

    const files = msg.attachments
      ? (typeof msg.attachments === "string" ? JSON.parse(msg.attachments) : msg.attachments)
      : [];
    files.forEach((f) => {
      try {
        const relativePath = f.file_path.startsWith(`${config.uploadPublicPath}/`)
          ? f.file_path.slice(config.uploadPublicPath.length + 1)
          : f.file_path;
        const fullPath = path.join(config.uploadPath, relativePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
    });

    await Task.deleteChatMessage(chatId);
    res.json({ success: true, message: "Message deleted" });
  } catch (err) {
    console.error("deleteMessage:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
