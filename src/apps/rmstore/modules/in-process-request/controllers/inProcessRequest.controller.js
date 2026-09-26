import { findInProcessRequests, findInProcessRequest, findInProcessReasons, insertInProcessRequest, updateInProcessRequest, softDeleteInProcessRequest, findPendingAutoStoreInForConsume, findPendingStoreInForCoil, AUTO_STORE_IN_FROM_CONSUME_PREFIX, autoConsumeFromStoreInRemarks, parseConsumeIprUidFromAutoStoreInRemarks, normalizeCoils, normalizeProposedCoils, normalizeRequestType, resolveDownstream, resolveConsumeDownstream, hasReassignShopFloorBalance, IPR_REQUEST_TYPE, IPR_DOWNSTREAM } from "../models/inProcessRequest.model.js";
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";
import { stampRmstoreUploadedFiles } from "../../../lib/utils/stampRmstoreUploadedFiles.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { findCoils, findCoilByUid, revertCoilsConsumed, markCoilsInProcessRejectionPending, revertCoilsInProcessRejection, restoreCoilsToShopFloorOut, releaseCoilFromIprRejectionHoldForStoreIn, processStoreInReturnCoils, revertStoreInReturnCoils, processConsumeCoils } from "../../coil/models/coil.model.js";
import { findQcCheck, findQcCheckItems, findQcChecks } from "../../qc-check/models/qcCheck.model.js";
import { formatExpected } from "../../../lib/utils/qc/evaluateSpec.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { hasInProcessRejectionPermission, hasIssueRmMappedPermission, isSuperAdminUser } from "../../../lib/utils/rmstoreSpecialPermissions.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { isCoilEligibleForIprRejection, iprRejectionIneligibleMessage } from "../../../lib/utils/iprRejectionEligibility.js";
import { isIssuedToShopFloor, isSaMinusWriteOff } from "../../../lib/utils/saMinusInventory.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";
import { enrichIprWithMachineLabels } from "../../inventory-inward/utils/enrichIprMachineLabels.js";
import { loadMappedPrdRunJc } from "../../production/utils/erpItems.js";
import { findProductions } from "../../production/models/productionMaster.model.js";
import { normalizeRmItems } from "../../production/utils/productionRmHelpers.js";

const MODULE = "rm_in_process_request";
const log = createRmstoreActivityLogger(MODULE);

