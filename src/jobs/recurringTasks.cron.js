import cron from "node-cron";
import fs from "fs";
import path from "path";
import dbQuery from "../config/db.js";

export function initRecurringTasksCron() {
  cron.schedule("0 0 * * *", async () => {
    try {
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
              const newDir = path.join("uploads", "task_tasks", "chat");
              if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });

              for (const f of files) {
                const oldPath = f.file_path;
                const newPath = path.join(newDir, path.basename(oldPath));

                if (fs.existsSync(oldPath)) {
                  fs.copyFileSync(oldPath, newPath);
                  attachments.push({ ...f, file_path: newPath });
                }
              }
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

        await dbQuery(
          `INSERT INTO task_log (task_id, action, action_detail, performed_by)
           VALUES (?, ?, ?, ?)`,
          [newTaskId, "task_created", `Created from recurring_id ${rt.recurring_id}`, "System"]
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
    } catch (err) {
      console.error("❌ Recurring tasks cron error:", err);
    }
  });
}
