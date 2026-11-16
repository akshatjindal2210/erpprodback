import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { assignBin, assignBinLocation, getBinManage, listBinManage, relieveBin, scanBin, softDeleteBinManage, transferBin, updateBinManage } from "../models/binManage.model.js";

const ENTITY = "production_bin_manage";

const send = (res, err) => res.status(err.statusCode || 500).json({ success: false, message: err.message || "Error" });

const log = (req, action, entity_id, details, record = null) =>
  logActivity(req, { action, entity: ENTITY, entity_id: String(entity_id), details, record }).catch(() => {});

export async function list(req, res) {
  try {
    const params = extractListParams(req.body || {});
    const filters = req.body?.filters || {};
    const data = await listBinManage({
      page: params.page,
      limit: params.limit,
      type: filters.type || req.body?.type || null,
      search: params.search || req.body?.search || null,
      from_date: filters.from_date || req.body?.from_date || null,
      to_date: filters.to_date || req.body?.to_date || null,
    });
    return res.json({ success: true, ...data });
  } catch (err) {
    return send(res, err);
  }
}

export async function scan(req, res) {
  try {
    const code = req.body?.code ?? req.body?.end_bin ?? req.body?.raw;
    const data = await scanBin(code);
    return res.json({ success: true, data });
  } catch (err) {
    return send(res, err);
  }
}

export async function assign(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await assignBin({ ...req.body, actor });
    log(req, "create", out.id, { type: "assign", end_bin: out.end_bin, pjobcardno: out.pjobcardno, qty: out.qty }, out);
    const setup = out?.data?.setup === true || req.body?.setup === true;
    return res.json({ success: true, data: out, toast_type: "success", message: setup ? "Bin set saved (qty later)." : "Bin assigned." });
  } catch (err) {
    return send(res, err);
  }
}

export async function transfer(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await transferBin({ ...req.body, actor });
    log(req, "create", out.id, { type: "transfer", start_bin: out.start_bin, end_bin: out.end_bin, qty: out.qty }, out);
    return res.json({ success: true, data: out, toast_type: "success", message: "Bin transferred." });
  } catch (err) {
    return send(res, err);
  }
}

export async function relieve(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await relieveBin({ ...req.body, actor });
    log(req, "create", out.id, { type: "relieve", end_bin: out.end_bin, qty: out.qty }, out);
    return res.json({ success: true, data: out, toast_type: "success", message: "Bin relieved." });
  } catch (err) {
    return send(res, err);
  }
}

export async function location(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await assignBinLocation({ ...req.body, actor });
    log(req, "create", out.id, { type: "location", end_bin: out.end_bin, lid: out.lid }, out);
    return res.json({ success: true, data: out, toast_type: "success", message: "Location assigned." });
  } catch (err) {
    return send(res, err);
  }
}

export async function get(req, res) {
  try {
    const data = await getBinManage(req.body?.id);
    return res.json({ success: true, data });
  } catch (err) {
    return send(res, err);
  }
}

export async function update(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await updateBinManage({ ...req.body, actor });
    log(req, "update", out.id, { type: out.type, end_bin: out.end_bin, pjobcardno: out.pjobcardno }, out);
    return res.json({ success: true, data: out, toast_type: "success", message: "Updated." });
  } catch (err) {
    return send(res, err);
  }
}

export async function remove(req, res) {
  try {
    const actor = auditUserName(req);
    const out = await softDeleteBinManage({ id: req.body?.id, actor });
    log(req, "delete", out.id, { id: out.id });
    return res.json({ success: true, data: out, toast_type: "success", message: "Register row deleted." });
  } catch (err) {
    return send(res, err);
  }
}