async function attachQcChecksToIprRejection(data) {
  if (!data || normalizeRequestType(data.request_type) !== IPR_REQUEST_TYPE.REJECTION) {
    return data;
  }

  const coilUids = [
    ...new Set(
      (Array.isArray(data.coils) ? data.coils : [])
        .map((c) => String(c?.coil_no_uid || "").trim())
        .filter(Boolean)
    ),
  ];
  if (!coilUids.length && data.seed_coil_uid) {
    coilUids.push(String(data.seed_coil_uid).trim());
  }

  const qcMap = new Map();

  const addQcCheck = async (qcCheckUid) => {
    const id = Number(qcCheckUid);
    if (!Number.isFinite(id) || id <= 0 || qcMap.has(id)) return;
    const row = await findQcCheck(id);
    if (!row) return;
    const items = await findQcCheckItems(id);
    qcMap.set(id, {
      ...row,
      items: (items || []).map((it) => ({
        ...it,
        expected_display: it.expected_display || formatExpected(it),
      })),
    });
  };

  for (const uid of coilUids) {
    const coil = await findCoilByUid(uid);
    if (coil?.qc_uid != null) {
      await addQcCheck(coil.qc_uid);
    }
    const history = await findQcChecks({
      filters: { coil_no_uid: uid },
      page: 1,
      limit: 20,
    });
    for (const row of history?.data || []) {
      await addQcCheck(row?.qc_check_uid);
    }
  }

  const qc_checks = [...qcMap.values()].sort(
    (a, b) => Number(b.qc_check_uid) - Number(a.qc_check_uid)
  );
  const qc_check =
    qc_checks.find((c) => String(c.status || "").toLowerCase() === "failed" && c.approved === true) ||
    qc_checks.find((c) => String(c.status || "").toLowerCase() === "failed") ||
    qc_checks[0] ||
    null;

  return { ...data, qc_check, qc_checks };
}

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
  const isTransfer = request_type === IPR_REQUEST_TYPE.TRANSFER;

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
  if (!isStoreIn && !isConsume && !isTransfer) {
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
    attachments: body.attachments !== undefined ? body.attachments : (prev?.attachments ?? []),
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
      if (used < 0) {
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
  if (fields.request_type === IPR_REQUEST_TYPE.TRANSFER) {
    // Placeholder for future transfer validation
  }
  if (fields.request_type === IPR_REQUEST_TYPE.REJECTION) {
    assertRejectionPhotos(fields);
  }
}

function toUpperTrim(value) {
  return String(value || "").trim().toUpperCase();
}

async function resolveApprovedProductionForItem({ itemdcode, item_code } = {}) {
  const dcode = Number(itemdcode);
  if (Number.isFinite(dcode) && dcode > 0) {
    const approved = await findProductions({
      filters: { item_dcode: dcode, approved: true },
      page: 1,
      limit: 1,
    });
    if (approved?.data?.[0]) return approved.data[0];
  }
  const code = String(item_code || "").trim();
  if (code) {
    const approved = await findProductions({
      filters: { approved: true },
      search: code,
      page: 1,
      limit: 50,
    });
    const hit = (approved?.data || []).find(
      (r) => toUpperTrim(r?.item_code) === toUpperTrim(code)
    );
    if (hit) return hit;
  }
  return null;
}

async function assertConsumeReassignRules(fields, user) {

  if (normalizeRequestType(fields.request_type) !== IPR_REQUEST_TYPE.CONSUME) return;
  const reassignLines = normalizeCoils(fields.coils).filter((c) => c.reassign === true);
  if (!reassignLines.length) return;

  const jcRows = await loadMappedPrdRunJc();
  const jcByNo = new Map(
    (jcRows || []).map((row) => [toUpperTrim(row?.pjobcardno), row])
  );
  const machineRowsCache = new Map();

  for (const line of reassignLines) {
    const coilUid = String(line.coil_no_uid || "").trim();
    const targetJc = String(line.pjobcardno || "").trim();
    const targetMachine = String(line.macname || "").trim();
    const targetWire = String(line.reassign_rm_item_code || line.item_code || "").trim();

    if (!targetJc || !targetMachine) {
      throw Object.assign(
        new Error(`Reassign requires both job card and machine for coil ${coilUid}.`),
        { status: 400 }
      );
    }
    if (!targetWire) {
      throw Object.assign(
        new Error(`Coil ${coilUid} is missing wire item code for reassign validation.`),
        { status: 400 }
      );
    }

    const jc = jcByNo.get(toUpperTrim(targetJc));
    if (!jc) {
      throw Object.assign(
        new Error(`Job card ${targetJc} was not found in production running list.`),
        { status: 400 }
      );
    }
    const jcMachine = String(jc.macname || "").trim();
    if (jcMachine && toUpperTrim(jcMachine) !== toUpperTrim(targetMachine)) {
      throw Object.assign(
        new Error(
          `Job card ${targetJc} is mapped to machine ${jcMachine}. Reassign machine must match the job card machine.`
        ),
        { status: 400 }
      );
    }

    const prod = await resolveApprovedProductionForItem({
      itemdcode: jc.itemdcode,
      item_code: jc.item_code,
    });
    if (!prod) {
      throw Object.assign(
        new Error(`No approved production mapping found for job card ${targetJc}.`),
        { status: 400 }
      );
    }
    const mappedCodes = normalizeRmItems(prod)
      .map((r) => String(r?.rm_item_code || "").trim())
      .filter(Boolean);
    if (!mappedCodes.length) {
      throw Object.assign(
        new Error(`Job card ${targetJc} has no mapped RM wire in production master.`),
        { status: 400 }
      );
    }

    const targetWireKey = toUpperTrim(targetWire);
    const mappedCodeKeys = mappedCodes.map((c) => toUpperTrim(c));
    const firstMappedKey = mappedCodeKeys[0] || "";
    const isSuperAdmin = isSuperAdminUser(user);
    const canPickMapped = hasIssueRmMappedPermission(user);

    if (isSuperAdmin || canPickMapped) {
      if (!mappedCodeKeys.includes(targetWireKey)) {
        throw Object.assign(
          new Error(
            `Coil ${coilUid} wire ${targetWire} is not mapped on job card ${targetJc}.`
          ),
          { status: 400 }
        );
      }
    } else if (firstMappedKey && targetWireKey !== firstMappedKey) {
      throw Object.assign(
        new Error(
          `Normal users can reassign only mapped priority-1 wire (${mappedCodes[0]}) for job card ${targetJc}.`
        ),
        { status: 400 }
      );
    }

    const machineKey = toUpperTrim(targetMachine);
    if (!machineRowsCache.has(machineKey)) {
      const result = await findCoils({
        filters: { shop_floor: true, macname: targetMachine },
        page: 1,
        limit: 2000,
      });
      machineRowsCache.set(machineKey, Array.isArray(result?.data) ? result.data : []);
    }

    const machineRows = machineRowsCache.get(machineKey) || [];
    const conflict = machineRows.find((row) => {
      const rowUid = String(row?.coil_no_uid || "").trim().toLowerCase();
      if (rowUid && rowUid === String(coilUid || "").trim().toLowerCase()) return false;
      const rowWire = toUpperTrim(row?.item_code);
      return Boolean(rowWire && rowWire !== targetWireKey);
    });

    if (conflict) {
      const conflictWire = String(conflict?.item_code || "unknown");
      const conflictJc = String(conflict?.pjobcardno || "unknown");
      throw Object.assign(
        new Error(
          `Machine ${targetMachine} already has another wire on shop floor (${conflictWire} · ${conflictJc}). Reassign allowed only when the machine has no other wire running.`
        ),
        { status: 400 }
      );
    }
  }
}

const IMAGE_ATTACHMENT_RE = /\.(jpe?g|png|webp|gif)$/i;

function isImageAttachment(entry) {
  if (entry == null) return false;
  if (typeof entry === "string") return IMAGE_ATTACHMENT_RE.test(entry);
  if (typeof entry === "object") {
    const name = String(entry.name || entry.filename || entry.path || "").trim();
    const type = String(entry.type || entry.mimetype || "").trim().toLowerCase();
    if (type.startsWith("image/")) return true;
    return IMAGE_ATTACHMENT_RE.test(name);
  }
  return false;
}

function assertRejectionPhotos(fields) {
  const attachments = Array.isArray(fields.attachments) ? fields.attachments : [];
  const images = attachments.filter(isImageAttachment);
  if (!images.length) {
    throw Object.assign(
      new Error("At least one photo (JPEG, PNG, or WebP) is required for in-process rejection. PDFs are not allowed."),
      { status: 400 }
    );
  }
  if (attachments.some((a) => !isImageAttachment(a))) {
    throw Object.assign(
      new Error("Rejection attachments must be photos only (JPEG, PNG, or WebP). PDFs are not allowed."),
      { status: 400 }
    );
  }
}

const isApprovedStoreInPending = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.STORE_IN &&
  row.approved === true &&
  row.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN;

const isConsumeBalancePending = (row) =>
  Boolean(row) &&
  normalizeRequestType(row.request_type) === IPR_REQUEST_TYPE.CONSUME &&
  row.approved === true &&
  row.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN;

/** Manual store-in or consume balance on the same row — eligible for Store In receive. */
const isPendingStoreInReceivable = (row) =>
  isApprovedStoreInPending(row) || isConsumeBalancePending(row);

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

const IPR_BUSINESS_KEYS = [
  "request_type", "rejection_type", "reason", "remarks",
  "lot_no", "mrn_uid", "mrn_no", "heat_no", "item_code", "item_desc",
  "seed_coil_uid", "coils", "previous_coils", "proposed_coils",
  "scanned_coil_uids", "attachments",
];

function pickIprBusinessFields(fields = {}) {
  const out = {};
  for (const key of IPR_BUSINESS_KEYS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

const proposedCoilKeys = (coils = []) =>
  normalizeProposedCoils(coils)
    .map(
      (c) =>
        `${String(c.coil_no_uid).toLowerCase()}|${Number(c.qty)}|${String(c.from_coil_uid || c.coil_no_uid).toLowerCase()}`
    )
    .sort();

const sameProposedCoilSet = (a = [], b = []) => {
  const x = proposedCoilKeys(a);
  const y = proposedCoilKeys(b);
  return x.length === y.length && x.every((v, idx) => v === y[idx]);
};

const sameAttachments = (a = [], b = []) => JSON.stringify(a || []) === JSON.stringify(b || []);

function hasConsumeQtyChanges(existing, fields) {
  if (normalizeRequestType(fields.request_type) !== IPR_REQUEST_TYPE.CONSUME) return false;
  const prev = new Map(
    normalizeCoils(existing?.coils).map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );
  for (const c of normalizeCoils(fields.coils)) {
    const key = String(c.coil_no_uid).toLowerCase();
    const prior = prev.get(key);
    if (!prior) continue;
    if (Number(c.consumed_qty) !== Number(prior.consumed_qty)) return true;
    if (Number(c.remaining_qty) !== Number(prior.remaining_qty)) return true;
  }
  return false;
}

function hasInProcessContentChanges(existing, fields) {
  if (!existing) return true;
  if (!sameCoilSet(existing.coils, fields.coils)) return true;
  if (hasConsumeQtyChanges(existing, fields)) return true;
  if (
    normalizeRequestType(fields.request_type) === IPR_REQUEST_TYPE.STORE_IN &&
    !sameProposedCoilSet(existing.proposed_coils, fields.proposed_coils)
  ) {
    return true;
  }
  if (String(fields.reason || "") !== String(existing.reason || "")) return true;
  if (String(fields.remarks || "") !== String(existing.remarks || "")) return true;
  if (normalizeRequestType(fields.request_type) !== normalizeRequestType(existing.request_type)) {
    return true;
  }
  if (String(fields.rejection_type || "") !== String(existing.rejection_type || "")) return true;
  if (!sameAttachments(existing.attachments, fields.attachments)) return true;
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
    if (isIssuedToShopFloor(coil)) continue;
    if (status === "consumed" && iprUid && Number(coil.ipr_uid) === Number(iprUid)) continue;
    throw Object.assign(
      new Error(
        isSaMinusWriteOff(coil)
          ? `Coil ${c.coil_no_uid} was removed by stock adjustment and is not on the shop floor.`
          : `Coil ${c.coil_no_uid} is not on the shop floor (status: ${status}). Scan only issued-out coils.`
      ),
      { status: 400 }
    );
  }
}

async function assertCoilsForStoreInReturn(coils = [], iprUid = null) {
  for (const c of coils) {
    const uid = String(c.coil_no_uid || "").trim();
    const pending = await findPendingStoreInForCoil(uid);
    if (pending?.ipr_uid && (!iprUid || Number(pending.ipr_uid) !== Number(iprUid))) {
      throw Object.assign(
        new Error(
          `Coil ${uid} is already queued in Store In Pending (IPR #${pending.ipr_uid}). Receive that entry first — partial consume balance is queued automatically.`
        ),
        { status: 400 }
      );
    }

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
    }
    const status = String(coil.status || "active").toLowerCase();
    if (isIssuedToShopFloor(coil)) continue;
    if (iprUid && status === "active") {
      throw Object.assign(
        new Error(`Coil ${c.coil_no_uid} is already back in stock.`),
        { status: 400 }
      );
    }
    if (iprUid && status === "consumed" && Number(coil.ipr_uid) === Number(iprUid)) continue;
    if (status === "rejected" && coil.ipr_uid != null) {
      throw Object.assign(
        new Error(
          `Coil ${c.coil_no_uid} is held for in-process rejection IPR #${coil.ipr_uid}. Unapprove that rejection before receiving Store In${iprUid ? ` IPR #${iprUid}` : ""}.`
        ),
        { status: 400 }
      );
    }
    throw Object.assign(
      new Error(`Coil ${c.coil_no_uid} must be out at the machine (status: ${status}).`),
      { status: 400 }
    );
  }
}

/** Store In receive — clear rejection hold when the same coil is already queued on this store-in. */
async function reconcileCoilsForStoreInReceive(coils = [], storeInIprUid, user, req) {
  const id = Number(storeInIprUid);
  if (!Number.isFinite(id) || id <= 0) return [];

  const released = [];
  for (const c of coils) {
    const uid = String(c?.coil_no_uid || "").trim();
    if (!uid) continue;

    const pending = await findPendingStoreInForCoil(uid);
    if (!pending?.ipr_uid || Number(pending.ipr_uid) !== id) continue;

    const coil = await findCoilByUid(uid);
    const status = String(coil?.status || "active").toLowerCase();
    if (status !== "rejected" || coil?.ipr_uid == null) continue;

    const restored = await releaseCoilFromIprRejectionHoldForStoreIn(uid, user);
    if (!restored) continue;

    released.push(restored);
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.QC_REJECT_REVERT,
      source_module: MODULE,
      source_id: String(restored.released_from_ipr_uid ?? coil.ipr_uid ?? ""),
      user_name: user,
      user_id: req.user?.id,
      rows: [restored],
      details: {
        coil_no_uid: uid,
        released_from_ipr_uid: restored.released_from_ipr_uid ?? coil.ipr_uid ?? null,
        store_in_ipr_uid: id,
        reason: "store_in_receive_priority",
      },
    });
  }
  return released;
}

