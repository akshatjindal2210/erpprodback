/**
 * Change Override Customer — create / update / approve request handlers.
 *
 * Approve path: validate boxes → set override_cust on ims_box_table → log transaction
 */

import { findBoxesByUids, updateBoxesByUids } from "../../models/box.model.js";
import { getOverrideRequestById, insertOverrideRequest, updateOverrideRequest as updateOverrideRequestRow } from "./overrideCustomerList.js";
import { isBoxEligibleForOverrideCustomer, overrideCustomerScanRejectMessage } from "./boxInventory.js";
import { logOverrideCustomerBatch } from "./logBoxTransaction.js";
import { logActivity } from "../../../core/utils/logActivity.js";
import { applyApprovalWorkflow, normalizeApprovedInput } from "../../../core/utils/approval.js";

export const OVERRIDE_ACTIVITY_ENTITY = "change_override_customer";

export function buildOverrideActivityDetails({
  requestRow,
  boxes,
  to_customer,
  from_customer,
  box_uids,
  approved,
  remarks,
}) {
  const uids = box_uids ?? requestRow?.box_uids ?? [];
  return {
    packing_number: requestRow?.packing_number ?? boxes?.[0]?.packing_number ?? null,
    from_customer:
      from_customer ??
      requestRow?.from_customer ??
      boxes?.[0]?.override_cust ??
      boxes?.[0]?.prod_acc_code ??
      null,
    to_customer: to_customer ?? requestRow?.to_customer ?? null,
    box_count: Array.isArray(uids) ? uids.length : 0,
    box_uids: uids,
    approved: approved ?? requestRow?.approved ?? null,
    remarks: remarks ?? requestRow?.remarks ?? null,
  };
}

async function validateOverrideBoxes(box_uids) {
  const boxes = await findBoxesByUids(box_uids);
  if (boxes.length !== box_uids.length) {
    return { error: { status: 404, message: "Boxes not found." } };
  }
  const blocked = boxes.find((b) => !isBoxEligibleForOverrideCustomer(b));
  if (blocked) {
    return {
      error: { status: 400, message: overrideCustomerScanRejectMessage(blocked) },
    };
  }
  return { boxes };
}

async function applyOverrideToBoxes({ box_uids, to_customer, userId, request_id, boxes, from_customer, remarks }) {
  await updateBoxesByUids(box_uids, {
    override_cust: to_customer,
    updated_by: userId,
  });
  logOverrideCustomerBatch({
    request_id,
    user_id: userId,
    boxes,
    from_customer,
    to_customer,
    remarks,
  });
}

export async function createOverrideCustomerRequest(req) {
  const { box_uids = [], to_customer, remarks, approved } = req.body;
  const normalizedApproved = normalizeApprovedInput(approved);

  if (!box_uids.length || !to_customer) {
    return { status: 400, body: { success: false, message: "Required fields missing." } };
  }

  const validation = await validateOverrideBoxes(box_uids);
  if (validation.error) {
    return { status: validation.error.status, body: { success: false, message: validation.error.message } };
  }
  const { boxes } = validation;

  const requestRow = await insertOverrideRequest({
    packing_number: boxes[0].packing_number,
    itemdcode: boxes[0].itemdcode,
    box_uids,
    from_customer: boxes[0]?.override_cust || boxes[0]?.prod_acc_code || null,
    to_customer,
    remarks,
    requested_by: req.user.id,
    approved: normalizedApproved === true,
  });

  if (normalizedApproved === true) {
    await applyOverrideToBoxes({
      box_uids,
      to_customer,
      userId: req.user.id,
      request_id: requestRow?.request_id,
      boxes,
      from_customer: boxes[0]?.override_cust ?? boxes[0]?.prod_acc_code ?? null,
      remarks,
    });
  }

  await logActivity(req, {
    action: normalizedApproved === true ? "approve" : "create",
    entity: OVERRIDE_ACTIVITY_ENTITY,
    entity_id: String(requestRow?.request_id),
    record: requestRow,
    details: buildOverrideActivityDetails({
      requestRow,
      boxes,
      to_customer,
      from_customer: boxes[0]?.override_cust ?? boxes[0]?.prod_acc_code ?? null,
      box_uids,
      approved: normalizedApproved === true,
      remarks,
    }),
  });

  return {
    status: 201,
    body: {
      success: true,
      data: requestRow,
      message:
        normalizedApproved === true
          ? "Request approved & boxes updated"
          : "Request submitted for approval",
    },
  };
}

