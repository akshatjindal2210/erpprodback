// Module notifications: config + dispatch live in this file.
// Entry: scheduleNotifyFromActivity() from logActivity / activityLogger.

import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";
import { findActiveTemplatesByModuleId, normalizeAudience, isAudienceDimActive, audienceHasAny, effectiveAudience } from "./notificationTemplate.model.js";
import { insertNotificationLogsBatch } from "./notificationTemplateLog.model.js";
import { auditUserName } from "../../lib/utils/auth/approval.js";
import { saveInboxAlert } from "../inbox/inboxNotify.service.js";
import { isWebPushConfigured, sendWebPushToUser } from "../push/webPush.service.js";
import { formatPushTitle, resolvePushAppBrand } from "../../../../config/push/pushAppBrand.js";
import { postWaMessage } from "../../../task/manage/notifications/services/waGateway.service.js";

// ─── Config (edit here for routing / aliases) ───────────────────────────────
export const MODULE_NOTIFY_FROM_ACTIVITY = true;

const SKIP_NOTIFY_ENTITIES = new Set(["notification_templates", "notification_template", "module_sops", "module_sop", "inbox", "push_subscriptions", "dashboard_configs"]);

const ACTION_TRIGGER_ALIASES = {
  generate_stickers: ["add"],
  delete_generated_stickers: ["delete"],
  bulk_download: ["edit"],
  override_customer: ["edit"],
  reject: ["edit"],
};

const STICKER_NOTIFY_ACTIONS = new Set(["generate_stickers", "delete_generated_stickers", "bulk_download"]);

const MODULE_RESOLVE_CACHE_MS = 60_000;     // Module resolve details ko 1 minute (60s) tak memory me cache karke rakhta hai
const TEMPLATE_CACHE_MS = 30_000;           // Notification templates ko 30 seconds tak cache me rakhta hai
const DELIVER_CONCURRENCY = 25;             // Ek sath (parallel) maximum 25 notifications bhejta hai
const MAX_RECIPIENTS_PER_TEMPLATE = 2000;   // Ek single batch/template execution me max 2000 users cover honge

function normalizeNotifyEntity(entity) {
  return String(entity || "")
    .replace(/-/g, "_")
    .toLowerCase();
}

function rawActionSlug(action) {
  const a = String(action || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  return /^[a-z][a-z0-9_]{0,63}$/.test(a) ? a : "";
}

function moduleNameCandidates(entity, appType, action = "") {
  const k = normalizeNotifyEntity(entity);
  const act = rawActionSlug(action);
  const names = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !names.includes(s)) names.push(s);
  };

  if (STICKER_NOTIFY_ACTIONS.has(act) && (k === "boxes" || k === "box" || k === "sticker_download_logs")) {
    add("packing_entry");
  }

  add(k);
  if (k.endsWith("s") && k.length > 2) add(k.slice(0, -1));
  if (!k.endsWith("s")) add(`${k}s`);
  if (k === "users" || k === "user") {
    add("users");
    add("user");
  }
  if (appType === "rmstore" && !k.startsWith("rm_")) {
    add(`rm_${k}`);
    if (!k.endsWith("s")) add(`rm_${k}s`);
  }
  return names;
}

function resolveNotifyEvents(action) {
  const raw = String(action || "").trim();
  if (!raw) return [];
  const a = raw.toLowerCase();
  const slug = a.replace(/\s+/g, "_");

  if (a.includes("creat") || a === "add") return ["add"];
  if (a.includes("approv") || a === "authorize") return ["approve"];
  if (a.includes("delet") || a === "remove") return ["delete"];
  if (a.includes("updat") || a === "edit" || a === "modify") return ["edit"];

  if (!/^[a-z][a-z0-9_]{0,63}$/.test(slug)) return [];
  return [...new Set([slug, ...(ACTION_TRIGGER_ALIASES[slug] ?? [])])];
}

function shouldSkipNotifyRequest(req, entity) {
  if (SKIP_NOTIFY_ENTITIES.has(normalizeNotifyEntity(entity))) return true;
  const url = String(req?.originalUrl || "").toLowerCase();
  return url.includes("notification-templates") || url.includes("/module-sops");
}

// ─── Shared ────────────────────────────────────────────────────────────────

export const ROLE_KEYS = ["super_admin", "admin", "user", "executive_assistant"];

export const EVENT_LABELS = {
  add: "Added",
  edit: "Edited",
  delete: "Deleted",
  approve: "Approved",
};

/** When one request matches several events, standard CRUD wins; else first matching custom action on the template. */
const EVENT_PRIORITY = ["approve", "add", "edit", "delete"];

