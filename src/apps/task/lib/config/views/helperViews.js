import { pageHelperAccess } from "../../../../core/lib/middleware/pageHelperAccess.js";

const VIEW = "view";
const FORM_ACTIONS = ["add", "edit", "authorize"];
const isForm = (act) => FORM_ACTIONS.includes(act);

/** Picker fields for task category dropdowns. */
const CATEGORY_PICKER_FIELDS = ["id", "name"];

/**
 * Which pages may call /task/categories/helper (IMS-style).
 * Returns field list if allowed, otherwise null.
 */
export function resolveCategoryHelperFields({ permission_module, permission_action } = {}) {
  const mod = String(permission_module || "").toLowerCase().trim();
  const act = String(permission_action || "").toLowerCase().trim();
  if (!mod || !act) return null;

  // Task list / assign / self filters & forms
  if (mod === "tasks" && (act === VIEW || isForm(act))) return [...CATEGORY_PICKER_FIELDS];

  // Recurring task forms & filters
  if (mod === "recurring_task" && (act === VIEW || isForm(act))) return [...CATEGORY_PICKER_FIELDS];

  // Task report filters
  if (mod === "task_report" && (act === VIEW || isForm(act))) return [...CATEGORY_PICKER_FIELDS];

  // Category module itself (if needed as helper)
  if (mod === "category" && (act === VIEW || isForm(act))) return [...CATEGORY_PICKER_FIELDS];

  // Red ticket forms that may reference task categories
  if (mod === "red_ticket" && (act === VIEW || isForm(act))) return [...CATEGORY_PICKER_FIELDS];

  return null;
}

/** Route middleware — same contract as IMS helperAccess + core pageHelperAccess. */
export function categoryHelperAccess() {
  return pageHelperAccess(resolveCategoryHelperFields);
}
