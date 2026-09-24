import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";
import { findActiveTemplatesByModuleName, normalizeAudience, isAudienceDimActive, audienceHasAny, effectiveAudience } from "./notificationTemplate.model.js";
import { insertNotificationLog } from "./notificationTemplateLog.model.js";
import { saveInboxAlert } from "../inbox/inboxNotify.service.js";
import { isWebPushConfigured, sendWebPushToUser } from "../push/webPush.service.js";
import { getIO } from "../../lib/utils/realtime/socket.js";
import { postWaMessage } from "../../../task/manage/notifications/services/waGateway.service.js";

export const ROLE_KEYS = ["super_admin", "admin", "user", "executive_assistant"];

export const EVENT_LABELS = {
  add: "Added",
  edit: "Edited",
  delete: "Deleted",
  approve: "Approved",
};

/** When one request matches several events (e.g. update + approve), a template fires once, for the highest-priority event. */
const EVENT_PRIORITY = ["approve", "add", "edit", "delete"];

const CACHE_TTL_MS = 30_000;
const templateCache = new Map();

export function invalidateTemplateCache() {
  templateCache.clear();
}

async function getActiveTemplates(moduleName) {
  const hit = templateCache.get(moduleName);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await findActiveTemplatesByModuleName(moduleName);
  templateCache.set(moduleName, { at: Date.now(), rows });
  return rows;
}

/** Same `{{key}}` syntax as Task notification templates; `{key}` is accepted as shorthand. */
export function renderTemplate(text, vars) {
  if (!text) return "";
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (_, a, b) => {
    const v = vars[a ?? b];
    return v == null ? "" : String(v);
  });
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const isScalar = (v) => v == null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date;
const scalarText = (v) => (v instanceof Date ? v.toISOString() : String(v));

/** Flatten request/response fields into template variables (top level wins over nested). */
export function buildRecordVars(...sources) {
  const out = {};
  const nested = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value == null || key === "password") continue;
      if (isScalar(value)) out[key] = scalarText(value);
      else if (Array.isArray(value) && value.every(isScalar)) out[key] = value.map(scalarText).join(", ");
      else if (isPlainObject(value)) {
        for (const [nk, nv] of Object.entries(value)) {
          if (nv != null && isScalar(nv)) nested[nk] = scalarText(nv);
        }
      }
    }
  }
  return { ...nested, ...out };
}

function nowParts() {
  const d = new Date();
  const tz = { timeZone: "Asia/Kolkata" };
  return {
    date: d.toLocaleDateString("en-IN", tz),
    time: d.toLocaleTimeString("en-IN", { ...tz, hour: "2-digit", minute: "2-digit" }),
    datetime: d.toLocaleString("en-IN", tz),
  };
}

const RECIPIENT_WHERE = {
  attribute: "u.attribute_ids && $1::int[]",
  role: "u.type = ANY($1::text[])",
  department: "u.department_id = ANY($1::int[])",
  designation: "u.designation_id = ANY($1::int[])",
  user: "u.id = ANY($1::int[])",
};

export function normalizeRecipientRefs(raw) {
  const list = Array.isArray(raw) ? raw : raw != null && raw !== "" ? [raw] : [];
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
}

/** Resolve one recipient rule (any of its refs) against the existing user linkage columns. */
export async function resolveRecipients(recipient_type, recipient_refs) {
  const clause = RECIPIENT_WHERE[recipient_type];
  const refs = normalizeRecipientRefs(recipient_refs);
  if (!clause || !refs.length) return [];
  if (recipient_type !== "role" && refs.some((r) => !/^\d+$/.test(r))) return [];
  return dbQuery(
    `SELECT u.id, u.name, u.phone, u.email
     FROM ${M.USERS} u
     WHERE u.is_deleted = false
       AND COALESCE(u.status, 'active') <> 'inactive'
       AND ${clause}
     ORDER BY u.id`,
    [refs]
  );
}

/**
 * Multi-dimension audience:
 * - department / designation / attribute / role → AND (empty dim skipped; `all` = no id filter)
 * - direct users → OR'd in (always included when set)
 */
