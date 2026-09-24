import dbQuery from "../../../../config/db/db.js";
import { MST_TABLES as M } from "../../../../config/db/dbTables.js";
import { TRIGGER_EVENTS, RECIPIENT_TYPES, SEND_VIA_OPTIONS, findNotificationTemplates, findNotificationTemplate, findConflictingTemplate, insertNotificationTemplate, updateNotificationTemplate, 
  deleteNotificationTemplate, normalizeAudience, audienceHasAny, isAudienceDimActive, legacyFromAudience, audienceFromLegacy } from "./notificationTemplate.model.js";
import { findNotificationLogs } from "./notificationTemplateLog.model.js";
import { findModule } from "../../identity/modules/models/module.model.js";
import { ROLE_KEYS, invalidateTemplateCache, resolveRecipients, resolveAudience, normalizeRecipientRefs } from "./moduleNotify.service.js";
import { extractListParams } from "../../lib/utils/query/queryHelper.js";
import { auditUserName } from "../../lib/utils/auth/approval.js";

const RECIPIENT_COUNT = {
  attribute: `SELECT COUNT(*)::int AS c FROM ${M.ATTRIBUTES} WHERE id = ANY($1::int[]) AND is_deleted = false`,
  department: `SELECT COUNT(*)::int AS c FROM ${M.DEPARTMENTS} WHERE id = ANY($1::int[])`,
  designation: `SELECT COUNT(*)::int AS c FROM ${M.DESIGNATIONS} WHERE id = ANY($1::int[])`,
  user: `SELECT COUNT(*)::int AS c FROM ${M.USERS} WHERE id = ANY($1::int[]) AND is_deleted = false`,
};

const badRequest = (res, message) => res.status(400).json({ success: false, message });

function normalizeEvents(raw) {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return [...new Set(list.map((e) => String(e).trim().toLowerCase()))].filter((e) => TRIGGER_EVENTS.includes(e));
}

async function validateAudienceDim(key, dim) {
  if (!isAudienceDimActive(dim)) return null;
  if (dim.all) return null;
  if (key === "roles") {
    if (dim.ids.some((r) => !ROLE_KEYS.includes(r))) return "Invalid role";
    return null;
  }
  const typeMap = { departments: "department", designations: "designation", attributes: "attribute", users: "user" };
  const type = typeMap[key];
  if (!type) return null;
  if (dim.ids.some((r) => !/^\d+$/.test(r))) return `Invalid ${type}`;
  const [{ c } = { c: 0 }] = await dbQuery(RECIPIENT_COUNT[type], [dim.ids]);
  if (c !== dim.ids.length) return `One or more selected ${type}s were not found`;
  return null;
}

/** Validate + normalise the editable fields; `partial` skips required checks for fields not sent. */
async function buildTemplateFields(body = {}, { partial = false, existing = null } = {}) {
  const fields = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("module_id")) {
    const module_id = parseInt(body.module_id, 10);
    if (!Number.isFinite(module_id)) return { error: "Module is required" };
    const mod = await findModule({ id: module_id });
    if (!mod) return { error: "Module not found" };
    fields.module_id = module_id;
  }

  if (!partial || has("name")) {
    const name = String(body.name ?? "").trim();
    if (!name) return { error: "Template name is required" };
    if (name.length > 150) return { error: "Template name must be at most 150 characters" };
    fields.name = name;
  }

  if (has("subject")) fields.subject = String(body.subject ?? "").trim() || null;

  if (!partial || has("message")) {
    const message = String(body.message ?? "").trim();
    if (!message) return { error: "Message is required" };
    fields.message = message;
  }

  if (!partial || has("trigger_events")) {
    const events = normalizeEvents(body.trigger_events);
    if (!events.length) return { error: "Select a trigger event" };
    if (events.length > 1) return { error: "Only one trigger event per template (same as SOP — one per permission)" };
    fields.trigger_events = events;
  }

  // Audience (preferred) — also accept legacy recipient_type + recipient_refs
  if (!partial || has("audience") || has("recipient_type") || has("recipient_refs")) {
    let audience;
    if (has("audience")) {
      audience = normalizeAudience(body.audience);
    } else if (has("recipient_type") || has("recipient_refs")) {
      const recipient_type = String(body.recipient_type ?? existing?.recipient_type ?? "").trim();
      const recipient_refs = normalizeRecipientRefs(
        has("recipient_refs") ? body.recipient_refs : has("recipient_type") ? [] : existing?.recipient_refs
      );
      if (recipient_type && RECIPIENT_TYPES.includes(recipient_type) && recipient_refs.length) {
        audience = audienceFromLegacy(recipient_type, recipient_refs);
      } else {
        audience = normalizeAudience(existing?.audience);
      }
    } else {
      audience = normalizeAudience(existing?.audience);
    }

    if (!audienceHasAny(audience)) {
      return { error: "Select at least one of: department, designation, attribute, role, or person" };
    }

    for (const key of ["departments", "designations", "attributes", "roles", "users"]) {
      const err = await validateAudienceDim(key, audience[key]);
      if (err) return { error: err };
    }

    const legacy = legacyFromAudience(audience);
    fields.audience = audience;
    fields.recipient_type = legacy.recipient_type;
    fields.recipient_refs = legacy.recipient_refs;
  }

  if (has("pwa_enabled")) fields.pwa_enabled = !!body.pwa_enabled;
  if (has("email_enabled")) fields.email_enabled = !!body.email_enabled;
  if (has("send_via")) {
    const send_via = String(body.send_via || "none");
    if (!SEND_VIA_OPTIONS.includes(send_via)) return { error: "Invalid WhatsApp channel" };
    fields.send_via = send_via;
  }
  if (has("is_active")) fields.is_active = !!body.is_active;

  const pwa = fields.pwa_enabled ?? existing?.pwa_enabled ?? true;
  const email = fields.email_enabled ?? existing?.email_enabled ?? false;
  const via = fields.send_via ?? existing?.send_via ?? "none";
  if (!pwa && !email && via === "none") return { error: "Enable at least one channel: PWA, WhatsApp, or Email" };

  return { fields };
}

