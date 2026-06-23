import { pickNotifyVarsForFilter } from "../config/notificationVariables.js";
import { postWaMessage, resolveWaMessageUrl, resolveWaRequestedData } from "./waGateway.service.js";

function logPayloadToConsole(trigger, filter, requestedData, note, url) {
  console.log(`\n[Task notify - ${note}]`);
  console.log(`POST ${url}`);
  console.log(JSON.stringify({ requestedData, filter }, null, 2));
  console.log(`trigger: ${trigger}\n`);
}

export async function sendTaskNotifyGateway({ tpl, subject, body, message, task_id, recipient, vars = {} }) {
  const trigger = tpl?.template_key ?? "";
  const sendVia = tpl?.send_via ?? "";

  const filter = {
    recipient: recipient ?? "",
    trigger,
    send_via: sendVia,
    subject: subject ?? "",
    body: body ?? "",
    message: message ?? "",
    task_id: task_id != null ? String(task_id) : vars.task_id != null ? String(vars.task_id) : "",
    ...pickNotifyVarsForFilter(vars),
  };

  const waUrl = resolveWaMessageUrl();
  const requestedData = resolveWaRequestedData(trigger, sendVia);
  const { httpOk, json, requestedData: postedAs } = await postWaMessage(trigger, filter, sendVia);

  if (httpOk && json?.success !== false) {
    return { ok: true, requestedData: postedAs ?? requestedData, filter, url: waUrl };
  }

  const errMsg = json?.message || "WhatsApp API unreachable or returned error";
  logPayloadToConsole(trigger, filter, postedAs ?? requestedData, `WA failed - ${errMsg}`, waUrl);
  return {
    ok: false,
    console: true,
    error: errMsg,
    requestedData: postedAs ?? requestedData,
    filter,
    url: waUrl,
  };
}
