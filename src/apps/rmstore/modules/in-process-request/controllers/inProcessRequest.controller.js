import { findInProcessRequests, findInProcessRequest, findInProcessReasons, insertInProcessRequest, updateInProcessRequest, softDeleteInProcessRequest, normalizeCoils, normalizeProposedCoils, normalizeRequestType, resolveDownstream, IPR_REQUEST_TYPE, IPR_DOWNSTREAM } from "../models/inProcessRequest.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { findCoilByUid, markCoilsConsumed, revertCoilsConsumed } from "../../coil/models/coil.model.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";

const MODULE = "in_process_request";

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

const intOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalize an incoming payload into writable columns.
 * `prev` is the existing row on edit/approve so untouched fields keep their value.
 */
function buildRecordFields(body = {}, prev = null) {
  const request_type = normalizeRequestType(
    body.request_type !== undefined ? body.request_type : prev?.request_type
  );
  const isStoreIn = request_type === IPR_REQUEST_TYPE.STORE_IN;
  const isConsume = request_type === IPR_REQUEST_TYPE.CONSUME;

  const coils = normalizeCoils(body.coils !== undefined ? body.coils : prev?.coils);
  const previousInput =
    body.previous_coils !== undefined
      ? body.previous_coils
      : prev?.previous_coils?.length
        ? prev.previous_coils
        : coils;
  const previous_coils = normalizeCoils(previousInput);
  const proposed_coils = isStoreIn
    ? normalizeProposedCoils(
        body.proposed_coils !== undefined ? body.proposed_coils : prev?.proposed_coils
      )
    : [];

  const first = coils[0] || previous_coils[0] || {};
  const pick = (key, fallback = null) =>
    body[key] !== undefined ? body[key] : (prev?.[key] ?? fallback);

  let rejection_type = null;
  if (!isStoreIn && !isConsume) {
    const incoming = body.rejection_type !== undefined ? body.rejection_type : prev?.rejection_type;
    rejection_type = incoming === "lot" ? "lot" : "coil";
  }

  return {
    request_type,
    rejection_type,
    reason: trimOrNull(pick("reason")),
    remarks: trimOrNull(pick("remarks")),
    lot_no: trimOrNull(pick("lot_no", first.mrn_no)),
    mrn_uid: trimOrNull(pick("mrn_uid", first.mrn_uid)),
    mrn_no: intOrNull(pick("mrn_no", first.mrn_no)),
    heat_no: trimOrNull(pick("heat_no", first.heat_no)),
    item_code: trimOrNull(pick("item_code", first.item_code)),
    item_desc: trimOrNull(pick("item_desc", first.item_desc)),
    seed_coil_uid: trimOrNull(pick("seed_coil_uid")),
    coils,
    previous_coils,
    proposed_coils,
    scanned_coil_uids: coils.map((c) => c.coil_no_uid),
  };
}

