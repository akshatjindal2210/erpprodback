import { findQcChecks, findQcCheck, findQcCheckItems, findPendingQcCheckByCoil, findPendingCoilsForQc, findLiveQcCheckByCoil, insertQcCheck, replaceQcCheckItems, updateQcCheck, softDeleteQcCheck } from "../models/qcCheck.model.js";
import { findCoilByUid, linkCoilsToQcCheck, clearCoilQcLink, clearCoilsForQcReject, markCoilsQcFailPending, markCoilsQcPassed, findCoilUidsByQcCheck, findCoilsByQcCheckUid } from "../../coil/models/coil.model.js";
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { isCoilEligibleForQc, QC_ONLY_MRN_COIL_MESSAGE } from "../../../lib/utils/coilQcEligibility.js";
import { findSpecItemDetail } from "../../spec/models/specMaster.model.js";
import { softDeleteQcRejection } from "../../rm-rejection/models/rmRejection.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { evaluateSpecLine, formatExpected } from "../../../lib/utils/qc/evaluateSpec.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";

const MODULE = "rm_qc_check";
const log = createRmstoreActivityLogger(MODULE);
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";

const BATCH_COIL_INDEPENDENT_QC_MSG = "This MRN is batch-wise. Scan the batch QC sticker and submit QC for the whole batch — individual coils cannot be checked independently.";

/** Always store public upload path in `document_note` (never bare original filename alone). */
function resolveQcDocumentNote(uploaded, inputNote, priorNote) {
  if (uploaded?.path) return String(uploaded.path).trim();
  for (const candidate of [inputNote, priorNote]) {
    let s = String(candidate || "").trim().replace(/\\/g, "/");
    if (!s) continue;
    s = s.replace(/^\/+/, "");
    if (s.startsWith("uploads/")) return s;
    if (s.startsWith("rmstore/")) return `uploads/${s}`;
    // Legacy: filename-only rows still resolve under QC uploads folder in the report loader.
    if (/^[\w.\-]+\.(pdf|png|jpe?g|webp|gif)$/i.test(s)) return `uploads/rmstore/qc/${s}`;
  }
  return null;
}

/**
 * Header `coil_no_uid` is VARCHAR(120) — store one primary UID only.
 * Full batch list lives on coil rows via `linkCoilsToQcCheck` (STRING_AGG on read).
 */
