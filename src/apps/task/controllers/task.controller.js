import RecurringTask from "../models/recurringTask.model.js";
import Task from "../models/task.model.js";
import User from "../../core/models/user.model.js";
import { calculateNextOccurrence, chatMessage, ensureDir, saveAttachments, upsertRecurring, isDbTrue, parseSubUsers, parseAttachmentsJson, asArray } from "../shared/index.js";
import fs from "fs";
import path from "path";
const log = (task_id, user_id, performed_by, action, action_detail = null, assignment_id = null) => Task.addLog(task_id, user_id, performed_by, action, action_detail, assignment_id);

function canManageTask(reqUser, task) {
  if (reqUser.type === "super_admin") return true;
  if (task.task_type === "self") {
    return Number(reqUser.id) === Number(task.created_by_id ?? task.created_by);
  }
  return Number(reqUser.id) === Number(task.assigned_by_id ?? task.assigned_by);
}

// GET All TASK
export async function getTasks(req, res) {
  try {
    const { 
      search = "", page = 1, limit = 10, sortBy = "t.task_id", order = "DESC", status, priority, category_id, view, task_type, reminder, overdue, upcoming_due, 
      new_today, creator_pending, action_required_today, include_closed, department_id, user_id, assigned_by_id, report
    } = req.query;

    const userId   = req.user.id;
    const userRole = (req.user.type ?? req.user.role ?? "user").toLowerCase();

    const isManager = await User.isManager(userId);

    const isReport = report === "true" && (userRole === "admin" ||  userRole === "super_admin" || userRole === "executive_assistant" || userRole === "user" || isManager);

    const filterParams = {
      search, page, limit, sortBy, order, status, priority, category_id,
      view, task_type, reminder, overdue, upcoming_due, new_today, creator_pending,
      action_required_today, userId, userRole, include_closed, 
      department_id: department_id ? Number(department_id) : null,
      user_id: user_id ? Number(user_id) : null,
      assigned_by_id: assigned_by_id ? Number(assigned_by_id) : null,
      report: isReport
    };

    const [items, total, stats] = await Promise.all([
      Task.getAll(filterParams),
      Task.count(filterParams),
      Task.getStats({
        ...filterParams,
        filter_user_id: filterParams.user_id, // getStats expects filter_user_id
      }),
    ]);

    res.json({
      success: true,
      data: {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
        items,
        stats,
      },
    });
  } catch (err) {
    console.error("getTasks:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET SINGLE TASK
export async function getTaskById(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.id;
    const user_role = (req.user.type || req.user.role || "").toLowerCase();

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const requester = await User.getById(user_id);
    const userType = requester?.type; 
    const designation = requester?.designation?.name?.toLowerCase();
    const isManager = designation === "manager";
    const department_id = requester.department?.id;

    let hasAccess = false;

    if (userType === "super_admin") {
        // Super Admin — full access
        hasAccess = true;
    } else if (userType === "admin" || userType === "executive_assistant" || userType === "user") {
        // Check 1: Creator access
        const isCreator = await Task.checkTaskCreator(id, user_id);
    
        if (isCreator) {
            hasAccess = true;
        } else {
            // Check 2: Manager or normal user access
            hasAccess = isManager ? await Task.checkManagerTaskAccess(id, department_id) : await Task.checkUserTaskAccess(id, user_id, user_role);
        }  
    }

    if (!hasAccess) {
      return res.status(403).json({
          success: false,
          message: "Access Denied: You are not authorized to view this task.",
      });
    }

    const [assignmentChain, activityLog] = await Promise.all([
      Task.getAssignmentChain(id),
      Task.getActivityLog(id),
    ]);

    res.json({
      success: true,
      data: {
        ...task,
        assignment_chain: assignmentChain ?? [],
        task_log:         activityLog    ?? [],
      },
    });
  } catch (err) {
    console.error("getTaskById:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function createSelfTask(req, res) {
  try {
    const user_id = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const user_type = req.user.type ?? req.user.role ?? "user";

    const {
      title, description, category_id, priority,
      due_date, self_reminder_date,
      is_recurring, recurrence_type, create_today, note,
      recurrence_weekdays, recurrence_month_dates, recurrence_year_dates, end_date
    } = req.body;

    if (!title?.trim())
      return res.status(400).json({ success: false, message: "Title is required" });

    const recurringFlag = [true, 1, "true", "1"].includes(is_recurring);
    const createTodayFlag = [true, 1, "true", "1"].includes(create_today);

    let schedule_id = null;
    let task_id = null;
    let assignment_id = null;

    if (recurringFlag) {
      const scheduleResult = await RecurringTask.create({
        title: title.trim(),
        description,
        task_type: "self",
        created_by: user_id,
        assigned_by: null,
        assigned_to: user_id,
        category_id,
        priority,
        recurrence_type,
        recurrence_weekdays: recurrence_weekdays ?? null,
        recurrence_month_dates: recurrence_month_dates ?? null,
        recurrence_year_dates: recurrence_year_dates ?? null,
        next_occurrence: calculateNextOccurrence(recurrence_type, req.body),
        end_date: end_date ?? null,
      });
      schedule_id = scheduleResult.insertId;

      // Always seed default chat message for new/clone recurring task
      const recurringAttachments = req.files?.length > 0
        ? await saveAttachments(req.files, "uploads/task_recurring_tasks/chat")
        : null;
      const recurringChatMsg = chatMessage(title, description);
      await RecurringTask.addChatMessage(schedule_id, user_id, recurringChatMsg, recurringAttachments);
    }

    if (!recurringFlag || (recurringFlag && createTodayFlag)) {
      const taskDueDate = recurringFlag && createTodayFlag ? new Date() : due_date ?? null;

      const taskResult = await Task.createSelf({
        title: title.trim(),
        description,
        user_id,
        user_type,
        category_id,
        priority,
        due_date: taskDueDate,
        self_reminder_date,
        is_recurring: recurringFlag,
        recurrence_type,
        schedule_id,
      });
      task_id = taskResult.insertId;

      const aResult = await Task.createAssignment({
        task_id,
        assigned_by: user_id,
        assigned_to: user_id,
        level: 1,
        role: "self",
        is_level_one: true,
        note,
      });
      assignment_id = aResult.insertId;
      await Task.setCurrentAssignment(task_id, assignment_id);

      // Always seed default chat message for new/clone task
      const normalAttachments = req.files?.length > 0
        ? await saveAttachments(req.files, "uploads/task_tasks/chat")
        : null;
      const normalChatMsg = chatMessage(title, description);
      await Task.addChatMessage(task_id, user_id, normalChatMsg, normalAttachments);

      await log(task_id, user_id, user_name, "self_task_created", `"${title.trim()}"`, assignment_id);
    }

    res.status(201).json({
      success: true,
      message: "Self task created successfully",
      data: { task_id, assignment_id, schedule_id },
    });

  } catch (err) {
    console.error("createSelfTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function createTask(req, res) {
  try {
    const created_by   = req.user.id;
    const created_name = req.user.name ?? "Someone";
    const creator_type = req.user.type ?? req.user.role ?? "user";

    const {
      title, description, assigned_to, assigned_by,
      category_id, priority, status,
      due_date, reminder_date,
      is_recurring, recurrence_type, create_today, note,
      sub_users,
    } = req.body;

    if (!title?.trim())
      return res.status(400).json({ success: false, message: "Title is required" });
    if (!assigned_to)
      return res.status(400).json({ success: false, message: "assigned_to is required" });

    const assignee = await Task.getUserById(assigned_to);
    if (!assignee)
      return res.status(400).json({ success: false, message: "Assigned user not found or inactive" });

    const actual_assigned_by = assigned_by ?? created_by;
    const recurringFlag      = [true, 1, "true", "1"].includes(is_recurring);
    const createTodayFlag    = [true, 1, "true", "1"].includes(create_today);

    const parsedSubUsers = parseSubUsers(sub_users);

    let schedule_id   = null;
    let task_id       = null;
    let assignment_id = null;

    if (recurringFlag && recurrence_type) {
      const scheduleResult = await RecurringTask.create({
        title:                  title.trim(),
        description,
        task_type:              "assigned",
        created_by,
        assigned_by:            actual_assigned_by ?? null,
        assigned_to,
        category_id,
        priority,
        recurrence_type,
        recurrence_weekdays:    req.body.recurrence_weekdays    ?? null,
        recurrence_month_dates: req.body.recurrence_month_dates ?? null,
        recurrence_year_dates:  req.body.recurrence_year_dates  ?? null,
        next_occurrence:        calculateNextOccurrence(recurrence_type, req.body),
        end_date:               req.body.end_date ?? null,
      });
      schedule_id = scheduleResult.insertId;

      // Always seed default chat message for new/clone recurring task
      const recurringAttachments = req.files?.length > 0
        ? await saveAttachments(req.files, "uploads/task_recurring_tasks/chat")
        : null;
      const recurringChatMsg = chatMessage(title, description);
      await RecurringTask.addChatMessage(schedule_id, created_by, recurringChatMsg, recurringAttachments);

      // Level-1 assignment
      const l1Result = await RecurringTask.createAssignment({
        recurring_id: schedule_id,
        assigned_by:  actual_assigned_by,
        assigned_to,
        role:         "level_one",
        is_level_one: true,
      });

      // Sub-users for recurring
      for (const su of parsedSubUsers) {
        await RecurringTask.createAssignment({
          recurring_id:         schedule_id,
          assigned_by:          assigned_to,
          assigned_to:          su.user_id,
          role:                 "sub_user",
          is_level_one:         false,
          parent_assignment_id: l1Result.insertId,
          note:                 su.note ?? null,
        });
      }
    }

    if (!recurringFlag || (recurringFlag && createTodayFlag)) {
      const taskDueDate = recurringFlag && createTodayFlag ? new Date() : due_date ?? null;

      const taskResult = await Task.create({
        title: title.trim(),
        description,
        created_by,
        creator_type,
        assigned_by: actual_assigned_by,
        first_assigned_to: assigned_to,
        category_id,
        priority,
        status,
        due_date: taskDueDate,
        reminder_date,
        is_recurring: recurringFlag,
        recurrence_type,
        schedule_id,
      });
      task_id = taskResult.insertId;

      // Level-1 assignment
      const aResult = await Task.createAssignment({
        task_id,
        assigned_by: actual_assigned_by,
        assigned_to,
        level: 1,
        role: "level_one",
        is_level_one: true,
        note,
      });
      assignment_id = aResult.insertId;
      await Task.setCurrentAssignment(task_id, assignment_id);

      // Sub-users for normal task
      for (const su of parsedSubUsers) {
        await Task.createAssignment({
          task_id,
          assigned_by:          assigned_to,
          assigned_to:          su.user_id,
          level:                2,
          role:                 "sub_user",
          is_level_one:         false,
          parent_assignment_id: assignment_id,
          note:                 su.note,
          is_active:            0,
        });
        const suUser = await Task.getUserById(su.user_id);
        await log(task_id, created_by, created_name, "sub_user_assigned", `Sub-user assigned: ${suUser?.name ?? su.user_id}`, assignment_id);
      }

      // Always seed default chat message for new/clone task
      const normalAttachments = req.files?.length > 0
        ? await saveAttachments(req.files, "uploads/task_tasks/chat")
        : null;
      const chatMsg = chatMessage(title, description);
      await Task.addChatMessage(task_id, created_by, chatMsg, normalAttachments);

      await log(task_id, created_by, created_name, "task_created", null, null);
      await log(task_id, created_by, created_name, "task_assigned", `Assigned to ${assignee.name} (Level-1)`, assignment_id);
    }

    res.status(201).json({
      success: true,
      message: "Task created and assigned successfully",
      data: { task_id, assignment_id, schedule_id },
    });
  } catch (err) {
    console.error("createTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


// Assign sub-users to a task.
export async function assignSubUsers(req, res) {
  try {
    const { id }    = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { sub_users } = req.body;

    if (!Array.isArray(sub_users) || sub_users.length === 0)
      return res.status(400).json({ success: false, message: "sub_users array is required" });

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (req.user.type !== "super_admin" && Number(task.current_holder_id) !== Number(user_id))
      return res.status(403).json({ success: false, message: "Only current task holder (Level-1) can assign sub-users" });

    if (!isDbTrue(task.current_is_level_one))
      return res.status(403).json({ success: false, message: "Sub-user assignment allowed only for Level-1 Authority" });

    if (["completed", "creator_pending"].includes(task.status))
      return res.status(400).json({ success: false, message: `Cannot assign sub-users when task is '${task.status}'` });

    const parent_assignment_id = task.current_assignment_id;
    const insertedIds          = [];

    for (const su of sub_users) {
      if (!su.user_id) continue;

      const targetUser = await Task.getUserById(su.user_id);
      if (!targetUser) continue;

      // Duplicate check
      const existing = await Task.getActiveSubUserAssignment(id, su.user_id);
      if (existing) continue;

      const aResult = await Task.createAssignment({
        task_id: id, assigned_by: user_id, assigned_to: su.user_id,
        level: 2, role: "sub_user", is_level_one: false,
        parent_assignment_id, note: su.note,
      });
      insertedIds.push(aResult.insertId);

      await log(id, user_id, user_name, "sub_user_assigned", `Assigned to ${targetUser.name}`, aResult.insertId);
    }

    if (insertedIds.length === 0)
      return res.status(400).json({
        success: false,
        message: "No valid sub-users to assign (already assigned or not found)",
      });

    if (task.status === "pending")
      await Task.updateStatus(id, "in_progress");

    res.json({
      success: true,
      message: `${insertedIds.length} sub-user(s) assigned successfully`,
      data: { assignment_ids: insertedIds },
    });
  } catch (err) {
    console.error("assignSubUsers:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// UPDATE TASK
export async function updateTask(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const body = req.body || {};

    const { title, description, category_id, priority, status, due_date, reminder_date, self_reminder_date, is_recurring, recurrence_type, note, assigned_to, sub_users, assigned_by } = body;

    const currentTask = await Task.getById(id);
    if (!currentTask) return res.status(404).json({ success: false, message: "Task not found" });

    if (!canManageTask(req.user, currentTask)) {
      const msg = currentTask.task_type === "self" ? "Only the task owner or Super Admin can edit this task" : "Only the assigner or Super Admin can edit this task";      return res.status(403).json({ success: false, message: msg });
    }

    const categoryIdNum = category_id ? Number(category_id) : (currentTask.category_id ? Number(currentTask.category_id) : null);

    const canEditAssignment = req.user.type === "super_admin" || Number(user_id) === Number(currentTask.assigned_by_id);

    const hasChanged = (newVal, oldVal) => {
      if (newVal === undefined || newVal === null) return false;
      return String(newVal).trim() !== String(oldVal || "").trim();
    };

    await Task.update(id, {
      title:              title              ?? currentTask.title,
      description:        description        ?? currentTask.description        ?? null,
      category_id:        categoryIdNum,
      priority:           priority           ?? currentTask.priority,
      status:             status             ?? currentTask.status,
      // due_date:           due_date           ?? currentTask.due_date           ?? null,
      // due_date:           recurringFlag ? null : (due_date ?? currentTask.due_date ?? null),
      due_date:           due_date ?? currentTask.due_date ?? null,
      reminder_date:      reminder_date      ?? currentTask.reminder_date      ?? null,
      self_reminder_date: currentTask.task_type === "self" ? (self_reminder_date ?? currentTask.self_reminder_date ?? null) : null,
    });

    if (canEditAssignment && currentTask.task_type !== "self") {

      if (assigned_by && Number(assigned_by) !== Number(currentTask.assigned_by_id)) {
        // Only assigner can change assigned_by
        if (Number(user_id) === Number(currentTask.assigned_by_id)) {
          await Task.updateAssignedBy(id, assigned_by);
          await Task.updateL1AssignedBy(id, assigned_by);
          const newAbUser = await Task.getUserById(assigned_by);
          await log(id, user_id, user_name, "assigned_by_changed", `Assign By changed to ${newAbUser?.name ?? assigned_by}`);
        }
      }

      // ── 2a. L1 update — only when L1 authority actually changes (not current holder)
      const activeL1BeforeUpdate = await Task.getActiveL1(id);
      const currentL1Assignee = activeL1BeforeUpdate?.assigned_to ?? currentTask.first_assigned_to_id;

      if (assigned_to && Number(assigned_to) !== Number(currentL1Assignee)) {
        await Task.deactivateAllL1(id);

        const newL1 = await Task.createAssignment({
          task_id: id,
          assigned_by: user_id,
          assigned_to,
          level: 1,
          role: "level_one",
          is_level_one: true,
        });

        await Task.updateCurrentHolder(id, {
          first_assigned_to: assigned_to,
          current_holder_id: assigned_to,
          current_assignment_id: newL1.insertId,
          status: currentTask.status === "completed" ? "completed" : "pending",
        });

        await Task.updateSubUsersParent(id, newL1.insertId);

        const newL1User = await Task.getUserById(assigned_to);
        await log(id, user_id, user_name, "l1_changed",
          `L1 changed to ${newL1User?.name ?? assigned_to}`, newL1.insertId);
      }

      if (sub_users !== undefined) {
        const subUserList = parseSubUsers(sub_users);

        const uniqueParsedSubUsers = [];
        const seen = new Set();
        for (const su of subUserList) {
          const rawId = su.user_id ?? su.assigned_to;
          if (!rawId) continue;
          const suId = String(rawId);
          if (seen.has(suId)) continue;
          seen.add(suId);
          uniqueParsedSubUsers.push({ ...su, user_id: rawId });
        }

        const existingSubs = await Task.getAllSubUsers(id);
        const existingMap = Object.fromEntries(existingSubs.map(s => [String(s.assigned_to), s]));
        const newIds = uniqueParsedSubUsers.map(s => String(s.user_id));

        for (const s of existingSubs) {
          if (!newIds.includes(String(s.assigned_to))) {
            const suId = s.assigned_to;
            const suUser = await Task.getUserById(suId);
            await Task.deleteAssignment(s.assignment_id);
            await log(id, user_id, user_name, "sub_user_deleted", `Sub-user deleted: #${suId} - ${suUser?.name ?? suId}`);
          }
        }

        for (const su of uniqueParsedSubUsers) {
          const suId = String(su.user_id);
          const existing = existingMap[suId];

          if (!existing) {
            const l1 = await Task.getActiveL1(id);
            const parentId = l1?.assignment_id ?? currentTask.current_assignment_id;

            await Task.createAssignment({
              task_id: id,
              assigned_by: user_id,
              assigned_to: su.user_id,
              level: 2,
              role: "sub_user",
              is_level_one: false,
              parent_assignment_id: parentId,
              note: su.note,
              is_active: false,
            });

            const suUser = await Task.getUserById(su.user_id);
            await log(id, user_id, user_name, "sub_user_added", `Sub-user added: ${suUser?.name ?? su.user_id}`);
          } else if ((su.note || "").trim() !== (existing.note || "").trim()) {
            await Task.updateSubUserNote(id, su.user_id, su.note);
            const suUser = await Task.getUserById(su.user_id);
            await log(id, user_id, user_name, "sub_user_note_updated", `Sub-user note updated: ${suUser?.name ?? su.user_id}`);
          }
        }
      }
    }

    if (hasChanged(title, currentTask.title)) {
      await log(id, user_id, user_name, "title_changed", `"${currentTask.title}" → "${title.trim()}"`);
    }

    if (hasChanged(description, currentTask.description)) {
      await log(id, user_id, user_name, "description_changed", `"${currentTask.description}" → "${description.trim()}"`);
    }    
    
    if (hasChanged(priority, currentTask.priority)) {
      await log(id, user_id, user_name, "priority_changed", `${currentTask.priority} → ${priority}`);
    }

    if (hasChanged(status, currentTask.status)) {
      await log(id, user_id, user_name, "status_changed", `${currentTask.status} → ${status}`);
    }

    if (reminder_date && hasChanged(reminder_date, currentTask.reminder_date)) {
      await log(id, user_id, user_name, "reminder_set", `Reminder: ${reminder_date}`);
    }

    if (category_id && Number(category_id) !== Number(currentTask.category_id)) {
      const cat = await Task.getCategoryById(category_id);
      await log(id, user_id, user_name, "category_changed", `Category: ${cat?.name ?? category_id}`);
    }

    if (req.files?.length > 0 || note?.trim()) {
      const attachments = req.files?.map(f => ({
        file_name: f.originalname,
        file_path: `uploads/task_tasks/chat/${f.filename}`,
        file_size: f.size, mime_type: f.mimetype,
      }));
      await Task.addChatMessage(id, user_id, note?.trim() || null, attachments);
    }

    res.json({ success: true, message: "Task updated successfully" });

  } catch (err) {
    console.error("updateTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// DELETE TASK
export async function deleteTask(req, res) {
  try {
    const { id }    = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (!canManageTask(req.user, task)) {
      const msg = task.task_type === "self" ? "Only the task owner or Super Admin can delete this task" : "Only the assigner or Super Admin can delete this task";
      return res.status(403).json({ success: false, message: msg });
    }

    const chatFiles     = await Task.getChatAttachments(id);
    const selfNoteFiles = await Task.getSelfNoteAttachments(id);

    [...chatFiles, ...selfNoteFiles].forEach(row => {
      const files = parseAttachmentsJson(row.attachments);
      files.forEach(f => {
        try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch {}
      });
    });

    await log(id, user_id, user_name, "task_deleted", `"${task.title}"`);
    await Task.delete(id);

    res.json({ success: true, message: "Task deleted successfully" });
  } catch (err) {
    console.error("deleteTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// FORWARD TASK
export async function forwardTask(req, res) {
  try {
    const { id }    = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { forward_to, note } = req.body;

    if (!forward_to)
      return res.status(400).json({ success: false, message: "forward_to is required" });

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const activeL1    = await Task.getActiveL1(id);
    const isL1        = activeL1 && Number(activeL1.assigned_to) === Number(user_id);
    const isCurrentHolder = Number(task.current_holder_id) === Number(user_id);

    if (req.user.type !== "super_admin" && !isCurrentHolder && !isL1)
      return res.status(403).json({ success: false, message: "Only current task holder or Level-1 can forward" });

    if (["completed", "pending_approval", "creator_pending"].includes(task.status))
      return res.status(400).json({ success: false, message: `Cannot forward task in '${task.status}' status` });

    const fwdUser = await Task.getUserById(forward_to);
    if (!fwdUser)
      return res.status(400).json({ success: false, message: "Target user not found or inactive" });

    if (task.current_assignment_id) {
      const isCurrentL1 = activeL1 &&
        Number(activeL1.assignment_id) === Number(task.current_assignment_id);

      if (!isCurrentL1) {
        await Task.deactivateAssignment(task.current_assignment_id);
      }
    }

    const newLevel = (task.current_assignment_level || 1) + 1;
    const parentId = activeL1?.assignment_id ?? task.current_assignment_id ?? null;

    const newAsgn = await Task.createAssignment({
      task_id:              id,
      assigned_by:          user_id,
      assigned_to:          forward_to,
      level:                newLevel,
      role:                 "sub_user",
      is_level_one:         false,
      parent_assignment_id: parentId,
      note,
    });


    await Task.updateCurrentHolder(id, {current_holder_id: forward_to, current_assignment_id: newAsgn.insertId, status: "forwarded"});

    await log(id, user_id, user_name, "task_forwarded",
      `Forwarded to ${fwdUser.name}`, newAsgn.insertId);

    res.json({
      success: true,
      message: `Task forwarded to ${fwdUser.name}`,
      data: { new_assignment_id: newAsgn.insertId },
    });
  } catch (err) {
    console.error("forwardTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function reassignTask(req, res) {
  try {
    const { id }    = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { old: old_user_id, new: new_user_id, note } = req.body;

    if (!old_user_id || !new_user_id)
      return res.status(400).json({
        success: false,
        message: "Both previous_user_id and new_user_id are required."
      });

    if (Number(old_user_id) === Number(new_user_id))
      return res.status(400).json({
        success: false,
        message: "The provided user IDs must be different."
      });

    const requester = await User.getById(user_id);
    if (!requester)
      return res.status(403).json({ success: false, message: "Requester not found" });

    const role        = requester.type?.toLowerCase();
    const designation = requester.designation?.name?.toLowerCase();

    const isSuperAdmin = role === "super_admin";
    const isAdmin      = role === "admin" || role === "executive_assistant";
    const isManager    = designation === "manager";

    if (!isSuperAdmin && !isAdmin && !isManager)
      return res.status(403).json({
        success: false,
        message: "Only Admin, Super Admin, or Manager can reassign task_tasks",
      });

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (["completed", "pending_approval", "creator_pending"].includes(task.status))
      return res.status(400).json({
        success: false,
        message: `Cannot reassign task in '${task.status}' status`,
      });

    const oldUser = await Task.getUserById(old_user_id);
    if (!oldUser)
      return res.status(400).json({ success: false, message: "Old user not found or inactive" });

    const newUser = await Task.getUserById(new_user_id);
    if (!newUser)
      return res.status(400).json({ success: false, message: "New user not found or inactive" });

    if (!isSuperAdmin && isManager && !isAdmin) {
      if (requester.department_id !== oldUser.department_id)
        return res.status(403).json({
          success: false,
          message: "Manager can only reassign task_tasks within their own department",
        });

      if (requester.department_id !== newUser.department_id)
        return res.status(403).json({
          success: false,
          message: "New user must be in the same department as the manager",
        });
    }

    const oldAssignment = await Task.getAssignmentByUser(id, old_user_id);
    if (!oldAssignment)
      return res.status(404).json({
        success: false,
        message: "This user has no assignment on this task",
      });

    await Task.updateAssignmentUser(oldAssignment.assignment_id, {
      assigned_to: new_user_id,
      note,
    });

    const oldWasHolder = Number(task.current_holder_id) === Number(old_user_id);
    const oldWasL1     = isDbTrue(oldAssignment.is_level_one) || oldAssignment.role === "level_one";

    if (oldWasL1 || oldWasHolder) {
      await Task.updateCurrentHolder(id, {
        first_assigned_to: oldWasL1     ? new_user_id : null,
        current_holder_id: oldWasHolder ? new_user_id : null,
      });
    }

    await log(id, user_id, user_name, "task_reassigned", `Reassigned from ${oldUser.name} to ${newUser.name}`, oldAssignment.assignment_id);

    return res.json({
      success: true,
      message: `Task reassigned from ${oldUser.name} to ${newUser.name}`,
      data: { assignment_id: oldAssignment.assignment_id },
    });

  } catch (err) {
    console.error("reassignTask:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}


// REQUEST COMPLETION
export async function requestCompletion(req, res) {
  try {
    const { id } = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { completion_note } = req.body;

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (task.status === "completed")
      return res.status(400).json({ success: false, message: "Task already completed" });

    // ── CASE 1: Self task
    if (task.task_type === "self") {
      await Task.markCompleted(id);
      await Task.updateStatus(id, "completed");
      if (completion_note?.trim())
        await Task.addChatMessage(id, user_id, `[Completed] ${completion_note.trim()}`);
      await log(id, user_id, user_name, "task_completed", "Self task marked as completed");
      return res.json({ success: true, message: "Self task completed!" });
    }

    // ── CASE 2: Sub-user requesting completion
    const mySubAssignment = await Task.getActiveSubUserAssignment(id, user_id);
    if (mySubAssignment) {
      await Task.requestAssignmentCompletion(mySubAssignment.assignment_id);
      await Task.updateStatus(id, "pending_approval");
      if (completion_note?.trim())
        await Task.addChatMessage(id, user_id, `[Completion Request] ${completion_note.trim()}`);
      await log(id, user_id, user_name, "completion_requested",
        `Sub-user requested completion`, mySubAssignment.assignment_id);
      return res.json({ success: true, message: "Completion requested — waiting for L1 approval" });
    }

    // ── CASE 3: L1 requesting completion (no sub-users OR all sub-users done)
    const l1Assignment = await Task.getActiveL1ByUser(id, user_id);
    if (req.user.type !== "super_admin" && !l1Assignment)
      return res.status(403).json({ success: false, message: "You are not authorized to complete this task" });

    // Check pending sub-users
    const pendingSubUsers = asArray(await Task.getPendingSubUsers(id));
    if (pendingSubUsers.length > 0)
      return res.status(400).json({
      success: false,
      message: `${pendingSubUsers.length} sub-user(s) have pending work — approve them first`,
    });

    // L1 requests completion → goes to creator
    await Task.requestAssignmentCompletion(l1Assignment.assignment_id);
    await Task.updateStatus(id, "creator_pending");
    if (completion_note?.trim())
      await Task.addChatMessage(id, user_id, `[Completion Request] ${completion_note.trim()}`);
    await log(id, user_id, user_name, "completion_requested",
      `L1 requested completion — awaiting creator approval`, l1Assignment.assignment_id);

    return res.json({ success: true, message: "Completion requested — waiting for creator approval" });

  } catch (err) {
    console.error("requestCompletion:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// APPROVE SUB-USER
export async function approveSubUser(req, res) {
  try {
    const { id, assignmentId } = req.params;
    const user_id = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { approval_note } = req.body;

    const task = await Task.getById(id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const l1Assignment = await Task.getActiveL1ByUser(id, user_id);
    if (req.user.type !== "super_admin" && !l1Assignment)
      return res.status(403).json({ success: false, message: "Only Level-1 can approve sub-user completion" });

    const subAssignment = await Task.getAssignmentById(assignmentId, id);
    if (!subAssignment)
      return res.status(404).json({ success: false, message: "Sub-user assignment not found" });

    if (!subAssignment.completion_requested_at)
      return res.status(400).json({ success: false, message: "Sub-user has not requested completion yet" });

    if (subAssignment.completion_approved_at)
      return res.status(400).json({ success: false, message: "Already approved" });

    await Task.approveAssignmentCompletion(assignmentId, user_id);

    if (approval_note?.trim())
      await Task.addChatMessage(id, user_id, `[Sub-user Approved] ${approval_note.trim()}`);

    await log(id, user_id, user_name, "sub_user_completion_approved",
      `Sub-user assignment #${assignmentId} approved`, Number(assignmentId));

    const remaining = asArray(await Task.getPendingSubUsers(id));

    if (remaining.length === 0) {

      await Task.updateStatus(id, "creator_pending");

      await Task.updateCurrentHolder(id, {
        current_holder_id: task.assigned_by_id ?? task.assigned_by,
        current_assignment_id: null,
        status: "creator_pending"
      });

      return res.json({
        success: true,
        message: "Work approved. Sent to creator for final closing."
      });
    }
    
    await Task.updateStatus(id, "in_progress");

    return res.json({
      success: true,
      message: "Sub-user approved. Waiting for other sub-users to finish.",
      data: {
        remaining_sub_users: remaining.length,
        escalated_to_creator: false,
      },
    });

  } catch (err) {
    console.error("approveSubUser Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// REJECT SUB-USER
export async function rejectSubUser(req, res) {
  try {
    const { id, assignmentId } = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { rejection_note } = req.body;

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const l1Assignment = await Task.getActiveL1ByUser(id, user_id);
    if (req.user.type !== "super_admin" && !l1Assignment)
      return res.status(403).json({ success: false, message: "Only Level-1 authority can reject sub-user completion" });

    const subAssignment = await Task.getAssignmentById(assignmentId, id);
    if (!subAssignment)
      return res.status(404).json({ success: false, message: "Sub-user assignment not found" });

    if (!subAssignment.completion_requested_at)
      return res.status(400).json({ success: false, message: "Sub-user has not requested completion yet" });

    await Task.rejectAssignmentCompletion(assignmentId);
    await Task.updateStatus(id, "in_progress");

    if (rejection_note?.trim())
      await Task.addChatMessage(id, user_id, `[Rejected] ${rejection_note.trim()}`);

    await log(id, user_id, user_name, "sub_user_completion_rejected",
      `Assignment #${assignmentId} rejected. Sub-user must redo.`, Number(assignmentId));

    res.json({ success: true, message: "Sub-user completion rejected. They must redo the work." });
  } catch (err) {
    console.error("rejectSubUser:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// CREATOR FINAL DECISION
export async function creatorDecision(req, res) {
  try {
    const { id } = req.params;
    const user_id   = req.user.id;
    const user_name = req.user.name ?? "Someone";
    const { decision, approval_note, rejection_note } = req.body;

    const task = await Task.getById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (req.user.type !== "super_admin" && Number(task.assigned_by_id ?? task.assigned_by) !== Number(user_id))
      return res.status(403).json({ success: false, message: "Only the assigner can make the final decision" });

    if (task.status !== "creator_pending")
      return res.status(400).json({ success: false, message: "Task is not awaiting creator decision" });

    // ── APPROVE
    if (decision === "approved") {
      await Task.markCompleted(id);
      await Task.updateStatus(id, "completed");

      const l1 = await Task.getActiveL1(id);
      if (l1) await Task.approveAssignmentCompletion(l1.assignment_id, user_id);

      if (approval_note?.trim())
        await Task.addChatMessage(id, user_id, `[Final Approval] ${approval_note.trim()}`);

      await log(id, user_id, user_name, "task_completed", `Creator approved — task completed`);

      return res.json({ success: true, message: "Task approved and completed!" });
    }

    // ── REJECT
    if (decision === "rejected") {
      const l1 = await Task.getActiveL1(id);
      if (l1) {
        await Task.resetL1Completion(l1.assignment_id);

        await Task.updateCurrentHolder(id, {
          current_holder_id:     l1.assigned_to,
          current_assignment_id: l1.assignment_id,
          status:                "in_progress",
        });
      } else {
        await Task.updateStatus(id, "in_progress");
      }

      if (rejection_note?.trim())
        await Task.addChatMessage(id, user_id, `[Rejected] ${rejection_note.trim()}`);

      await log(id, user_id, user_name, "completion_rejected", `Creator rejected — task back to L1`);

      return res.json({ success: true, message: "Task rejected — L1 must redo the work" });
    }

    return res.status(400).json({ success: false, message: "Invalid decision — use 'approved' or 'rejected'" });

  } catch (err) {
    console.error("creatorDecision:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET ACTIVITY LOG
export const getTaskActivity = async (req, res) => {
  try {
    const { id }         = req.params;
    const limit          = parseInt(req.query.limit)  || 20;
    const offset         = parseInt(req.query.offset) || 0;
    const action_type    = req.query.action_type      || null;

    // Task basic info
    const task = await Task.getById(id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const [logs, total] = await Promise.all([
      Task.getActivityLog(id, { limit, offset, action_type }),
      Task.getActivityLogCount(id, action_type),
    ]);

    return res.json({
      success: true,
      data: {
        task: {
          task_id: task.task_id,
          title:   task.title,
          status:  task.status,
        },
        logs,
        pagination: {
          total,
          limit,
          offset,
          has_more: offset + limit < total,
        },
      },
    });
  } catch (err) {
    console.error("getTaskActivity error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};