const APPROVE_TRUE_VALUES = new Set(["true", "1", "approved", "approve", "final", "yes", "y", "on"]);
const APPROVE_FALSE_VALUES = new Set(["false", "0", "draft", "pending", "hold", "no", "n", "off"]);

const toHttpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const isAuthorizeAllowed = (req, canAuthorizeOverride) => {
  if (canAuthorizeOverride !== undefined) return Boolean(canAuthorizeOverride);
  return Boolean(req?.permission?.can_authorize) || req?.user?.type === "super_admin";
};

const applyApprovedFields = (fields, approver, approvalTimestamp) => {
  fields.approved = true;
  fields.approved_by = approver;
  fields.approved_at = approvalTimestamp ? new Date(approvalTimestamp) : new Date();
};

const applyPendingFields = (fields) => {
  fields.approved = false;
  fields.approved_by = null;
  fields.approved_at = null;
};

export function auditUserName(req) {
  const candidates = [req?.user?.name, req?.user?.username];
  for (const value of candidates) {
    if (value == null) continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const applyApprovalWorkflow = ({ req, fields, incomingApproved, hasBusinessChanges, canAuthorize: canAuthorizeOverride, auditAsName = false, alreadyApproved = false, approvalTimestamp }) => {
  if (incomingApproved === true) {
    if (!isAuthorizeAllowed(req, canAuthorizeOverride)) {
      throw toHttpError("You do not have approval permission", 403);
    }
    if (alreadyApproved && !hasBusinessChanges) {
      throw toHttpError("This record is already approved. Edit it before approving again.", 409);
    }
    applyApprovedFields(fields, auditAsName ? auditUserName(req) : req?.user?.id, approvalTimestamp);
    return;
  }

  if (incomingApproved === false || hasBusinessChanges) {
    applyPendingFields(fields);
  }
};

export const normalizeApprovedInput = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (APPROVE_TRUE_VALUES.has(normalized)) return true;
    if (APPROVE_FALSE_VALUES.has(normalized)) return false;
  }

  throw toHttpError("Invalid approved value. Use true/false or approved/draft.", 400);
};

export const equalIntLists = (left = [], right = []) => {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export const prepareUpdateByRules = ({ existing = {}, input = {}, rules = [] }) => {
  const fields = {};
  let hasChanges = false;

  for (const rule of rules) {
    const field = rule?.field;
    if (!field) continue;

    const source = rule?.source || field;
    const rawNext = input[source];
    if (rawNext === undefined) continue;

    const normalize = typeof rule?.normalize === "function" ? rule.normalize : (v) => v;
    const isEqual = typeof rule?.isEqual === "function" ? rule.isEqual : (a, b) => a === b;

    const next = normalize(rawNext);
    if (next === undefined) continue;
    const prev = normalize(existing[field]);

    if (!isEqual(next, prev, rawNext, existing[field])) hasChanges = true;
    fields[field] = next;
  }

  return { fields, hasChanges };
};

export const applyApprovalUpdateFields = ({ req, fields, incomingApproved, hasBusinessChanges, alreadyApproved = false, auditAsName = false, canAuthorize }) => {
  if (hasBusinessChanges) {
    fields.updated_by = auditAsName ? auditUserName(req) : req?.user?.id ?? null;
    fields.updated_at = new Date();
  }

  applyApprovalWorkflow({ req, fields, incomingApproved, hasBusinessChanges, alreadyApproved, auditAsName, canAuthorize });
};
