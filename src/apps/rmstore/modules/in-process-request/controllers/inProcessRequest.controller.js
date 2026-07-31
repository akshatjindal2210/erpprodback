import { findInProcessRequests, findInProcessRequest, findInProcessReasons, insertInProcessRequest, updateInProcessRequest, softDeleteInProcessRequest, normalizeCoils, normalizeProposedCoils, normalizeRequestType, resolveDownstream, IPR_REQUEST_TYPE, IPR_DOWNSTREAM } from "../models/inProcessRequest.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import {
  findCoilByUid,
  revertCoilsConsumed,
  markCoilsInProcessRejectionPending,
  revertCoilsInProcessRejection,
  processStoreInReturnCoils,
  revertStoreInReturnCoils,
  processConsumeCoils,
} from "../../coil/models/coil.model.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";

const MODULE = "rm_issue_request";
const log = createRmstoreActivityLogger(MODULE);

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
        body.proposed_coils !== undefined
          ? body.proposed_coils
          : coils
              .filter((c) => (Number(c.remaining_qty ?? c.qty) || 0) > 0)
              .map((c, i) => ({
                temp_id: `ret-${String(c.coil_no_uid || i).toLowerCase()}`,
                coil_no_uid: c.coil_no_uid,
                from_coil_uid: c.coil_no_uid,
                qty: Number(c.remaining_qty ?? c.qty) || 0,
                item_code: c.item_code,
                item_desc: c.item_desc,
                heat_no: c.heat_no,
                mrn_uid: c.mrn_uid,
                mrn_no: c.mrn_no,
              }))
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
  if (fields.request_type === IPR_REQUEST_TYPE.STORE_IN) {
    for (const c of fields.coils) {
      const original = Number(c.original_qty ?? c.qty) || 0;
      const remaining = Number(c.remaining_qty ?? c.qty) || 0;
      if (remaining > original) {
        throw Object.assign(
          new Error(`Return qty for coil ${c.coil_no_uid} cannot exceed issued qty.`),
          { status: 400 }
        );
      }
    }
  }
  if (fields.request_type === IPR_REQUEST_TYPE.CONSUME) {
    for (const c of fields.coils) {
      const orig = Number(c.original_qty ?? c.qty) || 0;
      const used = Number(c.consumed_qty) || 0;
      if (used <= 0) {
        throw Object.assign(new Error("Used qty must be greater than 0 for each coil."), {
          status: 400,
        });
      }
      if (used > orig) {
        throw Object.assign(new Error(`Used qty for coil ${c.coil_no_uid} exceeds issued qty.`), {
          status: 400,
        });
      }
    }
  }
}

const isApprovedStoreInPending = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.STORE_IN &&
  row.approved === true &&
  row.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN;

const isApprovedStoreInDone = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.STORE_IN &&
  row.approved === true &&
  row.downstream === IPR_DOWNSTREAM.STORE_IN_DONE;

const isApprovedConsume = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.CONSUME &&
  row.approved === true;

const isApprovedRejectionPending = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.REJECTION &&
  row.approved === true &&
  row.downstream === IPR_DOWNSTREAM.PENDING_STORE_OUT;

const coilKeys = (coils = []) =>
  [...new Set(coils.map((c) => String(c?.coil_no_uid || "").trim().toLowerCase()).filter(Boolean))].sort();

const sameCoilSet = (a = [], b = []) => {
  const x = coilKeys(a);
  const y = coilKeys(b);
  return x.length === y.length && x.every((v, idx) => v === y[idx]);
};

function hasInProcessContentChanges(existing, fields) {
  if (!existing) return true;
  if (!sameCoilSet(existing.coils, fields.coils)) return true;
  if (!sameCoilSet(existing.proposed_coils, fields.proposed_coils)) return true;
  if (String(fields.reason || "") !== String(existing.reason || "")) return true;
  if (String(fields.remarks || "") !== String(existing.remarks || "")) return true;
  if (normalizeRequestType(fields.request_type) !== normalizeRequestType(existing.request_type)) {
    return true;
  }
  if (String(fields.rejection_type || "") !== String(existing.rejection_type || "")) return true;
  return false;
}

/**
 * Consume — coil must be out at shop floor (issued). Re-approve of same request allowed.
 */
async function assertCoilsConsumable(coils = [], iprUid = null) {
  for (const c of coils) {
    const coil = await findCoilByUid(c.coil_no_uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status === "out") continue;
    if (status === "consumed" && iprUid && Number(coil.ipr_uid) === Number(iprUid)) continue;
    throw Object.assign(
      new Error(
        `Coil ${c.coil_no_uid} is not on the shop floor (status: ${status}). Scan only issued-out coils.`
      ),
      { status: 400 }
    );
  }
}