function primaryCoilUidForQcHeader(targetCoilUids = [], fallback = "") {
  const fromList = (targetCoilUids || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (fromList.length) return fromList[0];
  const fromFallback = String(fallback || "").split(",").map((s) => s.trim()).filter(Boolean);
  return fromFallback[0] || "";
}

function parseTruthyFlag(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

/**
 * Batch sticker_mode MRNs must QC as a whole.
 * Independent single-coil prepare/submit is blocked.
 * Allowed: multi-coil payload, explicit is_batch_qc (incl. 1-coil batch), or existing check id.
 */
async function assertBatchMrnAllowsCoilQc(coil, batchUids = [], opts = {}) {
  const mrnUid = coil?.mrn_uid;
  if (!mrnUid) return;
  const mrn = await findMrnByUid(mrnUid);
  const mode = String(mrn?.sticker_mode || "coil").toLowerCase();
  if (mode !== "batch") return;
  if (opts.isBatchQc === true) return;
  if (opts.existingCheckId) return;
  if (Array.isArray(batchUids) && batchUids.length > 1) return;
  const err = new Error(BATCH_COIL_INDEPENDENT_QC_MSG);
  err.status = 400;
  throw err;
}

function isSuperAdminUser(req) {
  return String(req.user?.type || req.user?.role || "").toLowerCase() === "super_admin";
}

function hasQcPerm(req, action) {
  if (isSuperAdminUser(req)) return true;
  return req.permission?.[`can_${action}`] === true;
}

/** pass | fail from evaluated spec lines; null if any line is incomplete. */
function computeOverallFromEvaluated(evaluated = []) {
  if (!evaluated.length) return null;
  if (evaluated.some((e) => !e.result)) return null;
  return evaluated.some((e) => e.result === "fail") ? "fail" : "pass";
}

/** Backend decides overall result; only Super Admin may override via body.overall_result. */
function resolveOverallResult(evaluated, { bodyOverride, isSuperAdmin, anyFail }) {
  const computed =
    anyFail === true ? "fail" : anyFail === false ? "pass" : computeOverallFromEvaluated(evaluated);
  if (!computed) return null;
  if (isSuperAdmin) {
    const raw = String(bodyOverride || "").trim().toLowerCase();
    if (raw === "pass" || raw === "fail") return raw;
  }
  return computed;
}

function normalizeOverallResult(stored, status) {
  const raw = String(stored || "").trim().toLowerCase();
  if (raw === "pass" || raw === "fail") return raw;
  const st = String(status || "").trim().toLowerCase();
  if (st === "passed") return "pass";
  if (st === "failed") return "fail";
  return null;
}

async function buildCheckDetail(qc_check_uid) {
  const data = await findQcCheck(qc_check_uid);
  if (!data) return null;
  data.overall_result = normalizeOverallResult(data.overall_result, data.status);
  const [items, coilRows] = await Promise.all([
    findQcCheckItems(qc_check_uid),
    findCoilsByQcCheckUid(qc_check_uid),
  ]);
  const coils = (coilRows || []).map((c) => ({
    coil_no_uid: c.coil_no_uid,
    heat_no: c.heat_no,
    item_code: c.item_code,
    item_desc: c.item_desc,
    qty: c.qty,
    mrn_uid: c.mrn_uid,
  }));
  return { ...data, items, coils };
}

function buildChecklistFromSpecs(approvedSpecs = []) {
  return approvedSpecs.map((s) => ({
    spec_id: s.spec_id,
    sno: s.sno,
    type: s.type,
    spec_name: s.spec_name,
    print_val: s.print_val,
    inspection_method: s.inspection_method
      ? String(s.inspection_method).trim().toUpperCase()
      : null,
    spec_type: s.spec_type,
    min_value: s.min_value,
    max_value: s.max_value,
    correct_option: s.correct_option,
    incorrect_option: s.incorrect_option,
    document_required: s.document_required === true,
    expected_display: formatExpected(s),
    dropdown_options:
      String(s.spec_type || "").toLowerCase() === "dropdown"
        ? [
            ...String(s.correct_option || "")
              .split(",")
              .map((x) => x.trim().toUpperCase())
              .filter(Boolean),
            ...String(s.incorrect_option || "")
              .split(",")
              .map((x) => x.trim().toUpperCase())
              .filter(Boolean),
          ].filter((v, i, arr) => arr.indexOf(v) === i)
        : [],
  }));
}

async function loadApprovedSpecs(item_dcode, item_code) {
  if (!item_dcode) {
    const err = new Error("This coil has no RM item code, so specifications cannot be loaded.");
    err.statusCode = 400;
    throw err;
  }
  const specDetail = await findSpecItemDetail(item_dcode);
  if (!specDetail || !specDetail.specs?.length) {
    const err = new Error(
      `No specifications are defined for item ${item_code || item_dcode}. Define them in RM Spec Master.`
    );
    err.statusCode = 400;
    throw err;
  }
  const approvedSpecs = (specDetail.specs || []).filter((s) => s.approved === true);
  if (!approvedSpecs.length) {
    const err = new Error(
      `The specifications for item ${item_code || item_dcode} are not authorized. Authorize them in RM Spec Master first.`
    );
    err.statusCode = 400;
    throw err;
  }
  return { specDetail, approvedSpecs };
}

/**
 * List QC queue.
 * status=pending → work queue (virtual / draft / awaiting_approval) until Approve.
 * Register (all|passed|failed) → submitted rows; passed/failed require approved_at.
 */
export const getQcChecks = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "qc_check_uid",
      order: "DESC",
    });
    const safeFilters = sanitizeFilters(filters || {}, ["status", "from_date", "to_date", "mrn_uid", "coil_no_uid", "expand_coils", "coil_level"]);
    const status = String(safeFilters.status || "pending").trim().toLowerCase();

    if (status === "pending") {
      const result = await findPendingCoilsForQc({ filters: safeFilters, search: sanitizeSearch(search), page, limit});
      return res.json({ success: true, ...result });
    }

    const result = await findQcChecks({
      filters: {
        ...safeFilters,
        // Register must never list unapproved work
        ...(status === "all" || !status
          ? { status: "all" }
          : ["passed", "failed"].includes(status)
            ? { status }
            : { status: "all" }),
      },
      search: sanitizeSearch(search),
      page,
      limit,
      permission: req.permission,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getQcCheckById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });
    const data = await buildCheckDetail(id);
    if (!data) return res.status(404).json({ success: false, message: "QC check not found." });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Prepare inspection checklist from Spec Master.
 * body: { qc_check_uid } or { coil_no_uid }
 * Virtual pending coils (no DB row) are supported via coil_no_uid.
 */
