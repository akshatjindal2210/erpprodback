/**
 * Production Planning — reads/writes prod_plan only (Board / Calendar / Table).
 * prod_jc is written only from Maintain Job Card (process / machine / stage at JC save).
 */
import { getImsMapsSafe } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { deletePlanLine, findPlanLine, updatePlanLine } from "../models/plan.model.js";
import { enrichPlanRows, listPlanningTableRows } from "./plan.controller.helpers.js";

function toDocno(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** POST /plan/table — plan lines + joins; optional IMS date filters { from_date, to_date } on plan_start */
export async function getPlanningTable(req, res) {
  try {
    const body = req.body || {};
    const filters = body.filters && typeof body.filters === "object" ? body.filters : body;
    const from_date = filters.from_date || filters.fromDate || "";
    const to_date = filters.to_date || filters.toDate || "";
    const data = await listPlanningTableRows(null, { from_date, to_date });
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load planning table." });
  }
}

/** POST /plan/get — body { docno } — one prod_plan row + joins */
export async function getPlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });
    const row = await findPlanLine(docno);
    if (!row) return res.status(404).json({ success: false, message: "Plan line not found." });
    const { itemMap } = await getImsMapsSafe();
    const [data] = enrichPlanRows([row], itemMap);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load plan line." });
  }
}

/** POST /plan/update — body { docno, plan_start?, plan_end?, status?, maccode? } — prod_plan only */
export async function updatePlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findPlanLine(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Plan line not found." });

    const updated = await updatePlanLine(docno, {
      plan_start: req.body?.plan_start,
      plan_end: req.body?.plan_end,
      status: req.body?.status,
      maccode: req.body?.maccode,
    });
    return res.json({ success: true, message: "Plan line updated.", data: updated });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to update plan line." });
  }
}

/** POST /plan/delete — body { docno } — remove one prod_plan row */
export async function deletePlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const deleted = await deletePlanLine(docno);
    if (!deleted) return res.status(404).json({ success: false, message: "Plan line not found." });

    return res.json({
      success: true,
      message: `Plan line removed (${deleted.pjobcardno || docno}).`,
      data: { docno },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to delete plan line." });
  }
}
