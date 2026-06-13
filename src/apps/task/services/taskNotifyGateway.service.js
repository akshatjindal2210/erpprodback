import { pickNotifyVarsForFilter } from "../config/notificationVariables.js";
import { postWaMessage, resolveWaMessageUrl } from "../../../shared/services/waGateway.service.js";

const REQUESTED_DATA = "sendmessage";

function logPayloadToConsole(trigger, filter, note, url) {
  console.log(`\n[Task notify - ${note}]`);
  console.log(`POST ${url}`);
  console.log(JSON.stringify({ requestedData: REQUESTED_DATA, filter }, null, 2));
  console.log(`trigger: ${trigger}\n`);
}

export async function sendTaskNotifyGateway({ tpl, subject, body, message, task_id, recipient, vars = {} }) {
  const trigger = tpl?.template_key ?? "";

  const filter = {
    recipient: recipient ?? "",
    trigger,
    send_via: tpl?.send_via ?? "",
    subject: subject ?? "",
    body: body ?? "",
    message: message ?? "",
    task_id: task_id != null ? String(task_id) : vars.task_id != null ? String(vars.task_id) : "",
    ...pickNotifyVarsForFilter(vars),
  };

  const waUrl = resolveWaMessageUrl(trigger);
  const { httpOk, json } = await postWaMessage(trigger, filter);

  if (httpOk && json?.success !== false) {
    return { ok: true, requestedData: REQUESTED_DATA, filter, url: waUrl };
  }

  const errMsg = json?.message || "WhatsApp API unreachable or returned error";
  logPayloadToConsole(trigger, filter, `WA failed - ${errMsg}`, waUrl);
  return { ok: false, console: true, error: errMsg, requestedData: REQUESTED_DATA, filter, url: waUrl };
}
