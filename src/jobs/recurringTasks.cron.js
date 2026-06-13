import fsp from "fs/promises";
import path from "path";
import dbQuery from "../config/db.js";
import config from "../config/config.js";
import { addTaskActivityLog } from "../apps/task/services/taskActivityLog.service.js";
import { scheduleDeferred } from "./cronUtil.js";

async function copyRecurringChatAttachments(files) {
  const newDir = path.join(config.uploadPath, "task_tasks", "chat");
  await fsp.mkdir(newDir, { recursive: true });
  const attachments = [];

  for (const f of files) {
    const oldPathRelative = f.file_path.startsWith(`${config.uploadPublicPath}/`)
      ? f.file_path.slice(config.uploadPublicPath.length + 1)
      : f.file_path;
    const oldPath = path.join(config.uploadPath, oldPathRelative);
    const newPathRelative = path.join("task_tasks", "chat", path.basename(oldPath));
    const newPath = path.join(config.uploadPath, newPathRelative);

    try {
      await fsp.access(oldPath);
      await fsp.copyFile(oldPath, newPath);
      attachments.push({
        ...f,
        file_path: path.join(config.uploadPublicPath, newPathRelative).replace(/\\/g, "/"),
      });
    } catch {
      // Source file missing — skip
    }
  }

  return attachments;
}

async function processRecurringTasks() {
      const today = new Date().toISOString().split("T")[0];

      const recurringTasks = await dbQuery(
        `SELECT * FROM task_recurring_tasks WHERE DATE(next_occurrence) <= ? AND is_active = TRUE`,
        [today]
      );

      for (const rt of recurringTasks) {
        if (rt.end_date && today > rt.end_date) continue;

        const assignments = await dbQuery(
          `SELECT * FROM task_recurring_task_assignments WHERE recurring_id = ?`,
          [rt.recurring_id]
        );

        const assignedBy = rt.assigned_by || (assignments.length > 0 ? assignments[0].assigned_by : rt.created_by);

        const result = await dbQuery(
          `INSERT INTO task_tasks (
            title, description, task_type,
            created_by, creator_type,
            assigned_by, first_assigned_to, current_holder_id,
            category_id, priority,
            status, is_recurring, recurrence_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            rt.title,
            rt.description,
            rt.task_type,
            rt.created_by,
            "user",
            assignedBy,
            rt.assigned_to,
            rt.assigned_to,
            rt.category_id,
            rt.priority,
            "pending",
            1,
            rt.recurrence_type,
          ]
        );

        const newTaskId = result.insertId;

        const assignmentMap = {};
        for (const a of assignments) {
          const res = await dbQuery(
            `INSERT INTO task_assignments (
              task_id, assigned_by, assigned_to,
              role, is_level_one, assignment_level, parent_assignment_id, note, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newTaskId,
              a.assigned_by || assignedBy,
              a.assigned_to,
              a.role,
              a.is_level_one,
              a.assignment_level,
              null,
              a.note,
              a.role === "sub_user" ? 0 : 1,
            ]
          );
          assignmentMap[a.assignment_id] = res.insertId;
        }

        for (const a of assignments) {
          if (a.parent_assignment_id) {
            await dbQuery(
              `UPDATE task_assignments SET parent_assignment_id = ? WHERE assignment_id = ?`,
              [assignmentMap[a.parent_assignment_id], assignmentMap[a.assignment_id]]
            );
          }
        }

        const chats = await dbQuery(
          `SELECT * FROM task_recurring_task_chat WHERE recurring_id = ?`,
          [rt.recurring_id]
        );

        for (const chat of chats) {
          let attachments = [];

          if (chat.attachments) {
            try {
              const files = typeof chat.attachments === "string" ? JSON.parse(chat.attachments) : chat.attachments;
              attachments = await copyRecurringChatAttachments(files);
            } catch (e) {
              console.error("Failed to process attachments for chat:", e);
            }
          }

          await dbQuery(
            `INSERT INTO task_chat (task_id, user_id, message, reply_to_id, attachments)
             VALUES (?, ?, ?, ?, ?)`,
            [newTaskId, chat.user_id, chat.message, null, JSON.stringify(attachments)]
          );
        }

        await addTaskActivityLog(
          newTaskId,
          null,
          "System",
          "task_created",
          `Created from recurring_id ${rt.recurring_id}`,
          null
        );

        const nextDate = new Date(rt.next_occurrence);
        switch (rt.recurrence_type) {
          case "daily":
            nextDate.setDate(nextDate.getDate() + 1);
            break;
          case "weekly":
            nextDate.setDate(nextDate.getDate() + 7);
            break;
          case "monthly":
            nextDate.setMonth(nextDate.getMonth() + 1);
            break;
          case "yearly":
            nextDate.setFullYear(nextDate.getFullYear() + 1);
            break;
        }

        await dbQuery(
          `UPDATE task_recurring_tasks SET next_occurrence = ? WHERE recurring_id = ?`,
          [nextDate.toISOString().split("T")[0], rt.recurring_id]
        );
      }

      console.log("✅ Recurring tasks processed at", new Date());
}

export function initRecurringTasksCron() {
  scheduleDeferred("0 0 * * *", async () => {
    try {
      await processRecurringTasks();
    } catch (err) {
      console.error("❌ Recurring tasks cron error:", err);
    }
  }, { name: "recurring-tasks" });
}