async function assertCoilsForStoreInReturn(coils = [], iprUid = null) {
  for (const c of coils) {
    const coil = await findCoilByUid(c.coil_no_uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status === "out") continue;
    if (iprUid && status === "active") {
      throw Object.assign(
        new Error(`Coil ${c.coil_no_uid} is already back in stock.`),
        { status: 400 }
      );
    }
    if (iprUid && status === "consumed" && Number(coil.ipr_uid) === Number(iprUid)) continue;
    throw Object.assign(
      new Error(`Coil ${c.coil_no_uid} must be out at the machine (status: ${status}).`),
      { status: 400 }
    );
  }
}

async function assertCoilsRejectable(coils = [], iprUid = null) {
  for (const c of coils) {
    const coil = await findCoilByUid(c.coil_no_uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (status === "active") continue;
    if (
      status === "rejected" &&
      iprUid &&
      Number(coil.ipr_uid) === Number(iprUid) &&
      !coil.qc_reject_uid
    ) {
      continue;
    }
    throw Object.assign(
      new Error(`Coil ${c.coil_no_uid} cannot be rejected. Its current status is ${status}.`),
      { status: 400 }
    );
  }
}

/** Approving a consume request — full or partial used qty per coil. */
async function consumeCoils(row, user, req) {
  const source = row.previous_coils?.length ? row.previous_coils : row.coils;
  const { fullConsumed, partialConsumed } = await processConsumeCoils(
    row.ipr_uid,
    source,
    user
  );

  if (fullConsumed.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: fullConsumed,
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        coil_count: fullConsumed.length,
        full_consume: true,
      },
    });
  }

  if (partialConsumed.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: partialConsumed.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.consumed_qty,
        mrn_no: c.mrn_no,
      })),
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        partial: true,
        coil_count: partialConsumed.length,
        shop_floor_balance: partialConsumed.map((c) => ({
          coil_no_uid: c.coil_no_uid,
          remaining_qty: c.remaining_qty,
        })),
      },
    });
  }

  return fullConsumed.length + partialConsumed.length;
}

/** Un-approving or deleting a consume request puts coils back out at the machine when they were issued. */
async function releaseConsumedCoils(row, user, req) {
  const snapshot = row.previous_coils?.length ? row.previous_coils : row.coils;
  const fromOut = (snapshot || []).some((c) => c.out_uid != null);
  if (fromOut) {
    const { restored } = await revertStoreInReturnCoils(row.ipr_uid, snapshot, user);
    if (!restored.length) return 0;
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME_REVERT,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: restored,
      details: { ipr_uid: row.ipr_uid, coil_count: restored.length, restore_out: true },
    });
    return restored.length;
  }
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

/** Approving store-in — return remainder to stock and record consumed qty. */
async function applyStoreInReturn(row, user, req) {
  const source = row.previous_coils?.length ? row.previous_coils : row.coils;
  const { returned, consumed } = await processStoreInReturnCoils(row.ipr_uid, source, user);

  if (returned.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.STORE_OUT_REVERT,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: returned,
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        request_type: IPR_REQUEST_TYPE.STORE_IN,
        returned_count: returned.length,
        issued_snapshot: true,
      },
    });
  }

  const fullConsumed = consumed.filter((c) => !c.partial);
  if (fullConsumed.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: fullConsumed,
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        coil_count: fullConsumed.length,
        from_store_in: true,
      },
    });
  }

  const partialConsumed = consumed.filter((c) => c.partial);
  if (partialConsumed.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: partialConsumed.map((c) => ({ coil_no_uid: c.coil_no_uid, qty: c.consumed_qty, mrn_no: c.mrn_no })),
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        partial: true,
        coil_count: partialConsumed.length,
        from_store_in: true,
      },
    });
  }

  return { returned: returned.length, consumed: consumed.length };
}

async function releaseStoreInReturn(row, user, req) {
  const snapshot = row.previous_coils?.length ? row.previous_coils : row.coils;
  const { restored } = await revertStoreInReturnCoils(row.ipr_uid, snapshot, user);
  if (!restored.length) return 0;
  logCoilTransactionSafe({
    transaction_type: COIL_TX_TYPES.STORE_OUT,
    source_module: MODULE,
    source_id: String(row.ipr_uid),
    user_name: user,
    user_id: req.user?.id,
    rows: restored,
    details: {
      ipr_uid: row.ipr_uid,
      revert_store_in: true,
      coil_count: restored.length,
    },
  });
  return restored.length;
}

