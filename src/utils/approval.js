export const applyApprovalWorkflow = ({req, fields, incomingApproved, hasBusinessChanges }) => {
  const canAuthorize = Boolean(req?.permission?.can_authorize) || req?.user?.type === "super_admin";

  if (incomingApproved === true) {
    if (!canAuthorize) {
      const err = new Error("You do not have approval permission");
      err.statusCode = 403;
      throw err;
    }

    fields.approved = true;
    fields.approved_by = req.user.id;
    fields.approved_at = new Date();
    return;
  }

  if (incomingApproved === false || hasBusinessChanges) {
    fields.approved = false;
    fields.approved_by = null;
    fields.approved_at = null;
  }
};

export const normalizeApprovedInput = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "approved", "approve", "final", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "draft", "pending", "hold", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  const err = new Error("Invalid approved value. Use true/false or approved/draft.");
  err.statusCode = 400;
  throw err;
};
