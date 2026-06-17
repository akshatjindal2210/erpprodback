import Task from "../models/task.model.js";
import fs   from "fs";
import config from "../../../config/config.js";

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

    // New file uploads
    const newAttachments = (req.files ?? []).map(f => ({
      file_name: f.originalname,
      file_path: `${config.uploadPublicPath}/task_tasks/self/${f.filename}`,
      file_size: f.size,
      mime_type: f.mimetype,
    }));

    // Merge kept attachments with new uploads
    const mergedAttachments = [...filteredAttachments, ...newAttachments];

    await Task.upsertSelfNote(id, user_id, note, normalizeReminderAt(reminder_at), mergedAttachments);

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

    if (note.attachments) {
      const files = typeof note.attachments === "string"
        ? JSON.parse(note.attachments)
        : (note.attachments ?? []);
      files.forEach(f => {
        try {
          const relativePath = f.file_path.startsWith(`${config.uploadPublicPath}/`)
            ? f.file_path.slice(config.uploadPublicPath.length + 1)
            : f.file_path;
          const fullPath = path.join(config.uploadPath, relativePath);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch {}
      });
    }

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