export function humanizeTriggerEvent(event) {
  const key = String(event || "").trim().toLowerCase();
  if (EVENT_LABELS[key]) return EVENT_LABELS[key];
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickTemplateEvent(requestEvents, tplEvents) {
  const req = Array.isArray(requestEvents) ? requestEvents : [];
  const tpl = Array.isArray(tplEvents) ? tplEvents : [];
  const std = EVENT_PRIORITY.find((e) => req.includes(e) && tpl.includes(e));
  if (std) return std;
  return req.find((e) => tpl.includes(e)) ?? null;
}

const templateCache = new Map();
const moduleResolveCache = new Map();

async function runPool(items, limit, fn) {
  if (!items.length) return;
  let next = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}

export function invalidateTemplateCache() {
  templateCache.clear();
  moduleResolveCache.clear();
}

async function getActiveTemplates(moduleId) {
  const key = `id:${Number(moduleId)}`;
  const hit = templateCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.rows;
  const rows = await findActiveTemplatesByModuleId(moduleId);
  if (rows.length) {
    templateCache.set(key, { at: Date.now(), rows });
  }
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
const SKIP_VAR_KEYS = new Set(["password", "confirmpassword", "oldpassword", "token", "otp", "secret", "refresh_token", "access_token"]);

function slugVarKey(labelOrKey) {
  return String(labelOrKey || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
}

function mergeScalarsInto(out, src, { skipLogMeta = false } = {}) {
  if (!isPlainObject(src)) return;
  for (const [key, value] of Object.entries(src)) {
    const lower = key.toLowerCase();
    if (SKIP_VAR_KEYS.has(lower)) continue;
    if (skipLogMeta && (key === "summary" || key === "success")) continue;
    if (value == null) continue;
    if (isScalar(value)) {
      out[key] = scalarText(value);
      const slug = slugVarKey(key);
      if (slug && slug !== key) out[slug] = out[key];
    } else if (Array.isArray(value) && value.every(isScalar)) {
      out[key] = value.map(scalarText).join(", ");
    } else if (isPlainObject(value)) {
      mergeScalarsInto(out, value);
    }
  }
}

/** Activity log info/more sections use display labels; also expose snake_case keys for templates. */
function mergeLogDataSections(out, logData) {
  if (!isPlainObject(logData)) return;
  for (const section of ["info", "more"]) {
    const block = logData[section];
    if (!isPlainObject(block)) continue;
    for (const [label, value] of Object.entries(block)) {
      if (value == null || !isScalar(value)) continue;
      const text = scalarText(value);
      const slug = slugVarKey(label);
      if (slug) out[slug] = text;
    }
  }
  if (logData.ref != null && String(logData.ref).trim() !== "") {
    out.ref = String(logData.ref).trim();
  }
  if (logData.summary != null && String(logData.summary).trim() !== "") {
    out.summary = String(logData.summary).trim();
  }
}

function normalizeNotifyBody(body) {
  if (!isPlainObject(body)) return body;
  if (isPlainObject(body.employee)) return { ...body, ...body.employee };
  return body;
}

/** Merge request body, API response, and activity log into template variables (non-empty values only). */
function buildModuleNotifyVars({ body = {}, record = {}, logData = null, responseData = null } = {}) {
  const out = {};
  mergeScalarsInto(out, normalizeNotifyBody(body));
  mergeScalarsInto(out, responseData);
  mergeScalarsInto(out, record);
  if (isPlainObject(logData)) {
    mergeLogDataSections(out, logData);
    mergeScalarsInto(out, logData, { skipLogMeta: true });
  }
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v != null && String(v).trim() !== "")
  );
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


async function sendPwa({ tpl, user, title, body, appType }) {
  const trigger_key = `module_${tpl.id}`.slice(0, 50);
  const brand = resolvePushAppBrand(appType);
  const pushUrl = brand.defaultUrl || "/settings";
  const pushTitle = formatPushTitle(appType, title);

  const { row } = await saveInboxAlert({
    userId: user.id,
    app_type: appType,
    trigger_key,
    title,
    body,
    url: pushUrl,
  });

  const inboxSaved = row?.inbox_id != null;
  let ok = inboxSaved;
  let error = null;

  if (isWebPushConfigured()) {
    const push = await sendWebPushToUser(
      user.id,
      {
        title: pushTitle,
        body,
        url: pushUrl,
        tag: row?.inbox_id ? `inbox-${row.inbox_id}` : trigger_key,
        data: { url: pushUrl, inbox_id: row?.inbox_id ?? "" },
      },
      {
        inbox_id: row?.inbox_id ?? null,
        user_id: user.id,
        user_name: user.name,
        template_key: trigger_key,
        channel: "pwa_push",
        app_type: appType,
        inbox_delivered: inboxSaved,
        delivery_log: "inbox_single",
      }
    );
    if (push.ok) ok = true;
    else if (!ok) error = push.error || "Web push delivery failed";
  } else if (!inboxSaved) {
    error = "Inbox save failed";
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

async function deliverTemplate(tpl, event, { recordVars, recordId, actorName, sourceAction = "" }) {
  const labelAction = sourceAction || event;
  const baseVars = {
    ...recordVars,
    ...nowParts(),
    module_name: tpl.module_name,
    module_label: tpl.module_label,
    action: event,
    activity_action: labelAction,
    action_label: humanizeTriggerEvent(labelAction),
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

  const logBuffer = [];

  let recipients = await resolveAudience(tpl.audience ?? effectiveAudience(tpl));
  if (!recipients.length) {
    console.warn(`[Module notify] template ${tpl.id} (${tpl.name}): no recipients for audience`);
    logBuffer.push({
      ...common,
      recipient_user_id: null,
      channel: "system",
      recipient: null,
      title: renderTemplate(tpl.subject || tpl.module_label, baseVars),
      message: renderTemplate(tpl.message, baseVars),
      status: "skipped",
      error_detail: "No recipients matched audience",
    });
    await insertNotificationLogsBatch(logBuffer).catch((err) => {
      console.error("[Module notify] batch log failed:", err.message);
    });
    return;
  }

  if (recipients.length > MAX_RECIPIENTS_PER_TEMPLATE) {
    console.warn(
      `[Module notify] template ${tpl.id}: ${recipients.length} recipients — capping at ${MAX_RECIPIENTS_PER_TEMPLATE}`
    );
    recipients = recipients.slice(0, MAX_RECIPIENTS_PER_TEMPLATE);
  }

  await runPool(recipients, DELIVER_CONCURRENCY, async (user) => {
    const vars = { ...baseVars, user_name: user.name ?? "" };
    const title = renderTemplate(tpl.subject || `${tpl.module_label} — ${humanizeTriggerEvent(event)}`, vars);
    const body = renderTemplate(tpl.message, vars);
    const message = title ? `${title}\n\n${body}` : body;

    if (tpl.pwa_enabled) {
      try {
        const pwa = await sendPwa({ tpl, user, title, body, appType });
        logBuffer.push({
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
        logBuffer.push({
          ...common,
          recipient_user_id: user.id,
          channel: "pwa_push",
          recipient: `user:${user.id}`,
          title,
          message: body,
          status: "failed",
          error_detail: err.message,
        });
      }
    }

    if (tpl.send_via && tpl.send_via !== "none") {
      if (!user.phone) {
        logBuffer.push({
          ...common,
          recipient_user_id: user.id,
          channel: tpl.send_via,
          recipient: null,
          title,
          message: body,
          status: "skipped",
          error_detail: "User has no phone",
        });
      } else {
        try {
          const wa = await sendWhatsApp({ tpl, user, title, body, message, vars });
          logBuffer.push({
            ...common,
            recipient_user_id: user.id,
            channel: tpl.send_via,
            recipient: user.phone,
            title,
            message: body,
            status: wa.ok ? "sent" : "failed",
            error_detail: wa.error,
          });
        } catch (err) {
          logBuffer.push({
            ...common,
            recipient_user_id: user.id,
            channel: tpl.send_via,
            recipient: user.phone,
            title,
            message: body,
            status: "failed",
            error_detail: err.message,
          });
        }
      }
    }

    if (tpl.email_enabled) {
      try {
        const mail = await sendEmail({ user, title, body });
        logBuffer.push({
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
        logBuffer.push({
          ...common,
          recipient_user_id: user.id,
          channel: "email",
          recipient: user.email || null,
          title,
          message: body,
          status: "failed",
          error_detail: err.message,
        });
      }
    }
  });

  if (!logBuffer.length) {
    logBuffer.push({
      ...common,
      recipient_user_id: null,
      channel: "system",
      recipient: null,
      title: renderTemplate(tpl.subject || tpl.module_label, baseVars),
      message: renderTemplate(tpl.message, baseVars),
      status: "skipped",
      error_detail: "All delivery channels disabled on template",
    });
  }

  if (logBuffer.length) {
    await insertNotificationLogsBatch(logBuffer).catch((err) => {
      console.error("[Module notify] batch log failed:", err.message);
    });
  }
}

// ─── Dispatch (templates → inbox / push / WA) ───

export async function dispatchModuleEvent({
  moduleName,
  moduleId = null,
  events = [],
  sourceAction = "",
  record = {},
  body = {},
  logData = null,
  responseData = null,
  recordId = null,
  actorName = null,
}) {
  try {
    if (!events.length) return;
    const mid = Number(moduleId);
    if (!Number.isFinite(mid) || mid <= 0) {
      console.warn(`[Module notify] Missing module id for "${moduleName}"`);
      return;
    }
    const templates = await getActiveTemplates(mid);
    if (!templates.length) {
      console.warn(
        `[Module notify] No active templates for module "${moduleName}" (id ${mid}, events: ${events.join(", ")})`
      );
      return;
    }

    const recordVars = buildModuleNotifyVars({ body, record, logData, responseData });

    let matched = false;
    for (const tpl of templates) {
      const tplEvents = Array.isArray(tpl.trigger_events) ? tpl.trigger_events : [];
      const event = pickTemplateEvent(events, tplEvents);
      if (!event) continue;
      matched = true;
      try {
        await deliverTemplate(tpl, event, { recordVars, recordId, actorName, sourceAction });
      } catch (err) {
        console.error(`[Module notify] template ${tpl.id} failed:`, err.message);
      }
    }
    if (!matched) {
      console.warn(
        `[Module notify] Module "${moduleName}": no template trigger matched events [${events.join(", ")}]`
      );
    }
  } catch (err) {
    console.error(`[Module notify] ${moduleName} dispatch failed:`, err.message);
  }
}

async function resolveNotifyModule(entity, appType, action = "") {
  const k = normalizeNotifyEntity(entity);
  if (!k) return null;

  const cacheKey = `${appType}:${k}:${rawActionSlug(action)}`;
  const hit = moduleResolveCache.get(cacheKey);
  if (hit && Date.now() - hit.t < MODULE_RESOLVE_CACHE_MS && hit.row?.id) return hit.row;

  const names = moduleNameCandidates(entity, appType, action);
  const [row] = await dbQuery(
    `SELECT m.id, m.name, m.label, m.app_type
     FROM ${M.MODULES} m
     WHERE m.is_active = true AND m.name = ANY($1::text[])
     ORDER BY
       (EXISTS (
          SELECT 1 FROM ${M.NOTIFICATION_TEMPLATES} nt
          WHERE nt.module_id = m.id AND nt.is_active = true AND nt.is_deleted = false
        )) DESC,
       array_position($1::text[], m.name)
     LIMIT 1`,
    [names]
  );
  if (row?.id) moduleResolveCache.set(cacheKey, { t: Date.now(), row });
  return row ?? null;
}

// ─── Activity log → notify (called from logActivity + activityLogger) ───
export function scheduleNotifyFromActivity(req, opts = {}) {
  try {
    if (!MODULE_NOTIFY_FROM_ACTIVITY) return;
    if (opts.success === false || req?._moduleNotifyDispatched) return;
    if (shouldSkipNotifyRequest(req, opts.entity)) return;

    const events = resolveNotifyEvents(opts.action);
    if (!events.length || !opts.entity) return;

    req._moduleNotifyDispatched = true;

    const payload = {
      entity: opts.entity,
      appType: opts.appType || "ims",
      action: opts.action,
      events,
      sourceAction: rawActionSlug(opts.action),
      record: opts.record && typeof opts.record === "object" ? opts.record : {},
      body: {
        ...(opts.body && typeof opts.body === "object" ? opts.body : {}),
        ...(opts.details && typeof opts.details === "object" ? opts.details : {}),
        ...(opts.meta && typeof opts.meta === "object" ? opts.meta : {}),
      },
      logData: opts.log_data && typeof opts.log_data === "object" ? opts.log_data : null,
      responseData: opts.responseData && typeof opts.responseData === "object" ? opts.responseData : null,
      recordId: opts.entity_id != null ? String(opts.entity_id) : null,
      actorName: req?.user?.name || auditUserName(req),
    };

    setImmediate(() => {
      void (async () => {
        try {
          const mod = await resolveNotifyModule(payload.entity, payload.appType, payload.action);
          if (!mod?.id) {
            console.warn(`[Module notify] Unknown module for entity "${payload.entity}" (${payload.appType})`);
            return;
          }
          await dispatchModuleEvent({
            moduleId: mod.id,
            moduleName: mod.name,
            events: payload.events,
            sourceAction: payload.sourceAction,
            record: payload.record,
            body: payload.body,
            logData: payload.logData,
            responseData: payload.responseData,
            recordId: payload.recordId,
            actorName: payload.actorName,
          });
        } catch (err) {
          console.error("[Module notify]", err.message);
        }
      })();
    });
  } catch (err) {
    console.error("[Module notify] schedule:", err.message);
  }
}
