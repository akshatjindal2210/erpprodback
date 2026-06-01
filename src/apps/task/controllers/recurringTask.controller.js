import fs from "fs";
import RecurringTask from "../models/recurringTask.model.js";
import { chatMessage, parseSubUsers, parseAttachmentsJson, asArray } from "../shared/index.js";

// Utility to parse numbers safely
const parseNumber = (value) => {
  const n = Number(value);
  return isNaN(n) ? undefined : n;
};

// GET /recurring-task_tasks
export async function getRecurringTasks(req, res) {
  try {
    const { search = "", page = 1, limit = 10, sortBy = "recurring_id", order = "ASC", dateFrom, dateTo, department_id, user_id, } = req.query;

    const requestingUser = req.user;

    const role = (requestingUser.type ?? "user").toLowerCase();

    let filterDepartmentId;
    let filterUserId;

    if (role === "super_admin" || role === "admin") {
      filterDepartmentId = parseNumber(department_id);
      filterUserId = parseNumber(user_id);
      
    } else {
      filterUserId = requestingUser.id;
    }

    const filterParams = {
      search,
      page: parseNumber(page) || 1,
      limit: parseNumber(limit) || 10,
      sortBy,
      order: order.toUpperCase() === "DESC" ? "DESC" : "ASC",
      dateFrom,
      dateTo,
      department_id: filterDepartmentId,
      user_id: filterUserId,
    };

    const [items, total, stats] = await Promise.all([
      RecurringTask.getAll(filterParams),
      RecurringTask.count(filterParams),
      RecurringTask.getStats(filterParams),
    ]);

    res.json({
      success: true,
      message: "Recurring task_tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit),
        data: items ?? [],
        stats: stats ?? { total: 0, active: 0, inactive: 0, today: 0 },
      },
    });

  } catch (err) {
    console.error("getRecurringTasks:", err.stack || err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch recurring task_tasks",
    });
  }
}

// GET /recurring-task_tasks/:id
export async function getRecurringTaskById(req, res) {
  try {
    const { id } = req.params;
    const task = await RecurringTask.getById(id);

    if (!task || (Array.isArray(task) && task.length === 0)) {
      return res.status(404).json({ success: false, message: "Recurring task not found" });
    }

    const data = Array.isArray(task) ? task[0] : task;

    res.json({ success: true, message: "Recurring task fetched successfully", data });
  } catch (err) {
    console.error("getRecurringTaskById:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch recurring task" });
  }
}

// POST /recurring-task_tasks
export async function createRecurringTask(req, res) {
  try {
    const { task_id, recurrence_type, next_occurrence } = req.body;

    if (!task_id || !recurrence_type || !next_occurrence) {
      return res.status(400).json({
        success: false,
        message: "task_id, recurrence_type and next_occurrence are required",
      });
    }

    if (isNaN(new Date(next_occurrence).getTime())) {
      return res.status(400).json({ success: false, message: "Invalid next_occurrence date" });
    }

    const result = await RecurringTask.create(req.body);

    res.status(201).json({
      success: true,
      message: "Recurring task created successfully",
      data: { recurring_id: result.insertId },
    });
  } catch (err) {
    console.error("createRecurringTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to create recurring task" });
  }
}

