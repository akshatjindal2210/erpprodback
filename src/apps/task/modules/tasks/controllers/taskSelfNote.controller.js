import Task from "../models/task.model.js";
import { parseFileRemarks, syncRegisteredFiles } from "../../../../../lib/documents/index.js";
import { stampRmstoreUploadedFiles } from "../../../../rmstore/lib/utils/stampRmstoreUploadedFiles.js";

const SELF_NOTE_DOCS = "task_self_note";

/** Store reminder as IST wall-clock (matches DB TIMESTAMP without TZ). */
function normalizeReminderAt(value) {
  if (value == null || value === "") return null;
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:00` : null;
}

export async function getSelfNote(req, res) {
  try {
    const { id }  = req.params;
    const user_id = req.user.id;

    const note = await Task.getSelfNote(id, user_id);

    res.json({ success: true, data: note ?? null });
  } catch (err) {
    console.error("getSelfNote:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


// UPSERT SELF NOTE — create or update
export async function upsertSelfNote(req, res) {
  try {
    const { id }  = req.params;
    const user_id = req.user.id;
    const { note, reminder_at } = req.body;

    let removeFiles = [];
    if (req.body.remove_files) {
      try {
        removeFiles = typeof req.body.remove_files === "string"
          ? JSON.parse(req.body.remove_files)
          : req.body.remove_files;
      } catch { removeFiles = []; }
    }

    const existing = await Task.getSelfNoteRaw(id, user_id);

    let existingAttachments = [];
    if (existing?.attachments) {
      existingAttachments = typeof existing.attachments === "string" ? JSON.parse(existing.attachments) : (existing.attachments ?? []);
    }

    const filteredAttachments = existingAttachments.filter((a) => !removeFiles.includes(a.file_path));

    // New file uploads (uploader name + time stamped on images, like task chat)
    await stampRmstoreUploadedFiles(req);
    const newAttachments = (req.files ?? []).map((f, i) => {
      const note = parseFileRemarks(req.body, i);
      return {
        file_name: f.originalname,
        file_path: `${config.uploadPublicPath}/task_tasks/self/${f.filename}`,
        file_size: f.size,
        mime_type: f.mimetype,
        ...(note ? { remark: note } : {}),
      };
    });

    // Merge kept attachments with new uploads
    const mergedAttachments = [...filteredAttachments, ...newAttachments];

    await Task.upsertSelfNote(id, user_id, note, normalizeReminderAt(reminder_at), mergedAttachments);
    const saved = await Task.getSelfNoteRaw(id, user_id);
    await syncRegisteredFiles(SELF_NOTE_DOCS, saved?.self_note_id, mergedAttachments, req);

    const updated = await Task.getSelfNote(id, user_id);
    res.json({ success: true, message: "Self note saved", data: updated });
  } catch (err) {
    console.error("upsertSelfNote:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


export async function deleteSelfNote(req, res) {
  try {
    const { id }  = req.params;
    const user_id = req.user.id;

    const note = await Task.getSelfNoteRaw(id, user_id);
    if (!note)
      return res.status(404).json({ success: false, message: "Self note not found" });

    // Soft-deactivate documents rows only — never delete files on disk (same as IMS/RM docs).
    await syncRegisteredFiles(SELF_NOTE_DOCS, note.self_note_id, [], req);
    await Task.deleteSelfNote(id, user_id);
    res.json({ success: true, message: "Self note deleted successfully" });
  } catch (err) {
    console.error("deleteSelfNote:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Toggle recurring task status
export const toggleRecurringTaskStatus = async (req, res) => {
  try {
    const recurringId = req.params.id;

    // Fetch recurring task
    const task = await Task.getRecurringTaskById(recurringId);
    if (!task) {
      return res.status(404).json({ success: false, message: "Recurring task not found" });
    }

    // Toggle status
    const newStatus = !task.is_active;
    await Task.updateActiveStatus(recurringId, newStatus);

    // Response
    return res.json({ success: true, recurring_id: recurringId, is_active: newStatus });
  } catch (err) {
    console.error("Toggle recurring task status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};