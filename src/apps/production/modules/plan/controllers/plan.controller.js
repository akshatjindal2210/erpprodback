/**
 * Production Planning — prod_plan lines (board, calendar, table UI).
 * Rows are synced from Maintain Job Card process_plan (see plan.model syncPlanFromJobCard).
 */
import { listPlanningTableRows } from "./plan.controller.helpers.js";

/** POST /plan/table — all plan lines for authorized job cards */
export async function getPlanningTable(req, res) {
  try {
    const data = await listPlanningTableRows();
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load planning table." });
  }
}