// PUT /recurring-task_tasks/:id
export async function updateRecurringTask(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.id;
    const body = req.body || {};

    const parseJSON = (val) => {
      if (!val) return null;
      if (typeof val !== "string") return val;
      try { return JSON.parse(val); } catch { return val; }
    };

    const title                  = body.title;
    const description            = body.description;
    const category_id            = body.category_id || null;
    const priority               = body.priority;
    const assigned_to            = body.assigned_to || null;
    const assigned_by            = body.assigned_by || null;
    const note                   = body.note;
    const recurrence_type        = body.recurrence_type;
    const end_date               = body.end_date || null;
    const recurrence_weekdays    = parseJSON(body.recurrence_weekdays);
    const recurrence_month_dates = parseJSON(body.recurrence_month_dates);
    const recurrence_year_dates  = parseJSON(body.recurrence_year_dates);
    const sub_users              = body.sub_users !== undefined ? parseJSON(body.sub_users) : undefined;
    const is_active              = body.is_active !== undefined
      ? (body.is_active === "true" || body.is_active === true || body.is_active === 1)
      : undefined;

    // Fetch current recurring task
    const currentTask = await RecurringTask.getById(id);
    if (!currentTask) {
      return res.status(404).json({ success: false, message: "Recurring task not found" });
    }

    // Update main task fields
    await RecurringTask.update(id, {
      title:                  title                  ?? currentTask.title,
      description:            description            ?? currentTask.description,
      priority:               priority               ?? currentTask.priority,
      category_id:            category_id            ?? currentTask.category_id,
      assigned_to:            assigned_to            ?? currentTask.assigned_to,
      assigned_by:            assigned_by            ?? currentTask.assigned_by,
      recurrence_type:        recurrence_type        ?? currentTask.recurrence_type,
      recurrence_weekdays:    recurrence_weekdays    ?? currentTask.recurrence_weekdays,
      recurrence_month_dates: recurrence_month_dates ?? currentTask.recurrence_month_dates,
      recurrence_year_dates:  recurrence_year_dates  ?? currentTask.recurrence_year_dates,
      end_date:               end_date               ?? currentTask.end_date,
      is_active:              is_active              ?? currentTask.is_active,
    });

    let chatMsg = chatMessage(title, description);
    await RecurringTask.updateOrAddChatMessage(id, user_id, chatMsg);

    // Handle Level 1 assignment change — compare against active L1, not stale table field
    const activeL1BeforeUpdate = await RecurringTask.getActiveL1(id);
    const currentL1Assignee = activeL1BeforeUpdate?.assigned_to ?? currentTask.assigned_to;

    if (assigned_to && Number(assigned_to) !== Number(currentL1Assignee)) {
      const oldL1 = await RecurringTask.getActiveL1(id);
      if (oldL1) await RecurringTask.deleteAssignment(oldL1.assignment_id);

      const newL1 = await RecurringTask.createAssignment({
        recurring_id: id,
        assigned_by:  user_id,
        assigned_to,
        role:         "level_one",
        is_level_one: true,
      });

      await RecurringTask.updateSubUsersParent(id, newL1.insertId);
    }

    // Handle sub-users
    if (sub_users !== undefined) {
      const normalizedSubUsers = parseSubUsers(sub_users)
        .map(s => ({ ...s, user_id: s.user_id ?? s.assigned_to }))
        .filter(s => s.user_id);

      const uniqueSubUsers = [...new Map(normalizedSubUsers.map(s => [String(s.user_id), s])).values()];

      const existingSubs  = await RecurringTask.getAllSubUsers(id);
      const existingMap   = Object.fromEntries(existingSubs.map(s => [String(s.assigned_to), s]));
      const newIds        = uniqueSubUsers.map(s => String(s.user_id));

      // Delete removed sub-users
      for (const s of existingSubs) {
        if (!newIds.includes(String(s.assigned_to))) {
          await RecurringTask.deleteAssignment(s.assignment_id);
        }
      }

      // Add or update sub-users
      const activeL1 = await RecurringTask.getActiveL1(id);
      const parentId = activeL1?.assignment_id ?? null;

      for (const su of uniqueSubUsers) {
        const existing = existingMap[String(su.user_id)];
        if (!existing) {
          await RecurringTask.createAssignment({
            recurring_id:         id,
            assigned_by:          user_id,
            assigned_to:          su.user_id,
            role:                 "sub_user",
            is_level_one:         false,
            parent_assignment_id: parentId,
            note:                 su.note || null,
          });
        } else if ((su.note || "").trim() !== (existing.note || "").trim()) {
          await RecurringTask.updateSubUserNote(id, su.user_id, su.note);
        }
      }
    }

    if (req.files?.length > 0 || note?.trim()) {
      const attachments = req.files?.map(f => ({
        file_name: f.originalname,
        file_path: `uploads/task_recurring_tasks/chat/${f.filename}`,
        file_size: f.size,
        mime_type: f.mimetype,
      })) ?? [];
      await RecurringTask.addChatMessage(id, user_id, note?.trim() || null, attachments);
    }

    const keepAttachments = body.keep_attachments ? JSON.parse(body.keep_attachments) : null;

    if (keepAttachments !== null) {
      const allChats = await RecurringTask.getChatAttachments(id);

      for (const chat of allChats) {
        const files = parseAttachmentsJson(chat.attachments);
        const keepList = asArray(keepAttachments);
        const removedFiles = files.filter((f) => !keepList.includes(f.file_path));

        if (removedFiles.length > 0) {
          for (const f of removedFiles) {
            try {
              if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
            } catch {}
          }

          const remaining = files.filter((f) => keepList.includes(f.file_path));
          await RecurringTask.updateChatAttachments(chat.chat_id, remaining);
        }
      }
    }

    res.json({ success: true, message: "Recurring task updated successfully" });

  } catch (err) {
    console.error("updateRecurringTask:", err.stack || err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE /recurring-task_tasks/:id
export async function deleteRecurringTask(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Recurring task ID required" });

    const recurringTask = await RecurringTask.getById(id);

    if (!recurringTask || recurringTask.length === 0) {
      return res.status(404).json({ success: false, message: "Recurring task not found" });
    }

    await RecurringTask.delete(id);

    res.json({ success: true, message: "Recurring task deleted successfully" });
  } catch (err) {
    console.error("deleteRecurringTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to delete recurring task" });
  }
}

// GET /recurring-task_tasks/stats
export async function getRecurringTaskStats(req, res) {
  try {
    const stats = await RecurringTask.getStats(req.query);
    res.json({ success: true, message: "Stats fetched successfully", data: stats ?? {} });
  } catch (err) {
    console.error("getRecurringTaskStats:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
}

export async function removeAttachmentFromRecurringTask(req, res) {
  try {
    const { id } = req.params;
    const { file_path } = req.body;

    if (!file_path) {
      return res.status(400).json({ success: false, message: "file_path is required" });
    }

    //  Get all chats with attachments
    const allChats = await RecurringTask.getChatAttachments(id);

    let found = false;

    for (const chat of allChats) {
      const files = chat.attachments ? (typeof chat.attachments === "string" ? JSON.parse(chat.attachments) : chat.attachments) : [];

      // Check if this chat contains the file
      const exists = files.find(f => f.file_path === file_path);
      if (!exists) continue;

      found = true;

      // Remove file from array
      const updatedFiles = files.filter(f => f.file_path !== file_path);

      // Update DB
      await RecurringTask.updateChatAttachments(chat.chat_id, updatedFiles);

      // Delete from disk
      try {
        if (fs.existsSync(file_path)) {
          fs.unlinkSync(file_path);
        }
      } catch (err) {
        console.warn("File delete failed:", err);
      }

      break;
    }

    if (!found) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    return res.json({
      success: true,
      message: "Attachment removed successfully",
    });

  } catch (err) {
    console.error("removeAttachmentFromRecurringTask:", err.stack || err);
    res.status(500).json({
      success: false,
      message: "Failed to remove attachment",
    });
  }
}