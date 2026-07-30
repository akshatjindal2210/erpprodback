import { findQcChecks, findQcCheck, findQcCheckItems, findPendingQcCheckByCoil, findPendingCoilsForQc, findLiveQcCheckByCoil, insertQcCheck, replaceQcCheckItems, updateQcCheck, softDeleteQcCheck } from "../models/qcCheck.model.js";
import { findCoilByUid, linkCoilsToQcCheck, clearCoilQcLink, clearCoilsForQcReject, markCoilsQcFailPending } from "../../coil/models/coil.model.js";
import { findSpecItemDetail } from "../../spec/models/specMaster.model.js";
import { softDeleteQcRejection } from "../../rm-rejection/models/rmRejection.model.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { logCoilTransactionSafe } from "../../../lib/utils/transactions/logCoilTransaction.js";
import { COIL_TX_TYPES } from "../../../lib/constants/coilTransactionTypes.js";
import { evaluateSpecLine, formatExpected } from "../../../lib/utils/qc/evaluateSpec.js";
import { toRmPublicUploadPath } from "../../../lib/middleware/upload.js";

async function buildCheckDetail(qc_check_uid) {
  const data = await findQcCheck(qc_check_uid);
  if (!data) return null;
  const items = await findQcCheckItems(qc_check_uid);
  return { ...data, items };
}