export const getNotificationTemplates = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "id", order: "DESC", limit: 500 });
    const result = await findNotificationTemplates({
      filters: filters || {},
      search,
      sort: { by: sortBy, order },
      page,
      limit,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getNotificationTemplateById = async (req, res) => {
  try {
    const row = await findNotificationTemplate(req.body?.id);
    if (!row) return res.status(404).json({ success: false, message: "Template not found" });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createNotificationTemplate = async (req, res) => {
  try {
    const { fields, error } = await buildTemplateFields(req.body);
    if (error) return badRequest(res, error);

    const conflict = await findConflictingTemplate(fields.module_id, fields.trigger_events);
    if (conflict) {
      return badRequest(
        res,
        `A notification template already exists for this module and ${fields.trigger_events[0]} (same as SOP — one per permission)`
      );
    }

    const created = await insertNotificationTemplate({ ...fields, created_by: auditUserName(req) });
    invalidateTemplateCache();
    const row = await findNotificationTemplate(created.id);
    res.json({ success: true, message: "Template created", data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateNotificationTemplateController = async (req, res) => {
  try {
    const { id } = req.body || {};
    const existing = await findNotificationTemplate(id);
    if (!existing) return res.status(404).json({ success: false, message: "Template not found" });

    const { fields, error } = await buildTemplateFields(req.body, { partial: true, existing });
    if (error) return badRequest(res, error);

    const module_id = fields.module_id ?? existing.module_id;
    const trigger_events = fields.trigger_events ?? existing.trigger_events;
    const conflict = await findConflictingTemplate(module_id, trigger_events, id);
    if (conflict) {
      return badRequest(
        res,
        `A notification template already exists for this module and ${Array.isArray(trigger_events) ? trigger_events[0] : trigger_events} (same as SOP — one per permission)`
      );
    }

    const updated = await updateNotificationTemplate(id, {
      ...fields,
      updated_by: auditUserName(req),
      updated_at: new Date(),
    });
    if (!updated) return res.status(404).json({ success: false, message: "Template not found" });
    invalidateTemplateCache();
    const row = await findNotificationTemplate(id);
    res.json({ success: true, message: "Template updated", data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const toggleNotificationTemplate = async (req, res) => {
  try {
    const { id } = req.body || {};
    const existing = await findNotificationTemplate(id);
    if (!existing) return res.status(404).json({ success: false, message: "Template not found" });

    const is_active = req.body?.is_active !== undefined ? !!req.body.is_active : !existing.is_active;
    await updateNotificationTemplate(id, { is_active, updated_by: auditUserName(req), updated_at: new Date() });
    invalidateTemplateCache();
    const row = await findNotificationTemplate(id);
    res.json({ success: true, message: is_active ? "Template activated" : "Template deactivated", data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteNotificationTemplateController = async (req, res) => {
  try {
    const ok = await deleteNotificationTemplate(req.body?.id, { deleted_by: auditUserName(req) });
    if (!ok) return res.status(404).json({ success: false, message: "Template not found" });
    invalidateTemplateCache();
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getNotificationTemplateLogs = async (req, res) => {
  try {
    const result = await findNotificationLogs(req.body || {});
    res.json({
      success: true,
      data: {
        ...result,
        totalPages: Math.ceil(result.total / result.limit) || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Dropdown sources for the template form (existing masters only). */
export const getNotificationTemplateOptions = async (req, res) => {
  try {
    const [modules, attributes, departments, designations, users] = await Promise.all([
      dbQuery(`SELECT id, name, label, app_type, is_active FROM ${M.MODULES} ORDER BY app_type, label`),
      dbQuery(`SELECT id, name FROM ${M.ATTRIBUTES} WHERE is_deleted = false ORDER BY name`),
      dbQuery(`SELECT id, name FROM ${M.DEPARTMENTS} ORDER BY name`),
      dbQuery(`SELECT id, name FROM ${M.DESIGNATIONS} ORDER BY name`),
      dbQuery(
        `SELECT id, name, username, usercode, type, status FROM ${M.USERS}
         WHERE is_deleted = false AND COALESCE(status, 'active') <> 'inactive'
         ORDER BY name`
      ),
    ]);
    res.json({
      success: true,
      data: {
        modules,
        attributes,
        departments,
        designations,
        users,
        roles: ROLE_KEYS,
        trigger_events: TRIGGER_EVENTS,
        recipient_types: RECIPIENT_TYPES,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** Preview how many users an audience (or legacy single rule) currently resolves to. */
export const previewNotificationRecipients = async (req, res) => {
  try {
    const { audience, recipient_type, recipient_refs } = req.body || {};
    let users;
    if (audience && typeof audience === "object") {
      users = await resolveAudience(audience);
    } else if (RECIPIENT_TYPES.includes(recipient_type)) {
      users = await resolveRecipients(recipient_type, recipient_refs);
    } else {
      return badRequest(res, "Invalid audience");
    }
    res.json({ success: true, data: { count: users.length, users: users.map((u) => ({ id: u.id, name: u.name })) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
