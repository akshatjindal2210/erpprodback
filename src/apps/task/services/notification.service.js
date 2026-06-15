import NotificationTemplate from "../models/notificationTemplate.model.js";
import NotificationLog from "../models/notificationLog.model.js";
import User from "../../core/models/user.model.js";
import Task from "../models/task.model.js";
import TargetDate from "../models/targetDate.model.js";
import { buildNotifyVarsFromTask } from "../config/notificationVariables.js";
import { sendTaskNotifyGateway } from "./taskNotifyGateway.service.js";
import { sendTaskPwaPush, isPwaPushConfigured } from "./taskPwaPush.service.js";
import { toUserId } from "../../../utils/socket.js";

const SEND_VIA = ["none", "free", "paid"];

const FALLBACK_SUBJECT = {
  task_assigned: "New task: {{task_title}}",
  target_date_set: "Target date for {{task_title}}",
  daily_reminder: "Daily task reminder",
  personal_reminder: "Personal reminder: {{task_title}}",
  status_changed: "Task status updated: {{task_title}}",
};

const FALLBACK_BODY = {
  task_assigned:
    "Hi {{user_name}},\n\nA new task has been assigned to you.\n\nTask: {{task_title}} (#{{task_id}})\nAssigned by: {{assigned_by}}\nDue: {{due_date}}\n\nPlease check the Task app.",
};

function renderTemplate(text, vars) {
  if (!text) return "";
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function writeLog(data) {
  void NotificationLog.create(data).catch((err) => {
    console.error("[Task notify] log failed:", err.message);
  });
}

export function getChannelStatus() {
  return {
    gateway: { id: "gateway", label: "ERP Gateway", configured: true },
    pwa_push: { id: "pwa_push", label: "PWA (Socket)", configured: isPwaPushConfigured() },
    free: { id: "free", label: "Free", configured: true },
    paid: { id: "paid", label: "Paid", configured: true },
  };
}

export async function sendTaskNotification(
  template_key,
  userId,
  vars = {},
  task_id = null,
  { tpl: tplOverride = null } = {}
) {
  const uid = toUserId(userId);
  if (!uid) return;

  const tpl = tplOverride ?? (await NotificationTemplate.getByKey(template_key));
  if (!tpl?.is_enabled || (!tpl.pwa_enabled && !tpl.api_enabled)) return;

  const user = await User.getById(uid);
  if (!user) return;

  let taskVars = { ...vars };
  if (task_id) {
    const task = await Task.getById(task_id);
    if (task) {
      const currentTarget = await TargetDate.getCurrent(task_id).catch(() => null);
      taskVars = buildNotifyVarsFromTask(task, {
        ...vars,
        target_date: vars.target_date ?? currentTarget?.target_at ?? "",
      });
    }
  }

  const merged = { user_name: user.name ?? "", ...taskVars };
  const subject = renderTemplate(tpl.subject || FALLBACK_SUBJECT[template_key] || "Task notification", merged);
  const body = renderTemplate(tpl.body || FALLBACK_BODY[template_key] || "Please check the Task app.", merged);
  const message = subject ? `${subject}\n\n${body}` : body;
  const gatewayTpl = { ...tpl, template_key, send_via: tpl.send_via ?? "none" };

  if (tpl.pwa_enabled) {
    sendTaskPwaPush({ userId: uid, subject, body, message, task_id, template_key })
      .then((pwa) => {
        writeLog({
          task_id: task_id ?? null,
          user_id: uid,
          template_key,
          channel: "pwa_push",
          recipient: `user:${uid}`,
          message,
          status: pwa.ok ? "sent" : pwa.skipped ? "skipped" : "failed",
          error_detail: pwa.ok ? null : pwa.error ?? "PWA notify failed",
        });
      })
      .catch((err) => console.error(`[Task notify] PWA ${template_key}:`, err.message));
  }

  if (!tpl.api_enabled) return;

  const sendVia = SEND_VIA.includes(tpl.send_via) ? tpl.send_via : "none";
  if (sendVia === "none") return;

  const recipient = user.phone;
  if (!recipient) {
    writeLog({
      task_id: task_id ?? null,
      user_id: uid,
      template_key,
      channel: sendVia,
      recipient: null,
      message,
      status: "skipped",
      error_detail: "User has no phone",
    });
    return;
  }

  try {
    const gateway = await sendTaskNotifyGateway({
      tpl: gatewayTpl,
      subject,
      body,
      message,
      task_id,
      recipient,
      vars: merged,
    });
    writeLog({
      task_id: task_id ?? null,
      user_id: uid,
      template_key,
      channel: gateway.ok ? "gateway" : "console",
      recipient,
      message,
      status: gateway.ok ? "sent" : "console",
      error_detail: gateway.ok ? null : gateway.error ?? "ERP API unavailable",
    });
  } catch (err) {
    console.error(`[Task notify] ERP ${template_key}:`, err.message);
    writeLog({
      task_id: task_id ?? null,
      user_id: uid,
      template_key,
      channel: sendVia,
      recipient,
      message,
      status: "failed",
      error_detail: err.message,
    });
  }
}

export { renderTemplate };
