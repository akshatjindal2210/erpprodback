import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createEntry, deleteEntry, getEntry, isDocdtWithinDays, listEntries, updateEntry } from "../models/entry.model.js";

function userOf(req) {
  return auditUserName(req) || req.user?.username || req.user?.name || "user";
}

function isSuperAdmin(req) {
  const t = String(req.user?.type || req.user?.role || "").toLowerCase();
  return t === "super_admin";
}

function permOf(req) {
  if (isSuperAdmin(req)) return null;
  return req.permission || null;
}

function daysDenied(kind, days) {
  const err = new Error(
    kind === "view"
      ? `View limit exceeded. You can only see entries from the last ${days} day(s).`
      : kind === "add"
        ? `Date outside allowed range. You can only add entries for the last ${days} day(s).`
        : `Edit limit exceeded. You can only change entries from the last ${days} day(s).`
  );
  err.status = 403;
  return err;
}

function assertViewDocdt(req, docdt) {
  const p = permOf(req);
  const days = Number(p?.can_view_days) || 0;
  if (days > 0 && !isDocdtWithinDays(docdt, days)) throw daysDenied("view", days);
}

function assertAddDocdt(req, docdt) {
  const p = permOf(req);
  const days = Number(p?.can_view_days) || 0;
  if (days > 0 && !isDocdtWithinDays(docdt, days)) throw daysDenied("add", days);
}

function assertEditDocdt(req, docdt) {
  const p = permOf(req);
  const days = Number(p?.can_edit_days) || 0;
  if (days > 0 && !isDocdtWithinDays(docdt, days)) throw daysDenied("edit", days);
}

/** Job-card plan lines (machine + process) for Entry autofill. */
export async function getProductionEntryJcPlan(req, res) {
  try {
    const jc = String(req.body?.jc || req.body?.pjobcardno || "").trim();
    if (!jc) return res.status(400).json({ success: false, message: "jc required." });
    const data = await dbQuery(
      `SELECT proccode, maccode, stage_no
       FROM ${T.PLAN}
       WHERE pjobcardno = $1
       ORDER BY stage_no NULLS LAST, proccode, maccode`,
      [jc]
    );
    return res.json({ success: true, data: data || [], total: (data || []).length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load job card plan." });
  }
}

/** Approved JCs linked to a machine via prod_plan. */
export async function listProductionEntryJcsByMachine(req, res) {
  try {
    const mac = Number(req.body?.maccode ?? req.body?.machine);
    if (!(mac > 0)) return res.status(400).json({ success: false, message: "maccode required." });
    const data = await dbQuery(
      `SELECT DISTINCT p.pjobcardno
       FROM ${T.PLAN} p
       INNER JOIN ${T.JC} j ON j.pjobcardno = p.pjobcardno
         AND j.approved = true AND COALESCE(j.is_deleted, false) = false
       WHERE p.maccode = $1::int
         AND NULLIF(TRIM(p.pjobcardno), '') IS NOT NULL
       ORDER BY p.pjobcardno`,
      [mac]
    );
    return res.json({ success: true, data: data || [], total: (data || []).length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load job cards for machine." });
  }
}

export async function listProductionEntries(req, res) {
  try {
    const body = req.body || {};
    const data = await listEntries({
      from_date: body.from_date || body.fromDate,
      to_date: body.to_date || body.toDate,
      permission: permOf(req),
    });
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to list entries." });
  }
}

export async function getProductionEntry(req, res) {
  try {
    const data = await getEntry(req.body?.docno ?? req.body?.id);
    if (!data) return res.status(404).json({ success: false, message: "Entry not found." });
    assertViewDocdt(req, data.docdt);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to get entry." });
  }
}

export async function createProductionEntry(req, res) {
  try {
    const body = req.body || {};
    assertAddDocdt(req, body.docdt);
    const data = await createEntry(body, userOf(req));
    return res.json({ success: true, message: "Entry created.", data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to create entry." });
  }
}

export async function updateProductionEntry(req, res) {
  try {
    const id = req.body?.docno ?? req.body?.id;
    const existing = await getEntry(id);
    if (!existing) return res.status(404).json({ success: false, message: "Entry not found." });
    assertEditDocdt(req, existing.docdt);
    if (req.body?.docdt != null) assertAddDocdt(req, req.body.docdt);
    const data = await updateEntry(id, req.body || {}, userOf(req));
    if (!data) return res.status(404).json({ success: false, message: "Entry not found." });
    return res.json({ success: true, message: "Entry updated.", data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to update entry." });
  }
}

export async function deleteProductionEntry(req, res) {
  try {
    const id = req.body?.docno ?? req.body?.id;
    const existing = await getEntry(id);
    if (!existing) return res.status(404).json({ success: false, message: "Entry not found." });
    assertEditDocdt(req, existing.docdt);
    const data = await deleteEntry(id, userOf(req));
    if (!data) return res.status(404).json({ success: false, message: "Entry not found." });
    return res.json({ success: true, message: "Entry deleted.", data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to delete entry." });
  }
}
