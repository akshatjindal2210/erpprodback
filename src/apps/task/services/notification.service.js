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

function logWhatsAppResult({ task_id, user_id, template_key, sendVia, recipient, message, gateway }) {
  writeLog({
    task_id: task_id ?? null,
    user_id,
    template_key,
    channel: sendVia,
    recipient,
    message,
    status: gateway?.ok ? "sent" : "failed",
    error_detail: gateway?.ok ? null : gateway?.error ?? "WhatsApp API unavailable",
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
    logWhatsAppResult({
      task_id,
      user_id: uid,
      template_key,
      sendVia,
      recipient,
      message,
      gateway,
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

/** Admin instant send — ignores template is_enabled; uses chosen channels per request. */
export async function sendDirectNotification(
  userId,
  {
    template_key = "manual_instant",
    subject = "",
    body = "",
    pwa_enabled = false,
    api_enabled = false,
    send_via = "none",
    vars = {},
    task_id = null,
  } = {}
) {
  const uid = toUserId(userId);
  if (!uid) return { ok: false, skipped: true, user_id: userId, error: "Invalid user id" };

  const user = await User.getById(uid);
  if (!user) return { ok: false, skipped: true, user_id: uid, error: "User not found" };

  const merged = { user_name: user.name ?? "", ...vars };
  const finalSubject = renderTemplate(subject, merged);
  const finalBody = renderTemplate(body, merged);
  const message = finalSubject ? `${finalSubject}\n\n${finalBody}` : finalBody;
  const via = SEND_VIA.includes(send_via) ? send_via : "none";

  let pwaOk = false;
  let apiOk = false;
  const errors = [];

  if (pwa_enabled) {
    try {
      const pwa = await sendTaskPwaPush({
        userId: uid,
        subject: finalSubject || "Task update",
        body: finalBody,
        message,
        task_id,
        template_key,
      });
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
      pwaOk = !!pwa.ok;
      if (!pwa.ok && pwa.error) errors.push(pwa.error);
    } catch (err) {
      errors.push(err.message);
      writeLog({
        task_id: task_id ?? null,
        user_id: uid,
        template_key,
        channel: "pwa_push",
        recipient: `user:${uid}`,
        message,
        status: "failed",
        error_detail: err.message,
      });
    }
  }

  if (api_enabled && via !== "none") {
    const recipient = user.phone;
    if (!recipient) {
      writeLog({
        task_id: task_id ?? null,
        user_id: uid,
        template_key,
        channel: via,
        recipient: null,
        message,
        status: "skipped",
        error_detail: "User has no phone",
      });
      errors.push("No phone number");
    } else {
      try {
        const gateway = await sendTaskNotifyGateway({
          tpl: { template_key, send_via: via },
          subject: finalSubject,
          body: finalBody,
          message,
          task_id,
          recipient,
          vars: merged,
        });
        logWhatsAppResult({
          task_id,
          user_id: uid,
          template_key,
          sendVia: via,
          recipient,
          message,
          gateway,
        });
        apiOk = !!gateway.ok;
        if (!gateway.ok && gateway.error) errors.push(gateway.error);
      } catch (err) {
        errors.push(err.message);
        writeLog({
          task_id: task_id ?? null,
          user_id: uid,
          template_key,
          channel: via,
          recipient,
          message,
          status: "failed",
          error_detail: err.message,
        });
      }
    }
  }

  const ok = pwaOk || apiOk;
  return {
    ok,
    skipped: !pwa_enabled && (!api_enabled || via === "none"),
    user_id: uid,
    user_name: user.name,
    pwa: pwaOk,
    api: apiOk,
    error: errors.length ? errors.join("; ") : null,
  };
}

export async function sendInstantMessage({
  recipient_mode = "users",
  user_ids = [],
  template_key = "manual_instant",
  subject = "",
  body = "",
  pwa_enabled = true,
  api_enabled = false,
  send_via = "none",
  vars = {},
}) {
  const subj = String(subject ?? "").trim();
  const msgBody = String(body ?? "").trim();
  if (!subj && !msgBody) {
    throw new Error("Subject or message body is required");
  }
  if (!pwa_enabled && (!api_enabled || send_via === "none")) {
    throw new Error("Enable PWA and/or WhatsApp (Free/Paid)");
  }

  let ids = (Array.isArray(user_ids) ? user_ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (recipient_mode === "all") {
    const users = await User.getAll({ status: "active" });
    ids = users.map((u) => u.id);
  }

  if (!ids.length) {
    throw new Error("No recipients selected");
  }

  const details = [];
  for (const uid of ids) {
    const result = await sendDirectNotification(uid, {
      template_key,
      subject: subj,
      body: msgBody,
      pwa_enabled,
      api_enabled,
      send_via,
      vars,
    });
    details.push(result);
  }

  return {
    total: ids.length,
    sent: details.filter((d) => d.ok).length,
    failed: details.filter((d) => !d.ok && !d.skipped).length,
    skipped: details.filter((d) => d.skipped).length,
    details,
  };
}

export { renderTemplate };
