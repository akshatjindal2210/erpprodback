import Task from "../models/task.model.js";
import TargetDate from "../../reminders/models/targetDate.model.js";
import { isChatLockedForUser } from "../../../lib/shared/utils/targetDateHelper.js";
import { sendTaskNotification } from "../../../manage/notifications/services/notification.service.js";
import { attachmentsFromDocuments, mapMulterFilesWithRemarks, moduleDocuments, publicPathOf } from "../../../../../lib/documents/index.js";
import { DOC_FILE_LINKS, fileDocPath } from "../../../../../lib/documents/documents.config.js";
import { isUuidExtFile, normDocPath, uploadDocName } from "../../../../../lib/documents/documents.utils.js";
import { stampRmstoreUploadedFiles } from "../../../../rmstore/lib/utils/stampRmstoreUploadedFiles.js";

const MODULE = "tasks";
const taskDocuments = moduleDocuments(MODULE);

/** After `task_chat` row exists: write multer files to `documents` + `doc_files` (not JSON `attachments`). */
export async function persistTaskChatUploads(req, chat_id) {
  const ref = chat_id?.insertId ?? chat_id;
  if (!ref || !req.files?.length) return [];
  await stampRmstoreUploadedFiles(req);
  const fileEntries = mapMulterFilesWithRemarks(req, publicPathOf);
  if (!fileEntries.length) {
    console.warn(
      "[tasks] files on request but no doc path — documents row skipped",
      (req.files || []).map((f) => f.path)
    );
    return [];
  }
  return taskDocuments.saveFiles(ref, fileEntries, req);
}

const log = (task_id, user_id, performed_by, action, action_detail = null, assignment_id = null) =>
  Task.addLog(task_id, user_id, performed_by, action, action_detail, assignment_id);

function buildMessagePreview(message, attachments) {
  const text = String(message ?? "").trim();
  if (text) return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  if (attachments?.length) return `[${attachments.length} attachment(s)]`;
  return "";
}

async function getTaskChatRecipientIds(task_id, senderId) {
  const [task, chain] = await Promise.all([Task.getById(task_id), Task.getAssignmentChain(task_id)]);
  const ids = new Set();

  if (task?.created_by_id) ids.add(Number(task.created_by_id));
  if (task?.assigned_by_id) ids.add(Number(task.assigned_by_id));

  for (const a of chain) {
    if (a.is_active === 1 || a.is_active === true) {
      if (a.assigned_to_id) ids.add(Number(a.assigned_to_id));
    }
  }

  ids.delete(Number(senderId));
  return [...ids].filter((id) => Number.isFinite(id) && id > 0);
}

async function notifyTaskChatParticipants(task_id, senderId, senderName, messagePreview) {
  const recipientIds = await getTaskChatRecipientIds(task_id, senderId);
  if (!recipientIds.length) return;

  const vars = {
    sender_name: senderName,
    message_preview: messagePreview,
  };

  for (const recipientId of recipientIds) {
    void sendTaskNotification("chat_message", recipientId, vars, Number(task_id));
  }
}

function parseDocFiles(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Paths from `task_chat.doc_files` (`<uuid>.<ext>`) + module folder — no `documents` read. */
function attachmentsFromDocFiles(doc_files) {
  const folder = DOC_FILE_LINKS.tasks.folder;
  return parseDocFiles(doc_files)
    .map((n) => String(n).trim().toLowerCase())
    .filter(isUuidExtFile)
    .map((name) => {
      const file_path = normDocPath(fileDocPath(folder, name));
      return {
        file_name: uploadDocName(file_path),
        file_path,
        file_size: 0,
        remark: null,
        document_id: null,
      };
    });
}

async function attachmentsForChatMessage(row) {
  const fromModule = attachmentsFromDocFiles(row?.doc_files);
  if (fromModule.length) return fromModule;
  return attachmentsFromDocuments(MODULE, row.chat_id, [], "task");
}

// GET CHAT — all messages for a task
export async function getChat(req, res) {
  try {
    const { id } = req.params;
    const currentUserId = req.user.id;

    const messages = await Task.getChatMessages(id, currentUserId);

    const data = await Promise.all(
      messages.map(async (m) => ({
        ...m,
        is_own: !!m.is_own,
        attachments: await attachmentsForChatMessage(m),
        reply: m.reply_to_id
          ? {
              chat_id: m.reply_to_id,
              message: m.reply_message,
              sender_name: m.reply_sender_name,
              user_id: m.reply_user_id,
            }
          : null,
      }))
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error("getChat:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// SEND MESSAGE — text + optional files + optional reply_to_id
export async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.id;
    const { message = "", reply_to_id = null } = req.body;

    const fileEntries = mapMulterFilesWithRemarks(req, publicPathOf);

    if (!message.trim() && !req.files?.length) {
      return res.status(400).json({ success: false, message: "Message or attachment required" });
    }
    if (req.files?.length && !fileEntries.length) {
      return res.status(400).json({ success: false, message: "Could not store attachment. Please try again." });
    }

    const task = await Task.getById(id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const staffType = String(req.user.type || "").toLowerCase();
    if (task.status === "completed" && staffType !== "super_admin" && staffType !== "admin") {
      return res.status(400).json({ success: false, message: "Chat is locked. Task is completed." });
    }

    const hasValidTarget = await TargetDate.hasValidCurrent(id);
    if (isChatLockedForUser(task, hasValidTarget, user_id)) {
      return res.status(403).json({
        success: false,
        message: "Chat is locked until target date is set. Only Assigned By can send messages.",
      });
    }

    if (reply_to_id) {
      const replied = await Task.getChatById(reply_to_id, id);
      if (!replied) return res.status(400).json({ success: false, message: "Invalid reply_to_id" });
    }

    const result = await Task.sendChatMessage(id, user_id, message, reply_to_id, null);
    const chat_id = result.insertId;

    if (req.files?.length) {
      await persistTaskChatUploads(req, chat_id);
    }

    const attachments = await attachmentsFromDocuments(MODULE, chat_id, [], "task");

    const senderName = req.user.name ?? "Someone";
    const messagePreview = buildMessagePreview(message, attachments);

    await log(id, user_id, senderName, "chat_message_sent", messagePreview, null);

    void notifyTaskChatParticipants(id, user_id, senderName, messagePreview);

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
    const user_id = req.user.id;

    const msg = await Task.getRawChatMessage(chatId, id);
    if (!msg) return res.status(404).json({ success: false, message: "Message not found" });

    if (
      Number(msg.user_id) !== Number(user_id) &&
      req.user.type !== "super_admin" &&
      req.user.type !== "admin"
    ) {
      return res.status(403).json({ success: false, message: "Cannot delete someone else's message" });
    }

    await taskDocuments.removeAllActive(chatId);
    await Task.deleteChatMessage(chatId);
    res.json({ success: true, message: "Message deleted" });
  } catch (err) {
    console.error("deleteMessage:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
