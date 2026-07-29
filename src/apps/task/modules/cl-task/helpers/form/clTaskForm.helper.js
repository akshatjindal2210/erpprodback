import path from "path";
import config from "../../../../../../config/app/config.js";

export function parseFormSchema(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseFormResponses(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function validateFormResponses(schema, responses) {
  const errors = [];
  for (const field of schema) {
    if (field.type === "section") continue;
    const val = responses[field.id];
    const attachmentEmpty = field.type === "attachment" && (
      Array.isArray(val)
        ? !val.some((v) => v?.file_path || v?.file_name)
        : !(val && (val.file_path || val.file_name))
    );
    const empty = val === undefined || val === null || val === "" ||
      (field.type === "multiselect" && (!Array.isArray(val) || val.length === 0)) ||
      (field.type === "checkbox" && val !== true && val !== false) ||
      attachmentEmpty ||
      (field.type !== "attachment" && typeof val === "object" && !Array.isArray(val) && !val.file_path && !val.file_name);

    if (field.required && empty) {
      errors.push(`${field.label || field.id} is required`);
      continue;
    }
    if (field.type === "numeric" && val !== undefined && val !== null && val !== "") {
      const num = Number(val);
      if (Number.isNaN(num)) errors.push(`${field.label} must be a number`);
      else {
        if (field.min != null && num < Number(field.min)) errors.push(`${field.label} must be at least ${field.min}`);
        if (field.max != null && num > Number(field.max)) errors.push(`${field.label} must be at most ${field.max}`);
      }
    }
    if (field.type === "email" && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) {
      errors.push(`${field.label || "Email"} must be a valid email`);
    }
  }
  return errors;
}

export function mergeUploadedFiles(responses, files = []) {
  const merged = { ...responses };
  for (const file of files) {
    const fieldId = file.fieldname;
    const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
    merged[fieldId] = {
      file_name: file.originalname,
      file_path: path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/"),
      mime_type: file.mimetype,
      size: file.size,
    };
  }
  return merged;
}

export function normalizeToEntries(raw) {
  const parsed = parseFormResponses(raw);
  if (Array.isArray(parsed.entries)) return parsed.entries;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return [];
  // Ignore meta keys used by open-task fill history
  if (keys.every((k) => k === "fills" || k === "entries")) return [];
  const { fills, entries, ...rest } = parsed;
  if (Object.keys(rest).length === 0) return [];
  return [{ id: "legacy", filled_at: null, responses: rest }];
}

/** Archived completed fills for open tasks (same instance, many fills). */
export function getOpenFills(raw) {
  const parsed = parseFormResponses(raw);
  return Array.isArray(parsed.fills) ? parsed.fills : [];
}

export function buildOpenFormResponses({ entries = [], fills = [] } = {}) {
  return {
    entries: Array.isArray(entries) ? entries : [],
    fills: Array.isArray(fills) ? fills : [],
  };
}

/**
 * Map one archived open fill to a submission history row.
 * fill_id keeps multiple fills on the same instance distinct.
 */
export function serializeOpenFillAsSubmission(task, fill) {
  if (!task || !fill) return null;
  return {
    instance_id: task.instance_id,
    fill_id: fill.id || null,
    cl_task_id: task.cl_task_id,
    title: task.title,
    task_type: task.task_type,
    recurrence_type: task.recurrence_type || null,
    status: fill.status || "completed",
    score: fill.score != null ? Number(fill.score) : null,
    weightage: task.weightage ?? task.wastage ?? null,
    reject_count: Math.max(0, Number(fill.reject_count) || 0),
    scheduled_date: fill.completed_at || fill.submitted_at || fill.filled_at || task.scheduled_date,
    submitted_at: fill.submitted_at || fill.filled_at || null,
    completed_at: fill.completed_at || null,
    person_remark: fill.person_remark || null,
    verifier_remark: fill.verifier_remark || null,
    form_schema: task.form_schema,
    form_responses: { entries: Array.isArray(fill.entries) ? fill.entries : [] },
    person_name: task.person_name,
    person_id: task.person_id,
    verification_user_name: task.verification_user_name || null,
  };
}

/**
 * Archive the current open-task cycle into fills[], then clear current entries
 * so the same instance can be filled again (no new DB row).
 *
 * @param {string} [opts.status] completed | awaiting_verification | rejected
 */
export function archiveOpenFill(raw, {
  score = null,
  rejectCount = 0,
  personRemark = null,
  verifierRemark = null,
  submittedAt = null,
  completedAt = null,
  status = "completed",
} = {}) {
  const parsed = parseFormResponses(raw);
  const currentEntries = normalizeToEntries(parsed);
  const fills = getOpenFills(parsed);
  const nowIso = new Date().toISOString();
  const fillStatus = status || "completed";
  const archived = {
    id: `fill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: fillStatus,
    filled_at: currentEntries[0]?.filled_at || nowIso,
    submitted_at: submittedAt || nowIso,
    completed_at: fillStatus === "completed" ? (completedAt || nowIso) : null,
    score: score != null ? Number(score) : null,
    reject_count: Math.max(0, Number(rejectCount) || 0),
    person_remark: personRemark || null,
    verifier_remark: verifierRemark || null,
    entries: currentEntries,
  };
  return {
    formResponses: buildOpenFormResponses({
      entries: [],
      fills: [...fills, archived],
    }),
    archivedFill: archived,
  };
}

/** Fills waiting for verifier on an open instance. */
export function getAwaitingOpenFills(raw) {
  return getOpenFills(raw).filter((f) => {
    if (f.status === "awaiting_verification") return true;
    if (f.status === "completed" || f.status === "rejected") return false;
    // Legacy fills without status: treat as awaiting if not scored/completed
    return f.score == null && !f.completed_at;
  });
}

/**
 * Patch one archived/open fill (entries, remarks, score) without touching current entries.
 * Used by Super Admin report edits of past + selected fills.
 */
export function patchOpenFillInResponses(
  raw,
  fillId,
  { entries, personRemark, verifierRemark, score } = {},
) {
  if (fillId == null || fillId === "") return { error: "fill_id required" };
  const parsed = parseFormResponses(raw);
  const fills = getOpenFills(parsed);
  const idx = fills.findIndex((f) => String(f.id) === String(fillId));
  if (idx < 0) return { error: "Fill not found" };
  const next = fills.map((f, i) => {
    if (i !== idx) return f;
    const patched = { ...f };
    if (entries !== undefined) patched.entries = Array.isArray(entries) ? entries : [];
    if (personRemark !== undefined) patched.person_remark = personRemark || null;
    if (verifierRemark !== undefined) patched.verifier_remark = verifierRemark || null;
    if (score !== undefined) {
      patched.score = score == null || score === "" ? null : Number(score);
    }
    return patched;
  });
  return {
    formResponses: buildOpenFormResponses({
      entries: normalizeToEntries(parsed),
      fills: next,
    }),
  };
}

/** Approve one open fill in-place (instance stays pending for more fills). */
export function approveOpenFillInResponses(raw, fillId, { score = null, verifierRemark = null } = {}) {
  const parsed = parseFormResponses(raw);
  const fills = getOpenFills(parsed);
  const idx = fills.findIndex((f) => String(f.id) === String(fillId));
  if (idx < 0) return { error: "Fill not found" };
  const nowIso = new Date().toISOString();
  const next = fills.map((f, i) =>
    i === idx
      ? {
          ...f,
          status: "completed",
          score: score != null ? Number(score) : f.score,
          verifier_remark: verifierRemark || f.verifier_remark || null,
          completed_at: nowIso,
        }
      : f,
  );
  return {
    formResponses: buildOpenFormResponses({
      entries: normalizeToEntries(parsed),
      fills: next,
    }),
  };
}

/**
 * Reject one open fill: pull back into current entries when empty,
 * else mark fill as rejected so Due/history can still show rework.
 */
export function rejectOpenFillInResponses(raw, fillId, verifierRemark) {
  const parsed = parseFormResponses(raw);
  const fills = getOpenFills(parsed);
  const idx = fills.findIndex((f) => String(f.id) === String(fillId));
  if (idx < 0) return { error: "Fill not found" };
  const fill = fills[idx];
  const currentEntries = normalizeToEntries(parsed);
  const currentBusy = currentEntries.some(
    (e) => e?.responses && Object.keys(e.responses).length > 0,
  );
  const nextReject = Math.max(0, Number(fill.reject_count) || 0) + 1;

  if (!currentBusy) {
    const nextFills = fills.filter((_, i) => i !== idx);
    return {
      formResponses: buildOpenFormResponses({
        entries: fill.entries || [],
        fills: nextFills,
      }),
      personRemark: fill.person_remark || null,
      verifierRemark: verifierRemark || null,
      rejectCount: nextReject,
      pulledBack: true,
    };
  }

  const next = fills.map((f, i) =>
    i === idx
      ? {
          ...f,
          status: "rejected",
          reject_count: nextReject,
          verifier_remark: verifierRemark || null,
        }
      : f,
  );
  return {
    formResponses: buildOpenFormResponses({
      entries: currentEntries,
      fills: next,
    }),
    personRemark: null,
    verifierRemark: verifierRemark || null,
    rejectCount: nextReject,
    pulledBack: false,
  };
}

export function validateFormEntries(schema, entries) {
  if (!schema.length) return [];
  if (!entries.length) return ["At least one form entry is required"];
  const errors = [];
  entries.forEach((entry, i) => {
    const rowErrors = validateFormResponses(schema, entry.responses || {});
    rowErrors.forEach((msg) => errors.push(`Entry ${i + 1}: ${msg}`));
  });
  return errors;
}

export function mergeEntryUploadedFiles(entries, files = []) {
  const result = entries.map((e) => ({
    ...e,
    responses: { ...(e.responses || {}) },
  }));

  for (const file of files) {
    const match = String(file.fieldname || "").match(/^e(\d+)__(.+)$/);
    if (!match) continue;
    const idx = Number(match[1]);
    const fieldId = match[2];
    if (!result[idx]) continue;
    const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
    const meta = {
      file_name: file.originalname,
      file_path: path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/"),
      mime_type: file.mimetype,
      size: file.size,
    };
    const current = result[idx].responses[fieldId];
    if (Array.isArray(current)) {
      result[idx].responses[fieldId] = [...current, meta];
    } else if (current?.file_path) {
      result[idx].responses[fieldId] = [current, meta];
    } else {
      result[idx].responses[fieldId] = [meta];
    }
  }

  return result;
}

/** Build public attachment meta from a multer file for CL master/instance. */
export function buildClAttachmentMeta(file) {
  if (!file) return null;
  const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
  return {
    file_name: file.originalname,
    file_path: path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/"),
    mime_type: file.mimetype,
    size: file.size,
  };
}

/** Always return attachment list. Legacy single object → [object]. */
export function parseClAttachments(raw) {
  const parsed = parseJsonField(raw, null);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter((a) => a?.file_path);
  if (parsed?.file_path) return [parsed];
  return [];
}

export function parseJsonField(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