export const prepareQcCheck = async (req, res) => {
  try {
    let check = null;
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    let coilUid = String(req.body?.coil_no_uid || "").trim();
    const isBatchQc = parseTruthyFlag(req.body?.is_batch_qc);
    let batchUids = [];
    if (coilUid.includes(",")) {
      batchUids = coilUid.split(",").map((s) => s.trim()).filter(Boolean);
      coilUid = batchUids[0] || "";
    }

    if (id) {
      check = await findQcCheck(id);
      if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    } else if (coilUid) {
      const coilForMode = await findCoilByUid(coilUid);
      if (coilForMode) {
        try {
          await assertBatchMrnAllowsCoilQc(coilForMode, batchUids, { isBatchQc });
        } catch (e) {
          if (e?.status === 400) {
            return res.status(400).json({ success: false, message: e.message });
          }
          throw e;
        }
      }
      check = await findPendingQcCheckByCoil(coilUid);
      if (!check) {
        const live = await findLiveQcCheckByCoil(coilUid);
        if (live) {
          const detail = await buildCheckDetail(live.qc_check_uid);
          return res.json({
            success: true,
            data: {
              ...detail,
              expected: (detail.items || []).map((it) => ({
                ...it,
                expected_display: formatExpected(it),
              })),
              read_only: true,
            },
          });
        }
        const coil = coilForMode || (await findCoilByUid(coilUid));
        if (!coil) {
          return res.status(404).json({ success: false, message: `Coil ${coilUid} was not found.` });
        }
        if (!isCoilEligibleForQc(coil)) {
          return res.status(400).json({ success: false, message: QC_ONLY_MRN_COIL_MESSAGE });
        }
        const coilStatus = String(coil.status || "active").toLowerCase();
        if (coilStatus !== "active") {
          return res.status(400).json({
            success: false,
            message: `This coil is not available for QC. Its current status is ${coilStatus}.`,
          });
        }
        // Virtual pending — no QC row in DB yet
        check = {
          qc_check_uid: null,
          coil_no_uid: coil.coil_no_uid, // Reference only the first coil in header
          mrn_uid: coil.mrn_uid,
          mrn_no: coil.mrn_no,
          heat_no: coil.heat_no,
          item_dcode: coil.item_dcode,
          item_code: coil.item_code,
          item_desc: coil.item_desc,
          qty: batchUids.length > 0 ? null : coil.qty,
          status: "pending",
          is_virtual_pending: true,
          _coil_no_uid_orig: req.body.coil_no_uid, // Keep original for frontend if needed
        };
      }
    } else {
      return res.status(400).json({ success: false, message: "A QC check ID or Coil UID is required." });
    }

    const resData = { ...check };
    if (batchUids.length > 0) {
      resData.coil_no_uid = req.body.coil_no_uid; // Send back the full list to frontend
    }

    const status = String(check.status || "").toLowerCase();
    const forEdit =
      req.body?.for_edit === true ||
      req.body?.for_edit === "true" ||
      req.body?.for_edit === "1" ||
      req.body?.for_edit === 1;
    const editableSubmitted = ["awaiting_approval", "passed", "failed"].includes(status);

    if (status !== "pending" && status !== "draft" && !(forEdit && editableSubmitted)) {
      if (!check.qc_check_uid) {
        return res.status(400).json({ success: false, message: "This QC check cannot be inspected." });
      }
      const detail = await buildCheckDetail(check.qc_check_uid);
      return res.json({
        success: true,
        data: {
          ...detail,
          expected: (detail.items || []).map((it) => ({
            ...it,
            expected_display: formatExpected(it),
          })),
          read_only: true,
        },
      });
    }

    const { specDetail, approvedSpecs } = await loadApprovedSpecs(check.item_dcode, check.item_code);
    const checklist = buildChecklistFromSpecs(approvedSpecs);

    // Draft / Register edit — merge previously saved answers into checklist
    let savedItems = [];
    if (check.qc_check_uid && (status === "draft" || (forEdit && editableSubmitted))) {
      savedItems = await findQcCheckItems(check.qc_check_uid);
      const byId = new Map(savedItems.map((it) => [Number(it.spec_id), it]));
      for (const line of checklist) {
        const saved = byId.get(Number(line.spec_id));
        if (!saved) continue;
        line.actual_value = saved.actual_value ?? "";
        line.document_note = saved.document_note ?? "";
        line.result = saved.result ?? null;
      }
    }

    return res.json({
      success: true,
      data: {
        ...resData,
        items: savedItems,
        checklist,
        overall_result:
          normalizeOverallResult(check.overall_result, check.status) ||
          computeOverallFromEvaluated(savedItems),
        approval_status: specDetail.approval_status,
        read_only: false,
        is_edit: forEdit && editableSubmitted,
      },
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, message: err.message });
  }
};

/**
 * Submit QC inspection.
 * body (multipart): {
 *   qc_check_uid? | coil_no_uid?,
 *   is_draft?: true|false,
 *   remarks?, failure_reason?,
 *   items: [{ spec_id, actual_value }]
 *   files: doc_<spec_id>
 * }
 * Draft (add) → status=draft (stays in Pending). Final submit (add) → awaiting_approval | failed.
 * Approve (authorize) → passed (counts in inventory as QC-cleared).
 */
