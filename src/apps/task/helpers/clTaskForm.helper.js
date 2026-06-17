import path from "path";
import config from "../../../config/config.js";

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
    const empty = val === undefined || val === null || val === "" ||
      (field.type === "multiselect" && (!Array.isArray(val) || val.length === 0)) ||
      (field.type === "checkbox" && val !== true && val !== false) ||
      (typeof val === "object" && !Array.isArray(val) && !val.file_path && !val.file_name);

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
  return [{ id: "legacy", filled_at: null, responses: parsed }];
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
    const match = file.fieldname.match(/^e(\d+)__(.+)$/);
    if (!match) continue;
    const idx = Number(match[1]);
    const fieldId = match[2];
    if (!result[idx]) continue;
    const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
    result[idx].responses[fieldId] = {
      file_name: file.originalname,
      file_path: path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/"),
      mime_type: file.mimetype,
      size: file.size,
    };
  }

  return result;
}