export async function resolveAudience(audienceInput) {
  const audience = normalizeAudience(audienceInput);
  if (!audienceHasAny(audience)) return [];

  const filterDims = ["departments", "designations", "attributes", "roles"];
  const hasFilter = filterDims.some((k) => isAudienceDimActive(audience[k]));
  const hasUsers = isAudienceDimActive(audience.users);

  const values = [];
  const andParts = [];

  const pushIntIds = (ids) => {
    values.push(ids.map(Number));
    return `$${values.length}::int[]`;
  };
  const pushTextIds = (ids) => {
    values.push(ids.map(String));
    return `$${values.length}::text[]`;
  };

  if (hasFilter) {
    if (isAudienceDimActive(audience.departments) && !audience.departments.all) {
      andParts.push(`u.department_id = ANY(${pushIntIds(audience.departments.ids)})`);
    }
    if (isAudienceDimActive(audience.designations) && !audience.designations.all) {
      andParts.push(`u.designation_id = ANY(${pushIntIds(audience.designations.ids)})`);
    }
    if (isAudienceDimActive(audience.attributes) && !audience.attributes.all) {
      andParts.push(`u.attribute_ids && ${pushIntIds(audience.attributes.ids)}`);
    }
    if (isAudienceDimActive(audience.roles) && !audience.roles.all) {
      andParts.push(`u.type = ANY(${pushTextIds(audience.roles.ids)})`);
    }
  }

  const filterSql = andParts.length ? `(${andParts.join(" AND ")})` : null;
  const userSql = hasUsers && !audience.users.all
    ? `u.id = ANY(${pushIntIds(audience.users.ids)})`
    : hasUsers && audience.users.all
      ? "TRUE"
      : null;

  let matchSql = "FALSE";
  if (filterSql && userSql) matchSql = `(${filterSql} OR ${userSql})`;
  else if (filterSql) matchSql = filterSql;
  else if (userSql) matchSql = userSql;
  else if (hasFilter) matchSql = "TRUE"; // only "all" dims with no id filters → everyone

  return dbQuery(
    `SELECT u.id, u.name, u.phone, u.email
     FROM ${M.USERS} u
     WHERE u.is_deleted = false
       AND COALESCE(u.status, 'active') <> 'inactive'
       AND ${matchSql}
     ORDER BY u.id`,
    values
  );
}

function logDelivery(entry) {
  return insertNotificationLog(entry).catch((err) => {
    console.error("[Module notify] log failed:", err.message);
  });
}

async function sendPwa({ tpl, user, title, body, appType }) {
  const trigger_key = `module_${tpl.id}`.slice(0, 50);
  const { row } = await saveInboxAlert({
    userId: user.id,
    app_type: appType,
    trigger_key,
    title,
    body,
    url: "/",
  });

  let ok = Boolean(getIO());
  let error = ok ? null : "Socket not ready";

  if (isWebPushConfigured()) {
    const push = await sendWebPushToUser(
      user.id,
      { title, body, url: "/", tag: row?.inbox_id ? `inbox-${row.inbox_id}` : trigger_key },
      { inbox_id: row?.inbox_id ?? null, user_id: user.id, user_name: user.name, template_key: trigger_key, channel: "pwa_push", app_type: appType }
    );
    if (push.ok) ok = true;
    else if (!ok) error = push.error || "Web push delivery failed";
  } else if (!ok) {
    error = "Socket not ready and web push not configured";
  }

  return { ok, error, inbox_id: row?.inbox_id ?? null };
}

async function sendWhatsApp({ tpl, user, title, body, message, vars }) {
  const { httpOk, json } = await postWaMessage(
    `module_${tpl.id}`,
    {
      recipient: user.phone,
      trigger: `module_${tpl.id}`,
      send_via: tpl.send_via,
      subject: title,
      body,
      message,
      module: vars.module_name,
      action: vars.action,
      record_id: vars.record_id ?? "",
    },
    tpl.send_via
  );
  const ok = httpOk && json?.success !== false;
  return { ok, error: ok ? null : json?.message || "WhatsApp API unreachable or returned error" };
}

async function sendEmail({ user, title, body }) {
  if (!user.email) return { ok: false, error: "User has no email", skipped: true };
  // Email gateway is not wired yet — log as skipped so templates can still store the preference.
  return { ok: false, error: "Email gateway not configured", skipped: true, title, body };
}