export const submitQcCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    let coilUid = String(req.body?.coil_no_uid || "").trim();
    const user = auditUserName(req);
    const isDraft =
      req.body?.is_draft === true ||
      req.body?.is_draft === "true" ||
      req.body?.is_draft === "1" ||
      req.body?.is_draft === 1;
    const isBatchQc = parseTruthyFlag(req.body?.is_batch_qc);

    let batchUids = [];
    if (coilUid.includes(",")) {
      batchUids = coilUid.split(",").map((s) => s.trim()).filter(Boolean);
      coilUid = batchUids[0] || "";
    }

    let check = null;
    let isEditSubmit = false;
    if (id) {
      check = await findQcCheck(id);
      if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
      const st = String(check.status || "").toLowerCase();
      if (st === "pending" || st === "draft") {
        isEditSubmit = false;
      } else if (["awaiting_approval", "passed", "failed"].includes(st)) {
        isEditSubmit = true;
      } else {
        return res.status(400).json({ success: false, message: "This QC check has already been submitted." });
      }
    } else if (coilUid) {
      const live = await findLiveQcCheckByCoil(coilUid);
      if (live) {
        const liveStatus = String(live.status || "").toLowerCase();
        if (liveStatus === "pending" || liveStatus === "draft") {
          check = live;
        } else {
          return res.status(400).json({
            success: false,
            message: `A QC check has already been recorded for coil ${coilUid}. Its current status is ${live.status}.`,
          });
        }
      } else {
        const coil = await findCoilByUid(coilUid);
        if (!coil) {
          return res.status(400).json({ success: false, message: `Coil ${coilUid} was not found.` });
        }
        if (!isCoilEligibleForQc(coil)) {
          return res.status(400).json({ success: false, message: QC_ONLY_MRN_COIL_MESSAGE });
        }
        const coilStatus = String(coil.status || "active").toLowerCase();
        if (coilStatus !== "active") {
          return res.status(400).json({
            success: false,
            message: `This coil is not available for QC. Its current status is ${coilStatus}.`,
          });
        }
        check = {
          qc_check_uid: null,
          coil_no_uid: coil.coil_no_uid, // Reference only first coil
          mrn_uid: coil.mrn_uid,
          mrn_no: coil.mrn_no,
          heat_no: coil.heat_no,
          item_dcode: coil.item_dcode,
          item_code: coil.item_code,
          item_desc: coil.item_desc,
          qty: batchUids.length > 0 ? null : coil.qty,
          status: "pending",
          _coil: coil,
        };
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "A QC check ID or Coil UID is required.",
      });
    }

    if (isEditSubmit) {
      if (!hasQcPerm(req, "edit")) {
        return res.status(403).json({ success: false, message: "You do not have permission to edit this QC check." });
      }
    } else if (!hasQcPerm(req, "add")) {
      const liveSt = String(check.status || "").toLowerCase();
      const canContinueDraft = hasQcPerm(req, "edit") && check.qc_check_uid && (liveSt === "draft" || liveSt === "pending");
      if (!canContinueDraft) {
        return res.status(403).json({ success: false, message: "You do not have permission to submit a QC check." });
      }
    }

    if (check?.qc_check_uid && check?.created_at) {
      const editBlocked = assertWithinEditDays(req, check.created_at, "edit");
      if (editBlocked) {
        return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
      }
    }

    const primaryUid = String(check.coil_no_uid || "").split(",")[0]?.trim();
    const primaryCoil = check._coil || (await findCoilByUid(primaryUid));
    if (!primaryCoil) {
      return res.status(400).json({ success: false, message: `Primary coil ${primaryUid} was not found.` });
    }
    if (!isCoilEligibleForQc(primaryCoil)) {
      return res.status(400).json({ success: false, message: QC_ONLY_MRN_COIL_MESSAGE });
    }

    // Whole batch (comma list) or single coil; also recover UIDs from check / linked coils
    const fromCheck = String(check.coil_no_uid || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let targetCoilUids =
      batchUids.length > 1
        ? batchUids
        : fromCheck.length > 1
          ? fromCheck
          : batchUids.length === 1
            ? batchUids
            : [primaryCoil.coil_no_uid];
    if (targetCoilUids.length <= 1 && check.qc_check_uid) {
      const linked = await findCoilUidsByQcCheck(check.qc_check_uid);
      if (Array.isArray(linked) && linked.length > 1) {
        targetCoilUids = linked.map((u) => String(u).trim()).filter(Boolean);
      }
    }
    try {
      await assertBatchMrnAllowsCoilQc(primaryCoil, targetCoilUids, {
        isBatchQc,
        existingCheckId: check.qc_check_uid || id || null,
      });
    } catch (e) {
      if (e?.status === 400) {
        return res.status(400).json({ success: false, message: e.message });
      }
      throw e;
    }
    const inspectorName = user;

    const { approvedSpecs } = await loadApprovedSpecs(check.item_dcode, check.item_code);

    let inputItems = req.body?.items;
    if (typeof inputItems === "string") {
      try {
        inputItems = JSON.parse(inputItems);
      } catch {
        return res.status(400).json({ success: false, message: "The specification values could not be read." });
      }
    }
    if (!Array.isArray(inputItems)) inputItems = [];

    const bySpecId = new Map();
    for (const it of inputItems) {
      const sid = Number(it?.spec_id);
      if (Number.isFinite(sid)) bySpecId.set(sid, it);
    }

    const fileBySpecId = new Map();
    for (const f of Array.isArray(req.files) ? req.files : []) {
      const m = String(f.fieldname || "").match(/^doc_(\d+)$/);
      if (!m) continue;
      fileBySpecId.set(Number(m[1]), {
        path: toRmPublicUploadPath(f, "qc"),
        name: f.originalname || f.filename,
      });
    }

    // Keep prior draft docs when re-saving without re-upload
    let priorItems = [];
    if (check.qc_check_uid) {
      priorItems = await findQcCheckItems(check.qc_check_uid);
    }
    const priorBySpec = new Map(priorItems.map((it) => [Number(it.spec_id), it]));

    const evaluated = [];
    let anyFail = false;
    let anyEmpty = false;
    for (const spec of approvedSpecs) {
      const input = bySpecId.get(Number(spec.spec_id)) || {};
      const prior = priorBySpec.get(Number(spec.spec_id)) || {};
      let actual_value = input.actual_value != null ? String(input.actual_value).trim() : "";
      if (actual_value && String(spec.spec_type || "").toLowerCase() === "dropdown") {
        actual_value = actual_value.toUpperCase();
      }
      const uploaded = fileBySpecId.get(Number(spec.spec_id));
      const document_note = resolveQcDocumentNote(
        uploaded,
        input.document_note,
        prior.document_note,
      );

      if (!actual_value) anyEmpty = true;

      let result = null;
      let message = null;
      if (actual_value) {
        const evalRes = evaluateSpecLine(spec, actual_value);
        result = evalRes.result;
        message = evalRes.message;
        if (result === "fail") anyFail = true;
      }

      if (!isDraft && spec.document_required === true && !document_note) {
        return res.status(400).json({
          success: false,
          message: `A document upload is required for specification ${spec.spec_name || spec.spec_id}.`,
        });
      }

      evaluated.push({
        spec_id: spec.spec_id,
        sno: spec.sno,
        type: spec.type,
        spec_name: spec.spec_name,
        print_val: spec.print_val,
        inspection_method: spec.inspection_method
          ? String(spec.inspection_method).trim().toUpperCase()
          : null,
        spec_type: spec.spec_type,
        min_value: spec.min_value,
        max_value: spec.max_value,
        correct_option: spec.correct_option,
        incorrect_option: spec.incorrect_option,
        document_required: spec.document_required === true,
        actual_value: actual_value || null,
        document_note,
        result,
        eval_message: message || null,
      });
    }

    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    let failure_reason =
      req.body?.failure_reason != null ? String(req.body.failure_reason).trim() : "";

    if (isDraft) {
      if (isEditSubmit) {
        return res.status(400).json({
          success: false,
          message: "Drafts are not allowed when editing from the Register. Update the values and submit.",
        });
      }
      if (
        req.body?.overall_result != null &&
        String(req.body.overall_result).trim() !== "" &&
        !isSuperAdminUser(req)
      ) {
        return res.status(403).json({
          success: false,
          message: "Only Super Admin can change the overall QC result.",
        });
      }
      const draftOverall = resolveOverallResult(evaluated, {
        bodyOverride: req.body?.overall_result,
        isSuperAdmin: isSuperAdminUser(req),
        anyFail: anyEmpty ? undefined : anyFail,
      });
      let checkId = check.qc_check_uid;
      if (!checkId) {
        const created = await insertQcCheck(
          {
            coil_no_uid: primaryCoilUidForQcHeader(targetCoilUids, check.coil_no_uid),
            mrn_uid: check.mrn_uid,
            status: "draft",
          },
          user
        );
        checkId = created?.qc_check_uid;
        if (!checkId) {
          return res.status(500).json({ success: false, message: "Could not create the QC draft. Please try again." });
        }
      }

      await replaceQcCheckItems(checkId, evaluated);
      await linkCoilsToQcCheck(checkId, targetCoilUids, "draft", user);
      await updateQcCheck(checkId, {
        status: "draft",
        overall_result: draftOverall,
        approved: false,
        failure_reason: failure_reason || null,
        remarks,
        inspected_by: inspectorName,
        inspected_at: new Date(),
        updated_by: user,
        updated_at: new Date(),
      });

      const data = await buildCheckDetail(checkId);
      return res.json({
        success: true,
        data,
        toast_type: "success",
        message: "QC check saved as draft successfully.",
      });
    }

    if (anyEmpty) {
      return res.status(400).json({
        success: false,
        message: "Fill in all specification values before submitting, or save the check as a draft.",
      });
    }

    if (anyFail && !failure_reason) {
      failure_reason = evaluated
        .filter((e) => e.result === "fail")
        .map((e) => {
          const name = e.spec_name || `spec ${e.spec_id}`;
          const expected = formatExpected(e);
          const got = e.actual_value != null && String(e.actual_value).trim() !== ""
            ? String(e.actual_value).trim()
            : "—";
          return `${name}: expected ${expected}, got ${got}`;
        })
        .join("; ");
    }
    if (!anyFail) failure_reason = "";

    if (
      req.body?.overall_result != null &&
      String(req.body.overall_result).trim() !== "" &&
      !isSuperAdminUser(req)
    ) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin can change the overall QC result.",
      });
    }

    const storedOverall = resolveOverallResult(evaluated, {
      bodyOverride: req.body?.overall_result,
      isSuperAdmin: isSuperAdminUser(req),
      anyFail,
    });

    // Final submit always → awaiting_approval (stays in Pending until Approve).
    const overallStatus = "awaiting_approval";
    const prevStatus = String(check.status || "").toLowerCase();

    let checkId = check.qc_check_uid;
    if (!checkId) {
      const created = await insertQcCheck(
        {
          coil_no_uid: primaryCoilUidForQcHeader(targetCoilUids, check.coil_no_uid),
          mrn_uid: check.mrn_uid,
          status: "pending",
        },
        user
      );
      checkId = created?.qc_check_uid;
      if (!checkId) {
        return res.status(500).json({ success: false, message: "Could not create the QC check. Please try again." });
      }
    }

    await replaceQcCheckItems(checkId, evaluated);

    let qc_reject_uid = check.qc_reject_uid || null;

    // Re-submit of an approved row (or legacy failed with rejection) → clear Register link
    if ((prevStatus === "failed" || prevStatus === "passed") && qc_reject_uid) {
      await clearCoilsForQcReject(qc_reject_uid, user);
      await softDeleteQcRejection(qc_reject_uid, user);
      qc_reject_uid = null;
    } else if (prevStatus === "failed" || prevStatus === "passed") {
      qc_reject_uid = null;
    }

    await linkCoilsToQcCheck(checkId, targetCoilUids, "awaiting_approval", user);

    await updateQcCheck(checkId, {
      status: overallStatus,
      overall_result: storedOverall,
      approved: false,
      failure_reason: failure_reason || null,
      remarks,
      inspected_by: inspectorName,
      inspected_at: new Date(),
      qc_reject_uid,
      approved_by: null,
      approved_at: null,
      updated_by: user,
      updated_at: new Date(),
    });

    logCoilTransactionSafe({
      transaction_type: storedOverall === "fail" ? COIL_TX_TYPES.QC_CHECK_FAIL : COIL_TX_TYPES.QC_CHECK_PASS,
      source_module: "qc_check",
      source_id: String(checkId),
      user_name: inspectorName,
      user_id: req.user?.id,
      rows: [primaryCoil], // Log against primary coil for simplicity
      details: {
        qc_check_uid: checkId,
        status: overallStatus,
        failure_reason: failure_reason || null,
        qc_reject_uid: null,
        is_edit: isEditSubmit,
        has_mismatch: storedOverall === "fail",
        overall_result: storedOverall,
        failed_specs: evaluated.filter((e) => e.result === "fail").map((e) => e.spec_name),
        batch_count: targetCoilUids.length,
      },
    });

    const data = await buildCheckDetail(checkId);
    log(req, isEditSubmit ? "resubmit" : "submit", String(checkId), {
      qc_check_uid: checkId,
      coil_no_uid: primaryCoil.coil_no_uid,
      mrn_no: primaryCoil.mrn_no ?? null,
      item_code: primaryCoil.item_code ?? null,
      status: overallStatus,
      failure_reason: failure_reason || null,
      has_mismatch: storedOverall === "fail",
      overall_result: storedOverall,
      failed_specs: evaluated.filter((e) => e.result === "fail").map((e) => e.spec_name),
      batch_count: targetCoilUids.length,
    }, data);
    return res.json({
      success: true,
      data,
      message: isEditSubmit
        ? "QC check updated and is awaiting approval."
        : storedOverall === "fail"
          ? "QC check submitted with mismatches and is awaiting approval."
          : `QC check submitted for ${targetCoilUids.length} coils and is awaiting approval.`,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, message: err.message });
  }
};

