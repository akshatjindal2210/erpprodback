import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { createEntry, deleteEntry, getEntry, listEntries, updateEntry } from "../models/entry.model.js";

function userOf(req) {
  return auditUserName(req) || req.user?.username || req.user?.name || "user";
}

export async function listProductionEntries(req, res) {
  try {
    const body = req.body || {};
    const data = await listEntries({
      from_date: body.from_date || body.fromDate,
      to_date: body.to_date || body.toDate,
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
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to get entry." });
  }
}

export async function createProductionEntry(req, res) {
  try {
    const data = await createEntry(req.body || {}, userOf(req));
    return res.json({ success: true, message: "Entry created.", data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to create entry." });
  }
}

export async function updateProductionEntry(req, res) {
  try {
    // Append-only log: "update" inserts a new row; prior row is left unchanged.
    const data = await updateEntry(req.body?.docno ?? req.body?.id, req.body || {}, userOf(req));
    if (!data) return res.status(404).json({ success: false, message: "Entry not found." });
    return res.json({ success: true, message: "Entry logged (append).", data });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Failed to update entry." });
  }
}

export async function deleteProductionEntry(req, res) {
  try {
    const data = await deleteEntry(req.body?.docno ?? req.body?.id, userOf(req));
    if (!data) return res.status(404).json({ success: false, message: "Entry not found." });
    return res.json({ success: true, message: "Entry deleted.", data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to delete entry." });
  }
}