async function deliverTemplate(tpl, event, { recordVars, recordId, actorName }) {
  const recipients = await resolveAudience(tpl.audience ?? effectiveAudience(tpl));
  if (!recipients.length) return;

  const baseVars = {
    ...recordVars,
    ...nowParts(),
    module_name: tpl.module_name,
    module_label: tpl.module_label,
    action: event,
    action_label: EVENT_LABELS[event] ?? event,
    record_id: recordId ?? "",
    actor_name: actorName ?? "",
    template_name: tpl.name,
  };

  const appType = tpl.module_app_type || "core";
  const common = {
    template_id: tpl.id,
    module_id: tpl.module_id,
    record_id: recordId,
    action: event,
    triggered_by: actorName,
  };

  for (const user of recipients) {
    const vars = { ...baseVars, user_name: user.name ?? "" };
    const title = renderTemplate(tpl.subject || `${tpl.module_label} — ${EVENT_LABELS[event] ?? event}`, vars);
    const body = renderTemplate(tpl.message, vars);
    const message = title ? `${title}\n\n${body}` : body;

    if (tpl.pwa_enabled) {
      try {
        const pwa = await sendPwa({ tpl, user, title, body, appType });
        await logDelivery({
          ...common,
          recipient_user_id: user.id,
          channel: "pwa_push",
          recipient: `user:${user.id}`,
          title,
          message: body,
          status: pwa.ok ? "sent" : "failed",
          error_detail: pwa.error,
          inbox_id: pwa.inbox_id,
        });
      } catch (err) {
        await logDelivery({ ...common, recipient_user_id: user.id, channel: "pwa_push", recipient: `user:${user.id}`, title, message: body, status: "failed", error_detail: err.message });
      }
    }

    if (tpl.send_via && tpl.send_via !== "none") {
      if (!user.phone) {
        await logDelivery({ ...common, recipient_user_id: user.id, channel: tpl.send_via, recipient: null, title, message: body, status: "skipped", error_detail: "User has no phone" });
      } else {
        try {
          const wa = await sendWhatsApp({ tpl, user, title, body, message, vars });
          await logDelivery({ ...common, recipient_user_id: user.id, channel: tpl.send_via, recipient: user.phone, title, message: body, status: wa.ok ? "sent" : "failed", error_detail: wa.error });
        } catch (err) {
          await logDelivery({ ...common, recipient_user_id: user.id, channel: tpl.send_via, recipient: user.phone, title, message: body, status: "failed", error_detail: err.message });
        }
      }
    }

    if (tpl.email_enabled) {
      try {
        const mail = await sendEmail({ user, title, body });
        await logDelivery({
          ...common,
          recipient_user_id: user.id,
          channel: "email",
          recipient: user.email || null,
          title,
          message: body,
          status: mail.skipped ? "skipped" : mail.ok ? "sent" : "failed",
          error_detail: mail.error,
        });
      } catch (err) {
        await logDelivery({ ...common, recipient_user_id: user.id, channel: "email", recipient: user.email || null, title, message: body, status: "failed", error_detail: err.message });
      }
    }
  }
}

/**
 * Fire every active template of `moduleName` that listens to any of `events`.
 * Never throws — module writes must not fail because of notifications.
 */
export async function dispatchModuleEvent({ moduleName, events = [], record = {}, body = {}, recordId = null, actorName = null }) {
  try {
    if (!moduleName || !events.length) return;
    const templates = await getActiveTemplates(moduleName);
    if (!templates.length) return;

    const recordVars = buildRecordVars(body, record);

    for (const tpl of templates) {
      const tplEvents = Array.isArray(tpl.trigger_events) ? tpl.trigger_events : [];
      const event = EVENT_PRIORITY.find((e) => events.includes(e) && tplEvents.includes(e));
      if (!event) continue;
      try {
        await deliverTemplate(tpl, event, { recordVars, recordId, actorName });
      } catch (err) {
        console.error(`[Module notify] template ${tpl.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Module notify] ${moduleName} dispatch failed:`, err.message);
  }
}

/**
 * Tiny helper for activity / log functions:
 *   await notifyModuleAction("users", "edit", { record, recordId, actorName });
 * Prefer the automatic accessControl hook; use this only when you need an explicit call.
 */
export async function notifyModuleAction(moduleName, action, opts = {}) {
  const event = String(action || "").toLowerCase() === "authorize" ? "approve" : String(action || "").toLowerCase();
  return dispatchModuleEvent({
    moduleName,
    events: event ? [event] : [],
    record: opts.record ?? {},
    body: opts.body ?? {},
    recordId: opts.recordId ?? opts.record?.id ?? null,
    actorName: opts.actorName ?? null,
  });
}