/**
 * Approve QC check (authorize). Approver may change values before deciding.
 * body (multipart or JSON): { qc_check_uid, remarks?, failure_reason?, items? }
 * Pass → status=passed. Fail → status=failed (Rejection Pending virtual — no DB rejection yet).
 */
export const approveQcCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });

    const check = await findQcCheck(id);
    if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    if (String(check.status || "").toLowerCase() !== "awaiting_approval") {
      return res.status(400).json({
        success: false,
        message: `Only QC checks awaiting approval can be approved. This check is currently ${check.status}.`,
      });
    }

    const user = auditUserName(req);
    
    // In batch checks, coil_no_uid might be a comma-separated list
    let primaryUid = String(check.coil_no_uid || "").split(",")[0]?.trim();
    const coil = await findCoilByUid(primaryUid);
    if (!coil) {
      return res.status(400).json({ success: false, message: `Primary coil ${primaryUid} was not found.` });
    }

    // Find all coils linked to this check (important for batch-wise approval)
    const finalCoilUids = await findCoilUidsByQcCheck(id);
    const coilList = finalCoilUids.length > 0 ? finalCoilUids : [primaryUid];

    const { approvedSpecs } = await loadApprovedSpecs(check.item_dcode, check.item_code);

    let inputItems = req.body?.items;
    if (typeof inputItems === "string") {
      try {
        inputItems = JSON.parse(inputItems);
      } catch {
        return res.status(400).json({ success: false, message: "The specification values could not be read." });
      }
    }
    if (!Array.isArray(inputItems)) inputItems = [];

    const bySpecId = new Map();
    for (const it of inputItems) {
      const sid = Number(it?.spec_id);
      if (Number.isFinite(sid)) bySpecId.set(sid, it);
    }

    const fileBySpecId = new Map();
    for (const f of Array.isArray(req.files) ? req.files : []) {
      const m = String(f.fieldname || "").match(/^doc_(\d+)$/);
      if (!m) continue;
      fileBySpecId.set(Number(m[1]), {
        path: toRmPublicUploadPath(f, "qc"),
        name: f.originalname || f.filename,
      });
    }

    const priorItems = await findQcCheckItems(id);
    const priorBySpec = new Map(priorItems.map((it) => [Number(it.spec_id), it]));

    // If no items posted, keep prior answers for approve-as-is
    const usePriorOnly = bySpecId.size === 0 && fileBySpecId.size === 0;

    const evaluated = [];
    let anyFail = false;
    let anyEmpty = false;
    for (const spec of approvedSpecs) {
      const prior = priorBySpec.get(Number(spec.spec_id)) || {};
      const input = usePriorOnly ? prior : bySpecId.get(Number(spec.spec_id)) || {};
      let actual_value =
        input.actual_value != null ? String(input.actual_value).trim() : String(prior.actual_value || "").trim();
      if (actual_value && String(spec.spec_type || "").toLowerCase() === "dropdown") {
        actual_value = actual_value.toUpperCase();
      }
      const uploaded = fileBySpecId.get(Number(spec.spec_id));
      const document_note = resolveQcDocumentNote(
        uploaded,
        input.document_note,
        prior.document_note,
      );

      if (!actual_value) anyEmpty = true;

      let result = null;
      let message = null;
      if (actual_value) {
        const evalRes = evaluateSpecLine(spec, actual_value);
        result = evalRes.result;
        message = evalRes.message;
        if (result === "fail") anyFail = true;
      }

      if (spec.document_required === true && !document_note) {
        return res.status(400).json({
          success: false,
          message: `A document upload is required for specification ${spec.spec_name || spec.spec_id}.`,
        });
      }

      evaluated.push({
        spec_id: spec.spec_id,
        sno: spec.sno,
        type: spec.type,
        spec_name: spec.spec_name,
        print_val: spec.print_val,
        inspection_method: spec.inspection_method
          ? String(spec.inspection_method).trim().toUpperCase()
          : null,
        spec_type: spec.spec_type,
        min_value: spec.min_value,
        max_value: spec.max_value,
        correct_option: spec.correct_option,
        incorrect_option: spec.incorrect_option,
        document_required: spec.document_required === true,
        actual_value: actual_value || null,
        document_note,
        result,
        eval_message: message || null,
      });
    }

    if (anyEmpty) {
      return res.status(400).json({
        success: false,
        message: "Fill in all specification values before approving this QC check.",
      });
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim() : check.remarks || null;
    let failure_reason =
      req.body?.failure_reason != null ? String(req.body.failure_reason).trim() : "";

    if (anyFail && !failure_reason) {
      failure_reason = evaluated
        .filter((e) => e.result === "fail")
        .map((e) => {
          const name = e.spec_name || `spec ${e.spec_id}`;
          const expected = formatExpected(e);
          const got =
            e.actual_value != null && String(e.actual_value).trim() !== ""
              ? String(e.actual_value).trim()
              : "—";
          return `${name}: expected ${expected}, got ${got}`;
        })
        .join("; ");
    }
    if (!anyFail) failure_reason = "";

    if (
      req.body?.overall_result != null &&
      String(req.body.overall_result).trim() !== "" &&
      !isSuperAdminUser(req)
    ) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin can change the overall QC result.",
      });
    }

    const overallResult = resolveOverallResult(evaluated, {
      bodyOverride: req.body?.overall_result,
      isSuperAdmin: isSuperAdminUser(req),
      anyFail,
    });
    const forceFail = overallResult === "fail";
    if (forceFail && !failure_reason) {
      failure_reason = anyFail
        ? failure_reason
        : "Marked as failed by Super Admin";
    }
    if (!forceFail) failure_reason = "";

    await replaceQcCheckItems(id, evaluated);

    const overallStatus = forceFail ? "failed" : "passed";

    if (forceFail) {
      await markCoilsQcFailPending(id, coilList, user);
      await updateQcCheck(id, {
        status: "failed",
        overall_result: overallResult,
        approved: true,
        failure_reason: failure_reason || null,
        remarks,
        approved_by: user,
        approved_at: new Date(),
        qc_reject_uid: null,
      });
    } else {
      await markCoilsQcPassed(id, coilList, user);
      await updateQcCheck(id, {
        status: "passed",
        overall_result: overallResult,
        approved: true,
        failure_reason: null,
        remarks,
        approved_by: user,
        approved_at: new Date(),
        qc_reject_uid: null,
      });
    }

    logCoilTransactionSafe({
      transaction_type: forceFail ? COIL_TX_TYPES.QC_CHECK_FAIL : COIL_TX_TYPES.QC_CHECK_PASS,
      source_module: "qc_check",
      source_id: String(id),
      user_name: user,
      user_id: req.user?.id,
      rows: [coil],
      details: {
        qc_check_uid: id,
        status: overallStatus,
        failure_reason: failure_reason || null,
        approved: true,
        overall_result: overallResult,
        batch_count: coilList.length,
      },
    });

    const data = await buildCheckDetail(id);
    log(req, forceFail ? "approve_fail" : "approve_pass", String(id), {
      qc_check_uid: id,
      coil_no_uid: coil.coil_no_uid,
      mrn_no: coil.mrn_no ?? null,
      item_code: coil.item_code ?? null,
      status: overallStatus,
      failure_reason: failure_reason || null,
      approved: true,
      overall_result: overallResult,
      batch_count: coilList.length,
    }, data);
    return res.json({
      success: true,
      data,
      message: forceFail
        ? `QC check approved as failed for ${coilList.length} coils and now appears in Rejection Pending.`
        : `QC check approved for ${coilList.length} coils. They are now counted in inventory.`,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, message: err.message });
  }
};