export async function updateOverrideCustomerRequest(req) {
  const { request_id, box_uids, to_customer, remarks, approved } = req.body;
  const normalizedApproved = normalizeApprovedInput(approved);

  if (!request_id) {
    return { status: 400, body: { success: false, message: "request_id required" } };
  }

  const existingReq = await getOverrideRequestById(request_id);
  if (!existingReq) {
    return { status: 404, body: { success: false, message: "Request not found." } };
  }

  const hasBusinessChanges =
    (box_uids !== undefined && JSON.stringify(box_uids) !== JSON.stringify(existingReq.box_uids)) ||
    (to_customer !== undefined && to_customer !== existingReq.to_customer) ||
    (remarks !== undefined && remarks !== existingReq.remarks);

  const fields = {
    ...(box_uids !== undefined && { box_uids }),
    ...(to_customer !== undefined && { to_customer }),
    ...(remarks !== undefined && { remarks }),
    updated_by: req.user.id,
    updated_at: new Date(),
  };

  const existingStatus = existingReq.status || (existingReq.approved ? "approved" : "pending");
  if (existingStatus === "approved" && normalizedApproved === false && !hasBusinessChanges) {
    return {
      status: 400,
      body: {
        success: false,
        message: "This request is already approved. Use Edit to change it (will reset to pending).",
      },
    };
  }

  applyApprovalWorkflow({ req, fields, incomingApproved: normalizedApproved, hasBusinessChanges });

  if (normalizedApproved === true) {
    fields.status = "approved";
  } else if (normalizedApproved === false || hasBusinessChanges) {
    fields.status = "pending";
  }

  const uidsToValidate =
    box_uids !== undefined
      ? box_uids
      : fields.approved === true
        ? fields.box_uids || existingReq.box_uids
        : null;

  if (Array.isArray(uidsToValidate) && uidsToValidate.length) {
    const validation = await validateOverrideBoxes(uidsToValidate);
    if (validation.error) {
      return { status: validation.error.status, body: { success: false, message: validation.error.message } };
    }
  }

  const updatedRow = await updateOverrideRequestRow(request_id, fields);

  if (fields.approved === true) {
    const applyUids = fields.box_uids || existingReq.box_uids;
    const applyBoxes = await findBoxesByUids(applyUids || []);
    await applyOverrideToBoxes({
      box_uids: applyUids,
      to_customer: fields.to_customer || existingReq.to_customer,
      userId: fields.updated_by,
      request_id,
      boxes: applyBoxes,
      from_customer:
        existingReq.from_customer ??
        applyBoxes[0]?.override_cust ??
        applyBoxes[0]?.prod_acc_code,
      remarks: fields.remarks ?? existingReq.remarks,
    });
  }

  const logUids = fields.box_uids || existingReq.box_uids || [];
  await logActivity(req, {
    action: fields.approved === true ? "approve" : "update",
    entity: OVERRIDE_ACTIVITY_ENTITY,
    entity_id: String(request_id),
    record: updatedRow,
    details: buildOverrideActivityDetails({
      requestRow: updatedRow || existingReq,
      to_customer: fields.to_customer ?? existingReq.to_customer,
      from_customer: existingReq.from_customer,
      box_uids: logUids,
      approved: fields.approved === true,
      remarks: fields.remarks ?? existingReq.remarks,
    }),
  });

  const msg = fields.approved
    ? "Approved & customer updated on boxes"
    : fields.status === "pending"
      ? "Request saved as pending"
      : "Request updated";

  return { status: 200, body: { success: true, data: updatedRow, message: msg } };
}

export async function approveOverrideCustomerRequest(req) {
  const { request_id, approve = true } = req.body;

  if (!request_id) {
    return { status: 400, body: { success: false, message: "request_id required" } };
  }

  const requestRow = await getOverrideRequestById(request_id);
  if (!requestRow) {
    return { status: 404, body: { success: false, message: "Request not found." } };
  }

  const rowStatus = requestRow.status || (requestRow.approved ? "approved" : "pending");
  if (rowStatus === "approved") {
    return { status: 400, body: { success: false, message: "Request already approved" } };
  }

  if (approve) {
    const uids = requestRow.box_uids || [];
    const validation = await validateOverrideBoxes(uids);
    if (validation.error) {
      return { status: validation.error.status, body: { success: false, message: validation.error.message } };
    }
    const { boxes: liveBoxes } = validation;

    await applyOverrideToBoxes({
      box_uids: uids,
      to_customer: requestRow.to_customer,
      userId: req.user.id,
      request_id,
      boxes: liveBoxes,
      from_customer:
        requestRow.from_customer ??
        liveBoxes[0]?.override_cust ??
        liveBoxes[0]?.prod_acc_code,
      remarks: requestRow.remarks,
    });
  }

  const updatedReq = await updateOverrideRequestRow(request_id, {
    status: approve ? "approved" : "rejected",
    approved: approve,
    approved_by: req.user.id,
    approved_at: new Date(),
  });

  await logActivity(req, {
    action: approve ? "approve" : "reject",
    entity: OVERRIDE_ACTIVITY_ENTITY,
    entity_id: String(request_id),
    record: updatedReq || requestRow,
    details: buildOverrideActivityDetails({
      requestRow: updatedReq || requestRow,
      to_customer: requestRow.to_customer,
      from_customer: requestRow.from_customer,
      box_uids: requestRow.box_uids,
      approved: approve,
      remarks: requestRow.remarks,
    }),
  });

  return {
    status: 200,
    body: {
      success: true,
      data: updatedReq,
      message: approve ? "Override approved" : "Override rejected",
    },
  };
}