/** Approving an in-process rejection holds coils until RM Rejection → Store Out. */
async function holdCoilsForRejection(row, user, req) {
  const held = await markCoilsInProcessRejectionPending(
    row.ipr_uid,
    (row.coils || []).map((c) => c.coil_no_uid),
    user
  );
  if (!held.length) return 0;
  logCoilTransactionSafe({
    transaction_type: COIL_TX_TYPES.QC_REJECT,
    source_module: MODULE,
    source_id: String(row.ipr_uid),
    user_name: user,
    user_id: req.user?.id,
    rows: held,
    details: {
      ipr_uid: row.ipr_uid,
      reason: row.reason || null,
      rejection_type: row.rejection_type || null,
      coil_count: held.length,
      pending_store_out: true,
    },
  });
  return held.length;
}

/** Un-approve / delete / coil change before store-out — restore held coils. */
async function releaseRejectedCoils(row, user, req) {
  const restored = await revertCoilsInProcessRejection(row.ipr_uid, user);
  if (!restored.length) return 0;
  logCoilTransactionSafe({
    transaction_type: COIL_TX_TYPES.QC_REJECT_REVERT,
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

/** Receive an authorized store-in — update same coil qty, move to Unassigned Area (no new coil row). */
export const completeStoreInCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    }

    const existing = await findInProcessRequest(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "In-process request not found." });
    }
    if (!isApprovedStoreInPending(existing)) {
      return res.status(400).json({
        success: false,
        message: "Only an authorized Store In request in the pending queue can be received.",
      });
    }

    const user = auditUserName(req);
    try {
      await assertCoilsForStoreInReturn(existing.coils, id);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    await applyStoreInReturn(existing, user, req);
    await updateInProcessRequest(id, {
      downstream: IPR_DOWNSTREAM.STORE_IN_DONE,
      updated_by: user,
      updated_at: new Date(),
    });

    const data = await findInProcessRequest(id);
    log(req, "complete_store_in", String(id), {
      ipr_uid: id,
      coil_count: data?.coil_count ?? 0,
      downstream: data?.downstream ?? null,
    }, data);

    return res.json({
      success: true,
      data,
      message:
        "Store-in received. Same coil updated with return qty in Unassigned Area (Coil Area).",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    const isRejection = fields.request_type === IPR_REQUEST_TYPE.REJECTION;
    const isStoreIn = fields.request_type === IPR_REQUEST_TYPE.STORE_IN;

    if (incomingApproved === true) {
      if (isConsume) {
        try {
          await assertCoilsConsumable(fields.coils);
        } catch (e) {
          return res.status(e.status || 400).json({ success: false, message: e.message });
        }
      }
      if (isStoreIn) {
        try {
          await assertCoilsForStoreInReturn(fields.coils);
        } catch (e) {
          return res.status(e.status || 400).json({ success: false, message: e.message });
        }
      }
      if (isRejection) {
        try {
          await assertCoilsRejectable(fields.coils);
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
    } else if (isApprovedRejectionPending(data)) {
      await holdCoilsForRejection(data, user, req);
    }

    const messages = {
      [IPR_REQUEST_TYPE.STORE_IN]: isApprovedStoreInPending(data)
        ? "Store-in authorized and queued. Receive when ready — same coil updates to Unassigned Area with return qty."
        : "Store-in request saved as pending.",
      [IPR_REQUEST_TYPE.CONSUME]: isApprovedConsume(data)
        ? `Consume processed. ${data?.coil_count ?? 0} coil line(s); used qty recorded${
            Number(data?.balance_qty) > 0
              ? ` — ${Number(data.balance_qty).toLocaleString()} balance on shop floor for Store In`
              : ""
          }.`
        : "Consume request created successfully.",
      [IPR_REQUEST_TYPE.REJECTION]: isApprovedRejectionPending(data)
        ? "In-process rejection created and queued in RM Rejection Pending."
        : "In-process rejection created successfully.",
    };

    log(req, "create", String(row.ipr_uid), {
      ipr_uid: row.ipr_uid,
      request_type: fields.request_type,
      coil_count: data?.coil_count ?? fields.coils?.length ?? 0,
      coil_no_uids: (fields.coils || []).map((c) => c.coil_no_uid || c),
      approved: data?.approved === true,
      reason: fields.reason ?? null,
    }, data);

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
    const updateFields = { ...fields };
    if (hasInProcessContentChanges(existing, fields)) {
      updateFields.updated_by = user;
      updateFields.updated_at = new Date();
    }

    // Editing content re-opens approval; an explicit approve=true wins.
    const hasBusinessChanges = incomingApproved !== true;
    applyApprovalWorkflow({
      req, fields: updateFields, incomingApproved, hasBusinessChanges, auditAsName: true,
    });
    updateFields.downstream = resolveDownstream(
      fields.request_type,
      updateFields.approved === true
    );
    if (
      normalizeRequestType(fields.request_type) === IPR_REQUEST_TYPE.STORE_IN &&
      isApprovedStoreInDone(existing) &&
      updateFields.approved === true &&
      !hasInProcessContentChanges(existing, fields)
    ) {
      updateFields.downstream = IPR_DOWNSTREAM.STORE_IN_DONE;
    }

    // Consumption is applied on approval; store-in coil update runs on receive (complete).
    const wasConsumed = isApprovedConsume(existing);
    const willConsume =
      fields.request_type === IPR_REQUEST_TYPE.CONSUME && updateFields.approved === true;
    const wasStoreInPending = isApprovedStoreInPending(existing);
    const wasStoreInDone = isApprovedStoreInDone(existing);
    const willApproveStoreIn =
      fields.request_type === IPR_REQUEST_TYPE.STORE_IN && updateFields.approved === true;
    const wasRejectionPending = isApprovedRejectionPending(existing);
    const willRejectPending =
      fields.request_type === IPR_REQUEST_TYPE.REJECTION &&
      updateFields.approved === true &&
      updateFields.downstream === IPR_DOWNSTREAM.PENDING_STORE_OUT;
    const coilsChanged = !sameCoilSet(existing.coils, fields.coils);

    if (willConsume && (!wasConsumed || coilsChanged)) {
      try {
        await assertCoilsConsumable(fields.coils, wasConsumed ? id : null);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }
    if (willApproveStoreIn && !wasStoreInDone) {
      try {
        await assertCoilsForStoreInReturn(fields.coils, wasStoreInPending ? id : null);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }
    if (willRejectPending && (!wasRejectionPending || coilsChanged)) {
      try {
        await assertCoilsRejectable(fields.coils, wasRejectionPending ? id : null);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }

    await updateInProcessRequest(id, updateFields);

    if (wasConsumed && (!willConsume || coilsChanged)) {
      await releaseConsumedCoils(existing, user, req);
    }
    if (wasStoreInDone && (!willApproveStoreIn || coilsChanged)) {
      await releaseStoreInReturn(existing, user, req);
    }
    if (wasRejectionPending && (!willRejectPending || coilsChanged)) {
      await releaseRejectedCoils(existing, user, req);
    }

    let data = await findInProcessRequest(id);
    if (willConsume && (!wasConsumed || coilsChanged)) {
      await consumeCoils(data, user, req);
      data = await findInProcessRequest(id);
    }
    if (willRejectPending && (!wasRejectionPending || coilsChanged)) {
      await holdCoilsForRejection(data, user, req);
      data = await findInProcessRequest(id);
    }

    const approvedMessages = {
      [IPR_REQUEST_TYPE.STORE_IN]: isApprovedStoreInPending(data)
        ? "Store-in authorized and queued in Store In Pending."
        : isApprovedStoreInDone(data)
          ? "Store-in request updated."
          : "Store-in request saved.",
      [IPR_REQUEST_TYPE.CONSUME]: `Consume approved. ${data?.coil_count ?? 0} coil line(s) processed.`,
      [IPR_REQUEST_TYPE.REJECTION]: "In-process rejection approved and queued in RM Rejection Pending.",
    };

    log(req, data?.approved ? "approve" : "update", String(id), {
      ipr_uid: id,
      request_type: data?.request_type,
      coil_count: data?.coil_count ?? 0,
      coil_no_uids: (data?.coils || []).map((c) => c?.coil_no_uid).filter(Boolean),
      approved: data?.approved === true,
      downstream: data?.downstream ?? null,
    }, data);

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
    if (isApprovedStoreInDone(existing)) {
      await releaseStoreInReturn(existing, user, req);
    }
    if (isApprovedRejectionPending(existing)) {
      await releaseRejectedCoils(existing, user, req);
    }

    await softDeleteInProcessRequest(id, user);
    log(req, "delete", String(id), {
      ipr_uid: id,
      request_type: existing.request_type,
      coil_count: existing.coil_count ?? existing.coils?.length ?? 0,
      approved: existing.approved === true,
    }, existing);
    return res.json({ success: true, message: "In-process request deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