/**
 * Edit / reopen — awaiting_approval | passed | failed.
 * Soft-deletes check (and linked QC Rejection if failed) so coil returns to Pending.
 * body: { qc_check_uid }
 */
export const reopenQcCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });

    const check = await findQcCheck(id);
    if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    const status = String(check.status || "").toLowerCase();
    if (!["awaiting_approval", "passed", "failed"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Only a submitted QC check can be edited or reopened. This check is currently ${check.status}.`,
      });
    }

    const user = auditUserName(req);

    // Find all coils linked to this check
    const finalCoilUids = await findCoilUidsByQcCheck(id);
    let coilList = finalCoilUids;
    if (!coilList.length) {
      coilList = String(check.coil_no_uid || "").split(",").map(s => s.trim()).filter(Boolean);
    }

    // Failed checks may be linked to QC Rejection — restore coil + soft-delete rejection
    if (status === "failed" && check.qc_reject_uid) {
      await clearCoilsForQcReject(check.qc_reject_uid, user);
      await softDeleteQcRejection(check.qc_reject_uid, user);
    } else {
      await clearCoilQcLink(coilList, user);
    }

    await softDeleteQcCheck(id, user);

    log(req, "reopen", String(id), {
      qc_check_uid: id,
      coil_no_uid: check.coil_no_uid,
      previous_status: status,
      qc_reject_uid: check.qc_reject_uid ?? null,
      batch_count: coilList.length,
    }, check);

    return res.json({
      success: true,
      message: `QC check reopened for ${coilList.length} coils. They are back in Pending for re-inspection.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Delete register QC check. Failed rows with QC Rejection must be cleared from Rejection first.
 * body: { qc_check_uid }
 */
export const deleteQcCheck = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.qc_check_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid QC check ID is required." });

    const check = await findQcCheck(id);
    if (!check) return res.status(404).json({ success: false, message: "QC check not found." });

    const status = String(check.status || "").toLowerCase();
    if (status === "failed" && check.qc_reject_uid) {
      return res.status(400).json({
        success: false,
        message: "This failed QC check is linked to a QC rejection. Delete it from QC Rejection instead.",
      });
    }

    const user = auditUserName(req);

    // Find all coils linked to this check
    const finalCoilUids = await findCoilUidsByQcCheck(id);
    let coilList = finalCoilUids;
    if (!coilList.length) {
      coilList = String(check.coil_no_uid || "").split(",").map(s => s.trim()).filter(Boolean);
    }

    await softDeleteQcCheck(id, user);
    await clearCoilQcLink(coilList, user);

    log(req, "delete", String(id), {
      qc_check_uid: id,
      coil_no_uid: check.coil_no_uid,
      previous_status: status,
      batch_count: coilList.length,
    }, check);

    return res.json({
      success: true,
      message: `QC check deleted successfully for ${coilList.length} coils. They have returned to Pending.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