function validate(fields) {
  if (!fields.reason) {
    throw Object.assign(new Error("Reason is required."), { status: 400 });
  }
  if (!fields.coils.length) {
    throw Object.assign(new Error("Add at least one coil."), { status: 400 });
  }
  const seen = new Set();
  for (const c of fields.coils) {
    const key = c.coil_no_uid.toLowerCase();
    if (seen.has(key)) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} has been added more than once.`), { status: 400 });
    }
    seen.add(key);
  }
  if (fields.request_type === IPR_REQUEST_TYPE.STORE_IN && !fields.proposed_coils.length) {
    throw Object.assign(new Error("Enter a return quantity for at least one coil."), { status: 400 });
  }
}

const isApprovedConsume = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.CONSUME &&
  row.approved === true;

const coilKeys = (coils = []) =>
  [...new Set(coils.map((c) => String(c?.coil_no_uid || "").trim().toLowerCase()).filter(Boolean))].sort();

const sameCoilSet = (a = [], b = []) => {
  const x = coilKeys(a);
  const y = coilKeys(b);
  return x.length === y.length && x.every((v, idx) => v === y[idx]);
};

/**
 * A coil can only be consumed while it is live stock. A coil already consumed by
 * this same request is allowed through so re-approving an unchanged request works.
 */
async function assertCoilsConsumable(coils = [], iprUid = null) {
  for (const c of coils) {
    const coil = await findCoilByUid(c.coil_no_uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status === "active") continue;
    if (status === "consumed" && iprUid && Number(coil.ipr_uid) === Number(iprUid)) continue;
    throw Object.assign(
      new Error(`Coil ${c.coil_no_uid} cannot be consumed. Its current status is ${status}.`),
      { status: 400 }
    );
  }
}

/** Approving a consume request takes its coils out of stock. */
async function consumeCoils(row, user, req) {
  const consumed = await markCoilsConsumed(
    row.ipr_uid,
    (row.coils || []).map((c) => c.coil_no_uid),
    user
  );
  if (!consumed.length) return 0;
  logCoilTransactionSafe({
    transaction_type: COIL_TX_TYPES.CONSUME,
    source_module: MODULE,
    source_id: String(row.ipr_uid),
    user_name: user,
    user_id: req.user?.id,
    rows: consumed,
    details: {
      ipr_uid: row.ipr_uid,
      reason: row.reason || null,
      coil_count: consumed.length,
    },
  });
  return consumed.length;
}

/** Un-approving or deleting a consume request puts its coils back in stock. */
async function releaseConsumedCoils(row, user, req) {
  const restored = await revertCoilsConsumed(row.ipr_uid, user);
  if (!restored.length) return 0;
  logCoilTransactionSafe({
    transaction_type: COIL_TX_TYPES.CONSUME_REVERT,
    source_module: MODULE,
    source_id: String(row.ipr_uid),
    user_name: user,
    user_id: req.user?.id,
    rows: restored,
    details: { ipr_uid: row.ipr_uid, coil_count: restored.length },
  });
  return restored.length;
}

export const getInProcessRequests = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "ipr_uid",
      order: "DESC",
    });
    const result = await findInProcessRequests({
      filters: sanitizeFilters(filters || {}, [
        "request_type",
        "approved",
        "downstream",
        "from_date",
        "to_date",
      ]),
      search: sanitizeSearch(search),
      page,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getInProcessRequestById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    const data = await findInProcessRequest(id);
    if (!data) return res.status(404).json({ success: false, message: "In-process request not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getInProcessReasons = async (req, res) => {
  try {
    const rows = await findInProcessReasons({
      search: sanitizeSearch(req.body?.search),
      request_type: req.body?.request_type,
    });
    return res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Approved requests still sitting in a downstream queue. */
async function getPendingQueue(res, requestType, downstream) {
  const result = await findInProcessRequests({
    filters: { request_type: requestType, approved: true, downstream },
    page: 1,
    limit: 1000,
  });
  return res.json({ success: true, data: result.data, total: result.total });
}

export const getPendingStoreIn = async (req, res) => {
  try {
    return await getPendingQueue(res, IPR_REQUEST_TYPE.STORE_IN, IPR_DOWNSTREAM.PENDING_STORE_IN);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getPendingStoreOut = async (req, res) => {
  try {
    return await getPendingQueue(res, IPR_REQUEST_TYPE.REJECTION, IPR_DOWNSTREAM.PENDING_STORE_OUT);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createInProcessRequest = async (req, res) => {
  try {
    const user = auditUserName(req);
    const fields = buildRecordFields(req.body);
    try {
      validate(fields);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const incomingApproved = normalizeApprovedInput(req.body?.approved);
    const record = { ...fields, created_by: user, downstream: IPR_DOWNSTREAM.NONE };
    const isConsume = fields.request_type === IPR_REQUEST_TYPE.CONSUME;

    if (incomingApproved === true) {
      if (isConsume) {
        try {
          await assertCoilsConsumable(fields.coils);
        } catch (e) {
          return res.status(e.status || 400).json({ success: false, message: e.message });
        }
      }
      applyApprovalWorkflow({
        req, fields: record, incomingApproved: true, hasBusinessChanges: false, auditAsName: true,
      });
      record.downstream = resolveDownstream(fields.request_type, true);
    }

    const row = await insertInProcessRequest(record);
    let data = await findInProcessRequest(row.ipr_uid);

    if (isApprovedConsume(data)) {
      await consumeCoils(data, user, req);
      data = await findInProcessRequest(row.ipr_uid);
    }

    const messages = {
      [IPR_REQUEST_TYPE.STORE_IN]: "Store-in request created successfully.",
      [IPR_REQUEST_TYPE.CONSUME]: isApprovedConsume(data)
        ? `Consume request created. ${data.coil_count} coil(s) marked as consumed.`
        : "Consume request created successfully.",
      [IPR_REQUEST_TYPE.REJECTION]: "In-process rejection created successfully.",
    };

    return res.status(201).json({
      success: true,
      data,
      message: messages[fields.request_type] || messages[IPR_REQUEST_TYPE.REJECTION],
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Shared handler for edit and approve. */
export const updateInProcessRequestCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });

    const existing = await findInProcessRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "In-process request not found." });

    const user = auditUserName(req);
    const fields = buildRecordFields(req.body, existing);
    try {
      validate(fields);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const incomingApproved = normalizeApprovedInput(req.body?.approved);
    const updateFields = { ...fields, updated_by: user, updated_at: new Date() };

    // Editing content re-opens approval; an explicit approve=true wins.
    const hasBusinessChanges = incomingApproved !== true;
    applyApprovalWorkflow({
      req, fields: updateFields, incomingApproved, hasBusinessChanges, auditAsName: true,
    });
    updateFields.downstream = resolveDownstream(
      fields.request_type,
      updateFields.approved === true
    );

    // Consumption is applied on approval, so reconcile the coils around this save.
    const wasConsumed = isApprovedConsume(existing);
    const willConsume =
      fields.request_type === IPR_REQUEST_TYPE.CONSUME && updateFields.approved === true;
    const coilsChanged = !sameCoilSet(existing.coils, fields.coils);

    if (willConsume && (!wasConsumed || coilsChanged)) {
      try {
        await assertCoilsConsumable(fields.coils, wasConsumed ? id : null);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }

    await updateInProcessRequest(id, updateFields);

    if (wasConsumed && (!willConsume || coilsChanged)) {
      await releaseConsumedCoils(existing, user, req);
    }

    let data = await findInProcessRequest(id);
    if (willConsume && (!wasConsumed || coilsChanged)) {
      await consumeCoils(data, user, req);
      data = await findInProcessRequest(id);
    }

    const approvedMessages = {
      [IPR_REQUEST_TYPE.STORE_IN]: "Store-in request approved and queued for Store In.",
      [IPR_REQUEST_TYPE.CONSUME]: `Consume request approved. ${data?.coil_count ?? 0} coil(s) marked as consumed.`,
      [IPR_REQUEST_TYPE.REJECTION]: "In-process rejection approved and queued for Store Out.",
    };

    return res.json({
      success: true,
      data,
      message: !data?.approved
        ? "Saved as pending."
        : approvedMessages[data.request_type] || approvedMessages[IPR_REQUEST_TYPE.REJECTION],
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteInProcessRequest = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    const existing = await findInProcessRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "In-process request not found." });

    const user = auditUserName(req);
    // Deleting an approved consume request puts its coils back in stock.
    if (isApprovedConsume(existing)) {
      await releaseConsumedCoils(existing, user, req);
    }

    await softDeleteInProcessRequest(id, user);
    return res.json({ success: true, message: "In-process request deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