function buildChecklistFromSpecs(approvedSpecs = []) {
  return approvedSpecs.map((s) => ({
    spec_id: s.spec_id,
    sno: s.sno,
    type: s.type,
    spec_name: s.spec_name,
    print_val: s.print_val,
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
              .map((x) => x.trim())
              .filter(Boolean),
            ...String(s.incorrect_option || "")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ].filter((v, i, arr) => arr.findIndex((t) => t.toLowerCase() === v.toLowerCase()) === i)
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
 * Register (all|passed|failed) → only authorized rows (approved = true).
 */
export const getQcChecks = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "qc_check_uid",
      order: "DESC",
    });
    const safeFilters = sanitizeFilters(filters || {}, [
      "status",
      "from_date",
      "to_date",
      "mrn_uid",
      "coil_no_uid",
      "expand_coils",
      "coil_level",
    ]);
    const status = String(safeFilters.status || "pending").trim().toLowerCase();

    if (status === "pending") {
      const result = await findPendingCoilsForQc({
        filters: safeFilters,
        search: sanitizeSearch(search),
        page,
        limit,
      });
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
    const coilUid = String(req.body?.coil_no_uid || "").trim();

    if (id) {
      check = await findQcCheck(id);
      if (!check) return res.status(404).json({ success: false, message: "QC check not found." });
    } else if (coilUid) {
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
        const coil = await findCoilByUid(coilUid);
        if (!coil) {
          return res.status(404).json({ success: false, message: `Coil ${coilUid} was not found.` });
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
          coil_no_uid: coil.coil_no_uid,
          mrn_uid: coil.mrn_uid,
          mrn_no: coil.mrn_no,
          heat_no: coil.heat_no,
          item_dcode: coil.item_dcode,
          item_code: coil.item_code,
          item_desc: coil.item_desc,
          qty: coil.qty,
          status: "pending",
          is_virtual_pending: true,
        };
      }
    } else {
      return res.status(400).json({ success: false, message: "A QC check ID or Coil UID is required." });
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
        ...check,
        items: savedItems,
        checklist,
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
    const coilUid = String(req.body?.coil_no_uid || "").trim();
    const user = auditUserName(req);
    const isDraft =
      req.body?.is_draft === true ||
      req.body?.is_draft === "true" ||
      req.body?.is_draft === "1" ||
      req.body?.is_draft === 1;

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
        const coilStatus = String(coil.status || "active").toLowerCase();
        if (coilStatus !== "active") {
          return res.status(400).json({
            success: false,
            message: `This coil is not available for QC. Its current status is ${coilStatus}.`,
          });
        }
        check = {
          qc_check_uid: null,
          coil_no_uid: coil.coil_no_uid,
          mrn_uid: coil.mrn_uid,
          mrn_no: coil.mrn_no,
          heat_no: coil.heat_no,
          item_dcode: coil.item_dcode,
          item_code: coil.item_code,
          item_desc: coil.item_desc,
          qty: coil.qty,
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

    const coil = check._coil || (await findCoilByUid(check.coil_no_uid));
    if (!coil) {
      return res.status(400).json({ success: false, message: `Coil ${check.coil_no_uid} was not found.` });
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
      const actual_value = input.actual_value != null ? String(input.actual_value).trim() : "";
      const uploaded = fileBySpecId.get(Number(spec.spec_id));
      const document_note = uploaded
        ? uploaded.name
        : input.document_note != null
          ? String(input.document_note).trim()
          : prior.document_note
            ? String(prior.document_note).trim()
            : "";
      const document_path = uploaded?.path || (prior.document_note?.startsWith?.("uploads/") ? prior.document_note : null);

      if (!actual_value) anyEmpty = true;

      let result = null;
      let message = null;
      if (actual_value) {
        const evalRes = evaluateSpecLine(spec, actual_value);
        result = evalRes.result;
        message = evalRes.message;
        if (result === "fail") anyFail = true;
      }

      if (!isDraft && spec.document_required === true && !document_note && !document_path) {
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
        spec_type: spec.spec_type,
        min_value: spec.min_value,
        max_value: spec.max_value,
        correct_option: spec.correct_option,
        incorrect_option: spec.incorrect_option,
        document_required: spec.document_required === true,
        actual_value: actual_value || null,
        document_note: document_path || document_note || null,
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
      let checkId = check.qc_check_uid;
      if (!checkId) {
        const created = await insertQcCheck(
          {
            coil_no_uid: check.coil_no_uid,
            mrn_uid: check.mrn_uid,
            mrn_no: check.mrn_no,
            heat_no: check.heat_no,
            item_dcode: check.item_dcode,
            item_code: check.item_code,
            item_desc: check.item_desc,
            qty: check.qty,
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
      await linkCoilsToQcCheck(checkId, [check.coil_no_uid], "draft", user);
      await updateQcCheck(checkId, {
        status: "draft",
        failure_reason: failure_reason || null,
        remarks,
        inspected_by: inspectorName,
        inspected_at: new Date().toISOString(),
        updated_by: user,
        updated_at: new Date().toISOString(),
      });

      const data = await buildCheckDetail(checkId);
      return res.json({
        success: true,
        data,
        message: "QC draft saved. Submit it once all specification values are filled in.",
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

    // Final submit always → awaiting_approval (stays in Pending until Approve).
    // Pass/fail is decided only on Approve → Register (passed | failed).
    const overallStatus = "awaiting_approval";
    const prevStatus = String(check.status || "").toLowerCase();

    let checkId = check.qc_check_uid;
    if (!checkId) {
      const created = await insertQcCheck(
        {
          coil_no_uid: check.coil_no_uid,
          mrn_uid: check.mrn_uid,
          mrn_no: check.mrn_no,
          heat_no: check.heat_no,
          item_dcode: check.item_dcode,
          item_code: check.item_code,
          item_desc: check.item_desc,
          qty: check.qty,
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

    await linkCoilsToQcCheck(checkId, [check.coil_no_uid], "awaiting_approval", user);

    await updateQcCheck(checkId, {
      status: overallStatus,
      failure_reason: failure_reason || null,
      remarks,
      inspected_by: inspectorName,
      inspected_at: new Date().toISOString(),
      qc_reject_uid,
      approved: false,
      approved_by: null,
      approved_at: null,
      updated_by: user,
      updated_at: new Date().toISOString(),
    });

    logCoilTransactionSafe({
      transaction_type: anyFail ? COIL_TX_TYPES.QC_CHECK_FAIL : COIL_TX_TYPES.QC_CHECK_PASS,
      source_module: "qc_check",
      source_id: String(checkId),
      user_name: inspectorName,
      user_id: req.user?.id,
      rows: [coil],
      details: {
        qc_check_uid: checkId,
        status: overallStatus,
        failure_reason: failure_reason || null,
        qc_reject_uid: null,
        is_edit: isEditSubmit,
        has_mismatch: anyFail,
        failed_specs: evaluated.filter((e) => e.result === "fail").map((e) => e.spec_name),
      },
    });

    const data = await buildCheckDetail(checkId);
    return res.json({
      success: true,
      data,
      message: isEditSubmit
        ? "QC check updated and is awaiting approval."
        : anyFail
          ? "QC check submitted with mismatches and is awaiting approval."
          : "QC check submitted and is awaiting approval.",
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
    const coil = await findCoilByUid(check.coil_no_uid);
    if (!coil) {
      return res.status(400).json({ success: false, message: `Coil ${check.coil_no_uid} was not found.` });
    }

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
      const actual_value =
        input.actual_value != null ? String(input.actual_value).trim() : String(prior.actual_value || "").trim();
      const uploaded = fileBySpecId.get(Number(spec.spec_id));
      const document_note = uploaded
        ? uploaded.name
        : input.document_note != null
          ? String(input.document_note).trim()
          : prior.document_note
            ? String(prior.document_note).trim()
            : "";
      const document_path =
        uploaded?.path || (String(prior.document_note || "").startsWith("uploads/") ? prior.document_note : null);

      if (!actual_value) anyEmpty = true;

      let result = null;
      let message = null;
      if (actual_value) {
        const evalRes = evaluateSpecLine(spec, actual_value);
        result = evalRes.result;
        message = evalRes.message;
        if (result === "fail") anyFail = true;
      }

      if (spec.document_required === true && !document_note && !document_path) {
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
        spec_type: spec.spec_type,
        min_value: spec.min_value,
        max_value: spec.max_value,
        correct_option: spec.correct_option,
        incorrect_option: spec.incorrect_option,
        document_required: spec.document_required === true,
        actual_value: actual_value || null,
        document_note: document_path || document_note || null,
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

    // Super Admin may override overall Pass / Fail on Approve.
    const isSuperAdmin =
      String(req.user?.type || req.user?.role || "").toLowerCase() === "super_admin";
    const overrideRaw = String(req.body?.overall_result || "").trim().toLowerCase();
    let forceFail = anyFail;
    if (isSuperAdmin && (overrideRaw === "pass" || overrideRaw === "fail")) {
      forceFail = overrideRaw === "fail";
      if (forceFail && !failure_reason) {
        failure_reason = anyFail
          ? failure_reason
          : "Forced fail by Super Admin";
      }
      if (!forceFail) failure_reason = "";
    }

    await replaceQcCheckItems(id, evaluated);

    const overallStatus = forceFail ? "failed" : "passed";

    if (forceFail) {
      await markCoilsQcFailPending(id, [check.coil_no_uid], user);
      await updateQcCheck(id, {
        status: "failed",
        failure_reason: failure_reason || null,
        remarks,
        inspected_by: user,
        inspected_at: new Date().toISOString(),
        approved: true,
        approved_by: user,
        approved_at: new Date().toISOString(),
        qc_reject_uid: null,
        updated_by: user,
        updated_at: new Date().toISOString(),
      });
    } else {
      await linkCoilsToQcCheck(id, [check.coil_no_uid], "passed", user);
      await updateQcCheck(id, {
        status: "passed",
        failure_reason: null,
        remarks,
        inspected_by: user,
        inspected_at: new Date().toISOString(),
        approved: true,
        approved_by: user,
        approved_at: new Date().toISOString(),
        qc_reject_uid: null,
        updated_by: user,
        updated_at: new Date().toISOString(),
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
        overall_result: overallStatus,
        overall_override: isSuperAdmin && (overrideRaw === "pass" || overrideRaw === "fail") ? overrideRaw : null,
      },
    });

    const data = await buildCheckDetail(id);
    return res.json({
      success: true,
      data,
      message: forceFail
        ? "QC check approved as failed and now appears in Rejection Pending."
        : "QC check approved. The coil is now counted in inventory.",
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

    // Failed checks may be linked to QC Rejection — restore coil + soft-delete rejection
    if (status === "failed" && check.qc_reject_uid) {
      await clearCoilsForQcReject(check.qc_reject_uid, user);
      await softDeleteQcRejection(check.qc_reject_uid, user);
    } else {
      await clearCoilQcLink([check.coil_no_uid], user);
    }

    await softDeleteQcCheck(id, user);

    return res.json({
      success: true,
      message: "QC check reopened. The coil is back in Pending for re-inspection.",
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
    await softDeleteQcCheck(id, user);
    await clearCoilQcLink([check.coil_no_uid], user);

    return res.json({
      success: true,
      message: "QC check deleted successfully. The coil has returned to Pending.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