// async function assertCoilsRejectable(coils = [], iprUid = null) {
//   for (const c of coils) {
//     const coil = await findCoilByUid(c.coil_no_uid);
//     if (!coil) {
//       throw Object.assign(new Error(`Coil ${c.coil_no_uid} was not found.`), { status: 400 });
//     }
//     if (!isCoilEligibleForIprRejection(coil, { editIprUid: iprUid })) {
//       throw Object.assign(new Error(iprRejectionIneligibleMessage(coil)), { status: 400 });
//     }
//   }
// }

async function assertCoilsRejectable(coils = [], iprUid = null) {
  for (const c of coils) {
    const uid = String(c.coil_no_uid || "").trim();
    const pendingStoreIn = await findPendingStoreInForCoil(uid);
    if (pendingStoreIn?.ipr_uid) {
      throw Object.assign(
        new Error(
          `Coil ${uid} is queued in Store In Pending (IPR #${pendingStoreIn.ipr_uid}). Receive or cancel that store-in before rejecting this coil.`
        ),
        { status: 400 }
      );
    }

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${uid} was not found.`),{ status: 400 });
    }

    // Already held by this exact IPR — valid re-approval.
    if (iprUid && coil.ipr_uid != null && Number(coil.ipr_uid) === Number(iprUid)) {
      continue;
    }

    if (!isCoilEligibleForIprRejection(coil, { editIprUid: iprUid })) {
      throw Object.assign(new Error(iprRejectionIneligibleMessage(coil)), { status: 400 });
    }
  }
}

/** Approving a consume request — full or partial used qty per coil. */
async function consumeCoils(row, user, req) {
  const previous = row.previous_coils?.length ? row.previous_coils : row.coils;
  const previousByUid = new Map(
    normalizeCoils(previous).map((p) => [String(p.coil_no_uid || "").trim().toLowerCase(), p])
  );
  const currentByUid = new Map(
    normalizeCoils(row.coils).map((c) => [String(c.coil_no_uid || "").trim().toLowerCase(), c])
  );
  const source = normalizeCoils(previous).map((p) => {
    const hit = currentByUid.get(String(p.coil_no_uid || "").trim().toLowerCase());
    if (!hit) return p;
    return {
      ...p,
      ...hit,
      original_qty: p.original_qty ?? p.qty ?? hit.original_qty,
      pjobcardno: hit.pjobcardno ?? p.pjobcardno,
      macname: hit.macname ?? p.macname,
      reassign: hit.reassign === true,
      reassign_rm_item_code: hit.reassign_rm_item_code ?? p.reassign_rm_item_code,
    };
  });
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

  const reassignPartial = partialConsumed.filter((c) => c.reassign === true);
  const leftoverPartial = partialConsumed.filter((c) => !c.reassign);

  if (reassignPartial.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.IPR_REASSIGN,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: reassignPartial.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.consumed_qty,
        mrn_no: c.mrn_no,
      })),
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        reassign: true,
        coil_count: reassignPartial.length,
        reassign_lines: reassignPartial.map((c) => {
          const uidKey = String(c.coil_no_uid || "").trim().toLowerCase();
          const prev = previousByUid.get(uidKey) || {};
          const cur = currentByUid.get(uidKey) || {};
          return {
            coil_no_uid: c.coil_no_uid,
            source_pjobcardno: prev.pjobcardno ?? null,
            target_pjobcardno: cur.pjobcardno ?? c.pjobcardno ?? null,
            source_macname: prev.macname ?? null,
            target_macname: cur.macname ?? c.macname ?? null,
            consumed_qty: c.consumed_qty,
            balance_qty: c.remaining_qty,
            out_uid: prev.out_uid ?? c.out_uid ?? null,
          };
        }),
      },
    });
  }

  if (leftoverPartial.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: leftoverPartial.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.consumed_qty,
        mrn_no: c.mrn_no,
      })),
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        partial: true,
        leftover_store_in: true,
        coil_count: leftoverPartial.length,
        shop_floor_balance: leftoverPartial.map((c) => ({
          coil_no_uid: c.coil_no_uid,
          remaining_qty: c.remaining_qty,
        })),
      },
    });
  }

  return { count: fullConsumed.length + partialConsumed.length, partialConsumed };
}

/** Legacy — remove old auto store-in child rows from before single-row partial consume. */
async function cancelLegacyAutoStoreInForConsume(consumeIprUid, user) {
  const pending = await findPendingAutoStoreInForConsume(consumeIprUid);
  if (!pending?.ipr_uid) return null;
  await softDeleteInProcessRequest(pending.ipr_uid, user);
  return pending.ipr_uid;
}

/** Partial consume keeps balance on the same row — downstream becomes Store In Pending. */
async function finalizeApprovedConsumeDownstream(iprUid, user, req) {
  const data = await findInProcessRequest(iprUid);
  if (!data) return null;

  const downstream = resolveConsumeDownstream(data.coils);
  if (data.downstream === downstream) return data;

  await updateInProcessRequest(iprUid, {
    downstream,
    updated_by: user,
    updated_at: new Date(),
  });

  const updated = await findInProcessRequest(iprUid);
  if (downstream === IPR_DOWNSTREAM.PENDING_STORE_IN) {
    log(req, "consume_balance_pending_store_in", String(iprUid), {
      ipr_uid: iprUid,
      balance_qty: updated?.balance_qty ?? 0,
      coil_count: updated?.coil_count ?? 0,
    }, updated);
  }
  return updated;
}

/** Un-approving or deleting a consume request puts coils back out at the machine when they were issued. */
async function releaseConsumedCoils(row, user, req) {
  await cancelLegacyAutoStoreInForConsume(row.ipr_uid, user);
  const snapshot = row.previous_coils?.length ? row.previous_coils : row.coils;
  const fromOut = (snapshot || []).some((c) => c.out_uid != null);
  const hadReassign = normalizeCoils(row.coils).some((c) => c.reassign === true)
    || normalizeCoils(snapshot).some((c) => c.reassign === true);
  if (fromOut) {
    const { restored } = await revertStoreInReturnCoils(row.ipr_uid, snapshot, user);
    if (!restored.length) return 0;
    logCoilTransactionSafe({
      transaction_type: hadReassign ? COIL_TX_TYPES.IPR_REASSIGN_REVERT : COIL_TX_TYPES.CONSUME_REVERT,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: restored,
      details: {
        ipr_uid: row.ipr_uid,
        coil_count: restored.length,
        restore_out: true,
        ...(hadReassign ? { reassign_revert: true } : {}),
      },
    });
    return restored.length;
  }
  const restored = await revertCoilsConsumed(row.ipr_uid, user);
  if (!restored.length) return 0;
  logCoilTransactionSafe({
    transaction_type: hadReassign ? COIL_TX_TYPES.IPR_REASSIGN_REVERT : COIL_TX_TYPES.CONSUME_REVERT,
    source_module: MODULE,
    source_id: String(row.ipr_uid),
    user_name: user,
    user_id: req.user?.id,
    rows: restored,
    details: {
      ipr_uid: row.ipr_uid,
      coil_count: restored.length,
      ...(hadReassign ? { reassign_revert: true } : {}),
    },
  });
  return restored.length;
}

/** Approving store-in — return remainder to stock and record consumed qty. */
async function applyStoreInReturn(row, user, req) {
  // Final qty entered at Store In receive (not the pre-receive shop-floor snapshot).
  const source = normalizeCoils(row.coils?.length ? row.coils : row.previous_coils);
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

  await recordConsumeFromStoreInReturn(row, consumed, user, req);

  return { returned, consumed };
}

/** Receive partial-consume balance on the same consume row — usage was already logged at approve. */
async function applyConsumeBalanceReceive(row, user, req) {
  const source = normalizeCoils(row.coils?.length ? row.coils : row.previous_coils);
  const priorByUid = new Map(
    normalizeCoils(row.coils).map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );
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
        request_type: IPR_REQUEST_TYPE.CONSUME,
        returned_count: returned.length,
        consume_balance_receive: true,
      },
    });
  }

  const incrementalConsumed = (consumed || [])
    .map((c) => {
      const key = String(c.coil_no_uid).toLowerCase();
      const priorUsed = Number(priorByUid.get(key)?.consumed_qty) || 0;
      const receiveUsed = Number(c.consumed_qty) || 0;
      const delta = receiveUsed - priorUsed;
      if (delta <= 0) return null;
      return {
        coil_no_uid: c.coil_no_uid,
        qty: delta,
        mrn_no: c.mrn_no ?? null,
        consumed_qty: delta,
        partial: Boolean(c.partial),
      };
    })
    .filter(Boolean);

  if (incrementalConsumed.length) {
    logCoilTransactionSafe({
      transaction_type: COIL_TX_TYPES.CONSUME,
      source_module: MODULE,
      source_id: String(row.ipr_uid),
      user_name: user,
      user_id: req.user?.id,
      rows: incrementalConsumed,
      details: {
        ipr_uid: row.ipr_uid,
        reason: row.reason || null,
        partial: true,
        coil_count: incrementalConsumed.length,
        consume_balance_receive: true,
        incremental: true,
      },
    });
  }

  const receiveCoilsByUid = new Map(
    source.map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );

  const updatedCoils = normalizeCoils(row.coils).map((c) => {
    const key = String(c.coil_no_uid).toLowerCase();
    const receiveLine = receiveCoilsByUid.get(key);
    const original = Number(c.original_qty ?? c.qty) || 0;
    const storeInQty = receiveLine
      ? Number(receiveLine.remaining_qty ?? receiveLine.qty) || 0
      : 0;
    const totalConsumed = receiveLine
      ? Math.max(0, original - storeInQty)
      : Number(c.consumed_qty) || 0;

    return {
      ...c,
      original_qty: original,
      consumed_qty: totalConsumed,
      remaining_qty: storeInQty,
      store_in_qty: storeInQty,
      qty: totalConsumed,
    };
  });

  await updateInProcessRequest(row.ipr_uid, {
    coils: updatedCoils,
    updated_by: user,
    updated_at: new Date(),
  });

  return { returned, consumed: incrementalConsumed };
}

/**
 * Legacy store-in child row → update source consume IPR after receive.
 * Kept for rows created before single-row partial consume.
 */
async function updateSourceConsumeFromStoreInReceive(storeInRow, consumedLines, user, req) {
  const consumeIprUid = parseConsumeIprUidFromAutoStoreInRemarks(storeInRow?.remarks);
  if (!consumeIprUid) return null;

  const consumeRow = await findInProcessRequest(consumeIprUid);
  if (!consumeRow || normalizeRequestType(consumeRow.request_type) !== IPR_REQUEST_TYPE.CONSUME) {
    return null;
  }

  const consumedByUid = new Map(
    (consumedLines || []).map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );
  const receiveCoilsByUid = new Map(
    normalizeCoils(storeInRow.coils).map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );

  const updatedCoils = normalizeCoils(consumeRow.coils).map((c) => {
    const key = String(c.coil_no_uid).toLowerCase();
    const consumedLine = consumedByUid.get(key);
    const receiveLine = receiveCoilsByUid.get(key);
    const original =
      Number(c.original_qty ?? c.qty) ||
      Number(receiveLine?.original_qty ?? receiveLine?.qty) ||
      Number(consumedLine?.original_qty) ||
      0;

    const storeInQty = receiveLine
      ? Number(receiveLine.remaining_qty ?? receiveLine.qty) || 0
      : 0;

    let totalConsumed = Number(c.consumed_qty) || 0;
    if (consumedLine) {
      totalConsumed = Number(consumedLine.consumed_qty) || 0;
    } else if (receiveLine) {
      totalConsumed = Math.max(0, original - storeInQty);
    }

    return {
      ...c,
      original_qty: original,
      consumed_qty: totalConsumed,
      remaining_qty: storeInQty,
      store_in_qty: storeInQty,
      balance_in_store_in: storeInQty > 0,
      qty: totalConsumed,
    };
  });

  const totalStoreInQty = updatedCoils.reduce((s, c) => s + (Number(c.store_in_qty) || 0), 0);

  await updateInProcessRequest(consumeIprUid, {
    coils: updatedCoils,
    downstream: totalStoreInQty > 0 ? IPR_DOWNSTREAM.STORE_IN_DONE : IPR_DOWNSTREAM.CONSUMED,
    updated_by: user,
    updated_at: new Date(),
  });

  const updated = await findInProcessRequest(consumeIprUid);
  const storeInQty = normalizeCoils(storeInRow.coils).reduce(
    (s, c) => s + (Number(c.remaining_qty ?? c.qty) || 0),
    0
  );
  log(req, "update_consume_from_store_in_receive", String(consumeIprUid), {
    consume_ipr_uid: consumeIprUid,
    store_in_ipr_uid: storeInRow.ipr_uid,
    store_in_qty: storeInQty,
    consumed_qty: updated?.consumed_qty ?? 0,
    balance_qty: updated?.balance_qty ?? 0,
  }, updated);

  return updated;
}

/** Create Consume IPR rows for qty used at store-in receive (audit — coils already updated). */
async function recordConsumeFromStoreInReturn(storeInRow, consumedLines = [], user, req) {
  const remarks = String(storeInRow?.remarks || "");
  if (remarks.startsWith(AUTO_STORE_IN_FROM_CONSUME_PREFIX)) {
    return updateSourceConsumeFromStoreInReceive(storeInRow, consumedLines, user, req);
  }

  const lines = (consumedLines || []).filter((c) => Number(c.consumed_qty) > 0);
  if (!lines.length) return null;

  const coils = lines.map((c) => ({
    coil_no_uid: c.coil_no_uid,
    qty: Number(c.consumed_qty) || 0,
    original_qty: Number(c.original_qty) || 0,
    consumed_qty: Number(c.consumed_qty) || 0,
    remaining_qty: 0,
    mrn_no: c.mrn_no ?? null,
    partial: Boolean(c.partial),
  }));

  const previous_coils = coils.map((c) => ({
    ...c,
    qty: c.original_qty,
  }));

  const first = coils[0] || {};
  const record = {
    request_type: IPR_REQUEST_TYPE.CONSUME,
    reason: `Used qty from Store In (IPR #${storeInRow.ipr_uid})`,
    remarks: autoConsumeFromStoreInRemarks(storeInRow.ipr_uid),
    lot_no: storeInRow.lot_no ?? null,
    mrn_uid: storeInRow.mrn_uid ?? first.mrn_uid ?? null,
    mrn_no: storeInRow.mrn_no ?? first.mrn_no ?? null,
    heat_no: storeInRow.heat_no ?? null,
    item_code: storeInRow.item_code ?? null,
    item_desc: storeInRow.item_desc ?? null,
    coils,
    previous_coils,
    proposed_coils: [],
    scanned_coil_uids: coils.map((c) => c.coil_no_uid),
    approved: true,
    approved_by: user,
    approved_at: new Date(),
    downstream: IPR_DOWNSTREAM.CONSUMED,
    created_by: user,
  };

  const row = await insertInProcessRequest(record);
  log(req, "auto_consume_from_store_in", String(row.ipr_uid), {
    ipr_uid: row.ipr_uid,
    source_store_in_ipr_uid: storeInRow.ipr_uid,
    coil_count: coils.length,
    consumed_qty: coils.reduce((s, c) => s + Number(c.consumed_qty || 0), 0),
  }, row);
  return row;
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
  const uids = (row.coils || []).map((c) => c.coil_no_uid).filter(Boolean);
  const held = await markCoilsInProcessRejectionPending(row.ipr_uid, uids, user);
  if (held.length !== uids.length) {
    throw Object.assign(
      new Error(
        `Could not hold ${uids.length - held.length} of ${uids.length} coil(s) for rejection. They may already be on another rejection register.`
      ),
      { status: 400 }
    );
  }
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

  const restoreOutUids = [];
  for (const coil of restored) {
    const uid = String(coil?.coil_no_uid || "").trim();
    if (!uid) continue;
    const pending = await findPendingStoreInForCoil(uid);
    if (pending?.ipr_uid) restoreOutUids.push(uid);
  }
  if (restoreOutUids.length) {
    await restoreCoilsToShopFloorOut(restoreOutUids, user);
  }

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
      permission: req.permission,
    });
    result.data = await enrichIprWithMachineLabels(result.data);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getInProcessRequestById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    let data = await findInProcessRequest(id);
    if (!data) return res.status(404).json({ success: false, message: "In-process request not found." });
    data = await attachQcChecksToIprRejection(data);
    if (data?.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN) {
      const [enriched] = await enrichIprWithMachineLabels([data]);
      data = enriched ?? data;
    }
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Coil lookup helper for IPR scan — eligibility flags without rm_coils module access. */
export const getCoilHelper = async (req, res) => {
  try {
    const coil_no_uid = String(req.body?.coil_no_uid ?? req.body?.uid ?? "").trim();
    if (!coil_no_uid) {
      return res.status(400).json({ success: false, message: "Coil UID is required." });
    }
    const coil = await findCoilByUid(coil_no_uid);
    if (!coil) {
      return res.status(404).json({ success: false, message: "Coil not found." });
    }
    const pendingStoreIn = await findPendingStoreInForCoil(coil_no_uid);
    const originalQty = Number(coil.qty) || 0;
    return res.json({
      success: true,
      data: {
        ...coil,
        original_qty: originalQty,
        pending_store_in_ipr_uid: pendingStoreIn?.ipr_uid ?? null,
        eligible_for_consume: isIssuedToShopFloor(coil),
        eligible_for_rejection:
          isCoilEligibleForIprRejection(coil) && !pendingStoreIn?.ipr_uid,
        eligible_for_store_in: isIssuedToShopFloor(coil),
      },
    });
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

export const getPendingStoreIn = async (req, res) => {
  try {
    const result = await findInProcessRequests({
      pendingStoreInQueue: true,
      filters: { approved: true, downstream: IPR_DOWNSTREAM.PENDING_STORE_IN },
      page: 1,
      limit: 1000,
    });
    result.data = await enrichIprWithMachineLabels(result.data);
    return res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** One pending store-in row for Receive modal — Store In module readers (no IPR view required). */
export const getPendingStoreInById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.ipr_uid ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid in-process request ID is required." });
    }
    const existing = await findInProcessRequest(id);
    if (!existing || !isPendingStoreInReceivable(existing)) {
      return res.status(404).json({
        success: false,
        message: "Pending store-in request not found or not receivable.",
      });
    }
    if (hasReassignShopFloorBalance(existing.coils)) {
      return res.status(400).json({
        success: false,
        message: "Reassign balance stays on shop floor — this request is not in the Unassigned receive queue.",
      });
    }
    const [data] = await enrichIprWithMachineLabels([existing]);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getPendingStoreOut = async (req, res) => {
  try {
    const result = await findInProcessRequests({
      filters: {
        request_type: IPR_REQUEST_TYPE.REJECTION,
        approved: true,
        downstream: IPR_DOWNSTREAM.PENDING_STORE_OUT,
      },
      page: 1,
      limit: 1000,
    });
    return res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Shop-floor coils (status=out + out_uid) — IPR Pending tab work queue. */
export const getPendingShopFloor = async (req, res) => {
  try {
    const { page, limit, search } = extractListParams(req.body || {}, {
      sortBy: "coil_no_uid",
      order: "ASC",
    });
    const result = await findCoils({
      filters: { shop_floor: true },
      search: sanitizeSearch(search),
      page,
      limit,
      sortBy: "coil_no_uid",
      order: "ASC",
      permission: req.permission,
    });
    return res.json({ success: true, ...result });
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
    if (!isPendingStoreInReceivable(existing)) {
      return res.status(400).json({
        success: false,
        message: "Only a request in the Store In Pending queue can be received.",
      });
    }
    if (hasReassignShopFloorBalance(existing.coils)) {
      return res.status(400).json({
        success: false,
        message: "Reassign balance stays on shop floor — receive to Unassigned is not allowed for this request.",
      });
    }

    const user = auditUserName(req);
    const isConsumeBalance = isConsumeBalancePending(existing);
    let applyRow = existing;

    if (Array.isArray(req.body?.coils) && req.body.coils.length) {
      const fields = buildRecordFields(
        {
          ...req.body,
          request_type: isConsumeBalance ? IPR_REQUEST_TYPE.CONSUME : IPR_REQUEST_TYPE.STORE_IN,
        },
        existing
      );
      await reconcileCoilsForStoreInReceive(fields.coils, id, user, req);
      try {
        await assertCoilsForStoreInReturn(fields.coils, id);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      await updateInProcessRequest(id, {
        coils: fields.coils,
        previous_coils: fields.previous_coils,
        ...(isConsumeBalance ? {} : { proposed_coils: fields.proposed_coils }),
        scanned_coil_uids: fields.scanned_coil_uids,
        updated_by: user,
        updated_at: new Date(),
      });
      applyRow = await findInProcessRequest(id);
    } else {
      await reconcileCoilsForStoreInReceive(existing.coils, id, user, req);
      try {
        await assertCoilsForStoreInReturn(existing.coils, id);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }

    if (isConsumeBalance) {
      await applyConsumeBalanceReceive(applyRow, user, req);
    } else {
      await applyStoreInReturn(applyRow, user, req);
    }
    await updateInProcessRequest(id, {
      downstream: IPR_DOWNSTREAM.STORE_IN_DONE,
      updated_by: user,
      updated_at: new Date(),
    });

    const data = await findInProcessRequest(id);
    log(req, "complete_store_in", String(id), {
      ipr_uid: id,
      request_type: data?.request_type ?? null,
      coil_count: data?.coil_count ?? 0,
      downstream: data?.downstream ?? null,
    }, data);

    return res.json({
      success: true,
      data,
      message: isConsumeBalance
        ? "Balance received to Unassigned Area. Consumed qty remains on this request."
        : "Store-in received. Unassigned qty updated.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

function parseJsonField(val, fallback = []) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

export const createInProcessRequest = async (req, res) => {
  try {
    const user = auditUserName(req);
    const body = { ...req.body };

    // FormData parses objects as strings
    ["coils", "previous_coils", "proposed_coils", "scanned_coil_uids", "attachments", "existing_attachments"].forEach((k) => {
      if (typeof body[k] === "string") {
        body[k] = parseJsonField(body[k]);
      }
    });

    if (body.existing_attachments) {
      body.attachments = Array.isArray(body.existing_attachments) ? body.existing_attachments : [];
    }

    await stampRmstoreUploadedFiles(req);
    if (Array.isArray(req.files) && req.files.length) {
      const paths = req.files.map((f) => toRmPublicUploadPath(f, "ipr"));
      body.attachments = [...(Array.isArray(body.attachments) ? body.attachments : []), ...paths];
    }
    const fields = buildRecordFields(body);
    try {
      validate(fields);
      await assertConsumeReassignRules(fields, req.user);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    let incomingApproved = normalizeApprovedInput(req.body?.approved);
    const record = { ...fields, created_by: user, downstream: IPR_DOWNSTREAM.NONE };
    const isConsume = fields.request_type === IPR_REQUEST_TYPE.CONSUME;
    const isRejection = fields.request_type === IPR_REQUEST_TYPE.REJECTION;
    const isStoreIn = fields.request_type === IPR_REQUEST_TYPE.STORE_IN;

    if (isRejection && !hasInProcessRejectionPermission(req.user)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to submit in-process rejections.",
      });
    }

    if (isConsume) {
      incomingApproved = true;
    } else if (isRejection) {
      incomingApproved = false;
    }

    if (isStoreIn) {
      try {
        await assertCoilsForStoreInReturn(fields.coils);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }

    if (incomingApproved === true) {
      if (isConsume) {
        try {
          await assertCoilsConsumable(fields.coils);
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
      applyApprovalUpdateFields({
        req,
        fields: record,
        incomingApproved: true,
        hasBusinessChanges: false,
        alreadyApproved: false,
        auditAsName: true,
        ...((isStoreIn || isConsume) ? { canAuthorize: true } : {}),
      });
      record.downstream = resolveDownstream(fields.request_type, true);
    }

    const row = await insertInProcessRequest(record);
    let data = await findInProcessRequest(row.ipr_uid);

    if (isApprovedConsume(data)) {
      await consumeCoils(data, user, req);
      data = await finalizeApprovedConsumeDownstream(row.ipr_uid, user, req);
    } else if (isApprovedRejectionPending(data)) {
      await holdCoilsForRejection(data, user, req);
    }

    const messages = {
      [IPR_REQUEST_TYPE.STORE_IN]: isApprovedStoreInPending(data)
        ? "Store-in submitted and queued in Store In Pending. Receive when ready — same coil updates to Unassigned Area with return qty."
        : "Store-in request saved as pending.",
      [IPR_REQUEST_TYPE.CONSUME]: isApprovedConsume(data)
        ? `Consume processed. ${data?.coil_count ?? 0} coil line(s); used qty recorded${
            data?.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN && Number(data?.balance_qty) > 0
              ? ` — balance ${Number(data.balance_qty).toLocaleString()} queued in Store In Pending on this request`
              : ""
          }.`
        : "Consume request created successfully.",
      [IPR_REQUEST_TYPE.REJECTION]: isApprovedRejectionPending(data)
        ? "In-process rejection created and queued in RM Rejection Pending."
        : "In-process rejection created successfully.",
      [IPR_REQUEST_TYPE.TRANSFER]: "Coil transfer request created successfully (placeholder).",
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

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const user = auditUserName(req);
    const body = { ...req.body };

    // FormData parses objects as strings
    ["coils", "previous_coils", "proposed_coils", "scanned_coil_uids", "attachments", "existing_attachments"].forEach((k) => {
      if (typeof body[k] === "string") {
        body[k] = parseJsonField(body[k]);
      }
    });

    if (body.existing_attachments) {
      body.attachments = Array.isArray(body.existing_attachments) ? body.existing_attachments : [];
    }

    await stampRmstoreUploadedFiles(req);
    if (Array.isArray(req.files) && req.files.length) {
      const paths = req.files.map((f) => toRmPublicUploadPath(f, "ipr"));
      body.attachments = [...(Array.isArray(body.attachments) ? body.attachments : []), ...paths];
    }
    const fields = buildRecordFields(body, existing);
    try {
      validate(fields);
      await assertConsumeReassignRules(fields, req.user);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    if (
      fields.request_type === IPR_REQUEST_TYPE.REJECTION &&
      !hasInProcessRejectionPermission(req.user)
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to submit in-process rejections.",
      });
    }

    const incomingApproved = normalizeApprovedInput(req.body?.approved);
    const contentChanged = hasInProcessContentChanges(existing, fields);
    const updateFields = contentChanged ? pickIprBusinessFields(fields) : {};
    const approvalOnly = !contentChanged && incomingApproved === true;

    if (incomingApproved === undefined && !contentChanged) {
      const data = await findInProcessRequest(id);
      return res.json({ success: true, data, message: "No change" });
    }

    applyApprovalUpdateFields({
      req,
      fields: updateFields,
      incomingApproved,
      hasBusinessChanges: contentChanged,
      alreadyApproved: existing.approved === true,
      auditAsName: true,
      ...(normalizeRequestType(fields.request_type) === IPR_REQUEST_TYPE.STORE_IN ||
      normalizeRequestType(fields.request_type) === IPR_REQUEST_TYPE.CONSUME
        ? { canAuthorize: true }
        : {}),
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
    const consumeQtyChanged = hasConsumeQtyChanges(existing, fields);
    const willReapplyConsume =
      willConsume && (!wasConsumed || coilsChanged || consumeQtyChanged);

    if (
      normalizeRequestType(fields.request_type) === IPR_REQUEST_TYPE.CONSUME &&
      updateFields.approved === true &&
      wasConsumed &&
      !willReapplyConsume &&
      (existing.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN ||
        existing.downstream === IPR_DOWNSTREAM.STORE_IN_DONE)
    ) {
      updateFields.downstream = existing.downstream;
    }

    if (willReapplyConsume) {
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
    // if (willRejectPending && (!wasRejectionPending || coilsChanged)) {
    //   try {
    //     await assertCoilsRejectable(fields.coils, wasRejectionPending ? id : null);
    //   } catch (e) {
    //     return res.status(e.status || 400).json({ success: false, message: e.message });
    //   }
    // }
    if (willRejectPending && (!wasRejectionPending || coilsChanged)) {
      try {
        await assertCoilsRejectable(fields.coils, id);
      } catch (e) {
        return res.status(e.status || 400).json({
          success: false,
          message: e.message,
        });
      }
    }

    await updateInProcessRequest(id, updateFields);

    if (wasConsumed && (!willConsume || willReapplyConsume)) {
      await releaseConsumedCoils(existing, user, req);
    }
    if (wasStoreInDone && (!willApproveStoreIn || coilsChanged)) {
      await releaseStoreInReturn(existing, user, req);
    }
    if (wasRejectionPending && (!willRejectPending || coilsChanged)) {
      await releaseRejectedCoils(existing, user, req);
    }

    let data = await findInProcessRequest(id);
    if (willReapplyConsume) {
      await consumeCoils(data, user, req);
      data = await finalizeApprovedConsumeDownstream(id, user, req);
    }
    if (willRejectPending && (!wasRejectionPending || coilsChanged)) {
      await holdCoilsForRejection(data, user, req);
      data = await findInProcessRequest(id);
    }

    const approvedMessages = {
      [IPR_REQUEST_TYPE.STORE_IN]: isApprovedStoreInPending(data)
        ? "Store-in submitted and queued in Store In Pending."
        : isApprovedStoreInDone(data)
          ? "Store-in request updated."
          : "Store-in request saved.",
      [IPR_REQUEST_TYPE.CONSUME]: `Consume approved. ${data?.coil_count ?? 0} coil line(s) processed${
        data?.downstream === IPR_DOWNSTREAM.PENDING_STORE_IN && Number(data?.balance_qty) > 0
          ? ` — balance queued in Store In Pending on this request`
          : ""
      }.`,
      [IPR_REQUEST_TYPE.REJECTION]: "In-process rejection approved and queued in RM Rejection Pending.",
      [IPR_REQUEST_TYPE.TRANSFER]: "Coil transfer request updated successfully (placeholder).",
    };

    log(req, data?.approved ? "approve" : "update", String(id), {
      ipr_uid: id,
      request_type: data?.request_type,
      coil_count: data?.coil_count ?? 0,
      coil_no_uids: (data?.coils || []).map((c) => c?.coil_no_uid).filter(Boolean),
      approved: data?.approved === true,
      downstream: data?.downstream ?? null,
      approval_only: approvalOnly,
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
