import { findIssueRequests, findIssueRequestJobCardRows, findIssueRequest, findIssueRequestCoils, findIssueRequestJobCards, findIssuedQtyByJobCards, findMachineJobCardLockConflicts, insertIssueRequest, updateIssueRequest, softDeleteIssueRequest, lockIssueRequestForStoreOut as applyIssueRequestStoreOutLock, unlockIssueRequestForStoreOut as applyIssueRequestStoreOutUnlock } from "../models/issueRequest.model.js";
import { ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK } from "../../../lib/config/app.config.js";
import { replaceIssueRequestJobCards } from "../models/issueRequestJobCard.model.js";
import { findProduction, findProductions } from "../../production/models/productionMaster.model.js";
import { normalizeRmItems, productionAllowedRmCodes, rmFieldList } from "../../production/utils/productionRmHelpers.js";
import { loadMappedItems, mergeProductionSnapshot } from "../../production/utils/erpItems.js";
import { hasIssueRmMappedPermission, isSuperAdminUser } from "../../../lib/utils/rmstoreSpecialPermissions.js";
import { findCoilByUid } from "../../coil/models/coil.model.js";
import { isCoilEligibleForIssueRequest } from "../../../lib/utils/coilQcEligibility.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { applyApprovalUpdateFields, applyApprovalWorkflow, auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { assertIssueRequestCoilsAvailable, buildAvailableCoilsForIssue, lockCoilUidsForReserve } from "../utils/stock/issueRequestCoilReserve.js";
import { createRmstoreActivityLogger } from "../../../lib/utils/activity/logRmstoreActivity.js";
import { withTransaction } from "../../../../../config/db/db.js";
import { assertWithinEditDays } from "../../../../../platform/utils/auth/permissionDays.js";
import { buildIssueRequestPrintDocument, sanitizeIssueRequestPrintCompanyInfo } from "../utils/issueRequestPrintDocument.js";

const MODULE = "rm_issue_request";
const log = createRmstoreActivityLogger(MODULE);

async function resolveCoils(coilInputs, { allowedRmItemCodes = null } = {}) {
  const uids = coilInputs
    .map((c) => (typeof c === "string" ? c.trim() : String(c?.coil_no_uid || "").trim()))
    .filter(Boolean);

  const allowed =
    allowedRmItemCodes == null
      ? null
      : new Set(
          [...allowedRmItemCodes]
            .map((c) => String(c || "").trim().toUpperCase())
            .filter(Boolean)
        );

  const resolved = [];
  const seen = new Set();
  for (const uid of uids) {
    const key = uid.toLowerCase();
    if (seen.has(key)) {
      throw Object.assign(new Error(`Coil ${uid} has been added more than once.`), { status: 400 });
    }
    seen.add(key);

    const coil = await findCoilByUid(uid);
    if (!coil) {
      throw Object.assign(new Error(`Coil ${uid} was not found.`), { status: 400 });
    }
    if (!isCoilEligibleForIssueRequest(coil)) {
      const status = String(coil.status || "active").toLowerCase();
      const saAdd = coil.sa_id != null && String(coil.sa_entry_type || "").toLowerCase() === "stock_in";
      const qc = String(coil.qc_check_status || "").trim().toLowerCase();
      const reason =
        status !== "active"
          ? `Its current status is ${status}.`
          : saAdd
            ? "Authorize this Stock Adjustment first (only Store In is allowed while pending)."
            : coil.sticker_approved !== true &&
                coil.sa_id == null &&
                String(coil.mrn_uid || "").trim()
              ? "Approve stickers in MRN Portal first."
              : qc
                ? `QC Check status is ${qc}. Pass QC in MRN Portal flow first.`
                : "Approve MRN stickers and complete QC Check first.";
      throw Object.assign(new Error(`Coil ${uid} is not available. ${reason}`), { status: 400 });
    }
    // Issue Request FG pool = store-in (location set) + unassigned / coil area (no location)
    if (allowed && allowed.size > 0) {
      const code = String(coil.item_code || "").trim().toUpperCase();
      if (!allowed.has(code)) {
        throw Object.assign(
          new Error(`Coil ${uid} has RM item ${coil.item_code}, which is not mapped for this issue request.`),
          { status: 400 }
        );
      }
    }
    resolved.push(coil);
  }
  return resolved;
}

function mapProductionFields(prod) {
  const rmItems = normalizeRmItems(prod);
  const rmCodes = rmFieldList(prod, "rm_item_code");
  const rmDcodes = rmFieldList(prod, "rm_item_dcode");
  const rmDescs = rmFieldList(prod, "rm_item_desc");
  return {
    production_id: prod?.production_id ?? null,
    item_dcode: prod?.item_dcode ?? null,
    item_code: prod?.item_code ?? null,
    item_desc: prod?.item_desc ?? prod?.itemdesc ?? null,
    rm_items: rmItems,
    rm_item_dcode: rmDcodes[0] ?? null,
    rm_item_code: rmCodes[0] ?? null,
    rm_item_desc: rmDescs[0] ?? null,
    rm_item_codes: rmCodes,
  };
}

function resolveRequestedRm(raw, prodFields) {
  const dcode = Number(raw?.rm_item_dcode);
  const code = String(raw?.rm_item_code || "").trim();
  const mapped = prodFields.rm_items || [];

  if (Number.isFinite(dcode) && dcode > 0) {
    const hit = mapped.find((r) => Number(r.rm_item_dcode) === dcode);
    if (hit) return hit;
    return {
      rm_item_dcode: dcode,
      rm_item_code: code || null,
      rm_item_desc: raw?.rm_item_desc || "",
    };
  }
  if (code) {
    const hit = mapped.find(
      (r) => String(r.rm_item_code || "").trim().toUpperCase() === code.toUpperCase()
    );
    if (hit) return hit;
    return { rm_item_dcode: null, rm_item_code: code, rm_item_desc: raw?.rm_item_desc || "" };
  }

  return {
    rm_item_dcode: prodFields.rm_item_dcode,
    rm_item_code: prodFields.rm_item_code,
    rm_item_desc: prodFields.rm_item_desc,
  };
}

function rmIsMapped(mapped, selectedRm) {
  return (mapped || []).some(
    (r) =>
      (selectedRm?.rm_item_dcode != null &&
        Number(r.rm_item_dcode) === Number(selectedRm.rm_item_dcode)) ||
      (selectedRm?.rm_item_code &&
        String(r.rm_item_code || "").trim().toUpperCase() ===
          String(selectedRm.rm_item_code).trim().toUpperCase())
  );
}

async function assertRmSelectionAllowed(user, prodFields, selectedRm) {
  if (isSuperAdminUser(user)) return;

  const mapped = prodFields.rm_items || [];
  const first = mapped[0];
  const isMapped = rmIsMapped(mapped, selectedRm);

  if (hasIssueRmMappedPermission(user)) {
    if (!isMapped) {
      throw Object.assign(
        new Error("You can only select RM items mapped in Production Master."),
        { status: 403 }
      );
    }
    return;
  }

  if (!first) {
    throw Object.assign(new Error("The production mapping has no RM item."), { status: 400 });
  }
  const matchesFirst =
    (selectedRm?.rm_item_dcode != null &&
      Number(first.rm_item_dcode) === Number(selectedRm.rm_item_dcode)) ||
    (selectedRm?.rm_item_code &&
      String(first.rm_item_code || "").trim().toUpperCase() ===
        String(selectedRm.rm_item_code).trim().toUpperCase());
  if (!matchesFirst) {
    throw Object.assign(
      new Error(
        "You do not have permission to change the mapped RM item. The first mapped RM is used automatically."
      ),
      { status: 403 }
    );
  }
}

function rmFieldsFromCoils(resolved, prodFields) {
  const coil = resolved?.[0];
  if (!coil) {
    return {
      rm_item_dcode: prodFields.rm_item_dcode,
      rm_item_code: prodFields.rm_item_code,
      rm_item_desc: prodFields.rm_item_desc,
    };
  }
  const code = String(coil.item_code || "").trim();
  const matched = (prodFields.rm_items || []).find(
    (r) => String(r.rm_item_code || "").trim().toUpperCase() === code.toUpperCase()
  );
  return {
    rm_item_dcode: matched?.rm_item_dcode ?? coil.item_dcode ?? prodFields.rm_item_dcode,
    rm_item_code: code || prodFields.rm_item_code,
    rm_item_desc: matched?.rm_item_desc ?? prodFields.rm_item_desc,
  };
}

function normalizeShift(value) {
  return String(value || "A").trim().toUpperCase() === "B" ? "B" : "A";
}

/** Trim float artifacts from summed / subtracted quantities. */
function round(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function normalizeIssueCoilsForCompare(coils = []) {
  return [...coils]
    .map((c) => ({
      uid: String(c?.coil_no_uid || "").trim().toLowerCase(),
      qty: round(c?.qty),
    }))
    .filter((c) => c.uid)
    .sort((a, b) => a.uid.localeCompare(b.uid));
}

function normalizeIssueJobCardRowForCompare(jc) {
  if (!jc) return null;
  return {
    pjobcardno: String(jc?.pjobcardno || "").trim().toUpperCase(),
    issue_qty: round(jc?.issue_qty),
    rm_item_code: String(jc?.rm_item_code || "").trim().toUpperCase(),
    rm_item_dcode: jc?.rm_item_dcode != null ? Number(jc.rm_item_dcode) : null,
    macname: String(jc?.macname || "").trim().toUpperCase(),
    part_weight: round(jc?.part_weight),
    rm_weight: round(jc?.rm_weight),
    planqty: round(jc?.planqty),
    item_code: String(jc?.item_code || "").trim().toUpperCase(),
    itemdcode: Number(jc?.itemdcode ?? jc?.item_dcode) || null,
    coils: normalizeIssueCoilsForCompare(jc?.coils),
  };
}

function issueJobCardsSnapshot(jobCards = []) {
  return (Array.isArray(jobCards) ? jobCards : [])
    .map(normalizeIssueJobCardRowForCompare)
    .filter((jc) => jc?.pjobcardno)
    .sort((a, b) => a.pjobcardno.localeCompare(b.pjobcardno));
}

function issueJobCardsEqual(left = [], right = []) {
  return JSON.stringify(issueJobCardsSnapshot(left)) === JSON.stringify(issueJobCardsSnapshot(right));
}

async function resolveProductionForItem({ itemdcode, item_code } = {}) {
  const dcode = Number(itemdcode);
  if (Number.isFinite(dcode) && dcode > 0) {
    const approved = await findProductions({
      filters: { item_dcode: dcode, approved: true },
      page: 1,
      limit: 1,
    });
    if (approved.data?.[0]) return approved.data[0];

    const any = await findProductions({
      filters: { item_dcode: dcode },
      page: 1,
      limit: 1,
    });
    if (any.data?.[0]) {
      throw Object.assign(
        new Error(`The production mapping for item ${item_code || dcode} is not approved.`),
        { status: 400 }
      );
    }
  }

  const code = String(item_code || "").trim();
  if (code) {
    const { data } = await findProductions({
      filters: { approved: true },
      search: code,
      page: 1,
      limit: 50,
    });
    const match = (data || []).find(
      (p) => String(p.item_code || "").trim().toUpperCase() === code.toUpperCase()
    );
    if (match) return match;
  }

  return null;
}

/**
 * Normalize job_cards payload and resolve coils + production mapping per JC.
 * @returns {{ jobCards, flatCoils, requestedQty, headerProdFields, allowedRmCodes }}
 */
async function buildJobCardsPayload(rawCards, { excludeIssueUid = null, user = null } = {}) {
  if (!Array.isArray(rawCards) || !rawCards.length) {
    throw Object.assign(new Error("Add at least one job card."), { status: 400 });
  }

  const jobCards = [];
  const flatCoils = [];
  const seenJc = new Set();
  const seenMachine = new Map();
  const seenCoil = new Set();
  const allowedRmCodes = new Set();
  let requestedQty = 0;
  let headerProdFields = null;

  const jcNos = [
    ...new Set(
      rawCards
        .map((r) => String(r?.pjobcardno || "").trim())
        .filter(Boolean)
        .map((v) => v.toUpperCase())
    ),
  ];
  const issuedRows = jcNos.length
    ? await findIssuedQtyByJobCards(jcNos, { excludeIssueUid })
    : [];
  const issuedByJc = new Map(
    (issuedRows || []).map((r) => [String(r.pjobcardno || "").toUpperCase(), Number(r.issued_qty) || 0])
  );
  const prodFieldsCache = new Map();

  for (const raw of rawCards) {
    const pjobcardno = String(raw?.pjobcardno || "").trim();
    if (!pjobcardno) {
      throw Object.assign(new Error("A job card number is required on every row."), { status: 400 });
    }
    const jcKey = pjobcardno.toUpperCase();
    if (seenJc.has(jcKey)) {
      throw Object.assign(new Error(`Job card ${pjobcardno} has been added more than once.`), { status: 400 });
    }
    seenJc.add(jcKey);

    const machine = String(raw?.macname || "").trim();
    const machineKey = machine.toUpperCase();
    if (machineKey && ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK) {
      const existingJc = seenMachine.get(machineKey);
      if (existingJc && existingJc !== jcKey) {
        throw Object.assign(
          new Error(
            `Machine ${machine} can only run one job card at a time. It is already assigned to another job card on this request.`
          ),
          { status: 400 }
        );
      }
      if (!existingJc) seenMachine.set(machineKey, jcKey);
    }

    const issue_qty = Number(raw?.issue_qty ?? raw?.requested_qty);
    if (!Number.isFinite(issue_qty) || issue_qty <= 0) {
      throw Object.assign(new Error(`Enter a valid issue quantity for job card ${pjobcardno}.`), {
        status: 400,
      });
    }
    const part_weight = Number(raw?.part_weight ?? 0) || 0;
    const rm_weight = Number(raw?.rm_weight ?? 0) || 0;
    const alreadyIssued = issuedByJc.get(jcKey) || 0;
    const remainingRm =
      rm_weight > 0 ? Math.max(0, Math.round((rm_weight - alreadyIssued) * 1000) / 1000) : null;
    if (remainingRm != null && remainingRm <= 0) {
      throw Object.assign(
        new Error(
          `Required RM weight (${rm_weight}) is already issued for job card ${pjobcardno}.` +
            (alreadyIssued > rm_weight
              ? ` Over by ${Math.round((alreadyIssued - rm_weight) * 1000) / 1000}.`
              : "")
        ),
        { status: 400 }
      );
    }
    const dispatchRaw = Number(raw?.dispatch_qty);
    const dispatch_qty =
      Number.isFinite(dispatchRaw) && dispatchRaw > 0
        ? dispatchRaw
        : remainingRm != null && issue_qty > remainingRm + 1e-9
          ? remainingRm
          : issue_qty;
    // Typed dispatch ≤ remaining required; issue_qty (coil total) may overshoot
    if (remainingRm != null && dispatch_qty > remainingRm + 1e-9) {
      throw Object.assign(
        new Error(
          `Dispatch qty cannot exceed required RM (${remainingRm}) for job card ${pjobcardno}.` +
            (alreadyIssued > 0 ? ` Already issued ${alreadyIssued} of ${rm_weight}.` : "")
        ),
        { status: 400 }
      );
    }

    const itemdcode = raw?.itemdcode ?? raw?.item_dcode;
    let prod;
    try {
      prod = await resolveProductionForItem({
        itemdcode,
        item_code: raw?.item_code,
      });
    } catch (e) {
      throw e;
    }
    if (!prod) {
      throw Object.assign(
        new Error(`No approved production to RM mapping exists for item ${raw?.item_code || itemdcode} on job card ${pjobcardno}.`),
        { status: 400 }
      );
    }
    const prodFields = await mergeProductionSnapshot(mapProductionFields(prod), prod, prodFieldsCache);
    const selectedRm = resolveRequestedRm(raw, prodFields);
    await assertRmSelectionAllowed(user, prodFields, selectedRm);

    for (const code of prodFields.rm_item_codes || []) {
      allowedRmCodes.add(String(code).trim());
    }
    if (!headerProdFields) headerProdFields = prodFields;

    const coilInputs = Array.isArray(raw?.coils) ? raw.coils : [];
    if (!coilInputs.length) {
      throw Object.assign(new Error(`Select coils for job card ${pjobcardno}.`), { status: 400 });
    }

    let allowedRmItemCodes = selectedRm.rm_item_code ? [selectedRm.rm_item_code] : null;
    if (!allowedRmItemCodes?.length) {
      const fromCoils = productionAllowedRmCodes(prod);
      allowedRmItemCodes = fromCoils.length ? fromCoils : null;
    }

    let resolved;
    try {
      resolved = await resolveCoils(coilInputs, { allowedRmItemCodes });
    } catch (e) {
      throw e;
    }

    for (const c of resolved) {
      const key = String(c.coil_no_uid).toLowerCase();
      if (seenCoil.has(key)) {
        throw Object.assign(new Error(`Coil ${c.coil_no_uid} is used on more than one job card.`), { status: 400 });
      }
      seenCoil.add(key);
      flatCoils.push({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        pjobcardno,
      });
    }

    const coilQty = resolved.reduce((s, c) => s + (Number(c.qty) || 0), 0);
    if (coilQty > 0 && Math.abs(coilQty - issue_qty) > 0.001) {
      throw Object.assign(
        new Error(`Issue quantity must match the selected coil total for job card ${pjobcardno}.`),
        { status: 400 }
      );
    }
    requestedQty += issue_qty;
    const rmFields = {
      rm_item_dcode: selectedRm.rm_item_dcode,
      rm_item_code: selectedRm.rm_item_code,
      rm_item_desc: selectedRm.rm_item_desc,
    };
    const fifoStartMrnUid =
      isSuperAdminUser(user) &&
      raw?.fifo_start_mrn_uid != null &&
      String(raw.fifo_start_mrn_uid).trim() !== ""
        ? String(raw.fifo_start_mrn_uid).trim()
        : null;

    jobCards.push({
      pjobcardno,
      pldt: raw?.pldt ?? null,
      item_code: prodFields.item_code || null,
      itemdcode: prodFields.item_dcode || Number(itemdcode) || null,
      itemdesc: prodFields.item_desc || null,
      planqty: Number(raw?.planqty ?? raw?.plan_qty ?? 0) || 0,
      macname: raw?.macname || null,
      part_weight,
      rm_weight,
      dispatch_qty,
      issue_qty,
      production_id: prodFields.production_id,
      rm_item_dcode: rmFields.rm_item_dcode,
      rm_item_code: rmFields.rm_item_code,
      rm_item_desc: rmFields.rm_item_desc,
      fifo_start_mrn_uid: fifoStartMrnUid,
      coils: resolved.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        mrn_uid: c.mrn_uid ?? null,
        mrn_no: c.mrn_no ?? null,
      })),
    });
  }

  const lockConflicts = await findMachineJobCardLockConflicts(jobCards, { excludeIssueUid });
  if (lockConflicts[0]) {
    const hit = lockConflicts[0];
    throw Object.assign(
      new Error(
        `Machine ${hit.macname} is locked to job card ${hit.pjobcardno} on Issue Request #${hit.issue_uid}. Authorize Store Out for that job card before assigning another job card to this machine.`
      ),
      { status: 400 }
    );
  }

  return {
    jobCards,
    flatCoils,
    requestedQty,
    headerProdFields: headerProdFields || {},
    allowedRmCodes,
  };
}

export const getProductionMapping = async (req, res) => {
  try {
    const itemdcode = req.body?.itemdcode ?? req.body?.item_dcode ?? null;
    const item_code = req.body?.item_code ?? req.body?.itemcode ?? null;
    const prod = await resolveProductionForItem({ itemdcode, item_code });
    if (!prod) {
      return res.status(404).json({
        success: false,
        message: `No production-to-RM mapping exists for item ${item_code || itemdcode || "—"}. Map it in the Production master first.`,
      });
    }
    return res.json({ success: true, data: await mergeProductionSnapshot(mapProductionFields(prod), prod) });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

export const getIssueRequests = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "issue_uid",
      order: "DESC",
    });
    const result = await findIssueRequests({
      filters: sanitizeFilters(filters || {}, ["approved", "from_date", "to_date", "out_entry_locked", "out_entry_complete"]),
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

/** Job-card-wise list — one row per job card (like forwarding note item-wise). */
export const getIssueRequestJobCardRows = async (req, res) => {
  try {
    const { page, limit, filters, search } = extractListParams(req.body || {}, {
      sortBy: "issue_uid",
      order: "DESC",
    });
    const result = await findIssueRequestJobCardRows({
      filters: sanitizeFilters(filters || {}, ["approved", "from_date", "to_date", "out_entry_locked", "out_entry_complete"]),
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

export const getIssueRequestById = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const data = await findIssueRequest(id);
    if (!data) return res.status(404).json({ success: false, message: "Issue request not found." });
    const coils = await findIssueRequestCoils(id);
    const job_cards = await findIssueRequestJobCards(id);
    return res.json({ success: true, data: { ...data, coils, job_cards } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST body: { issue_uid, company_info? } — master slip HTML (works from Job Card Wise via issue_uid). */
export const printIssueRequest = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    }

    const data = await findIssueRequest(id);
    if (!data) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (!data.approved) {
      return res.status(409).json({
        success: false,
        message: "Approve the issue request before printing.",
      });
    }

    const job_cards = await findIssueRequestJobCards(id);
    const company_info = sanitizeIssueRequestPrintCompanyInfo(req.body?.company_info);
    const html = buildIssueRequestPrintDocument({ ...data, job_cards }, company_info);
    return res.json({
      success: true,
      html,
      print_title: `Issue Request · ${id}`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Already-issued totals per job card, so the form can show plan vs issued vs pending.
 * body: { job_cards: ["JC-1", ...] | [{ pjobcardno, planqty }], exclude_issue_uid }
 */
export const getJobCardIssueSummary = async (req, res) => {
  try {
    const raw = req.body?.job_cards ?? req.body?.pjobcardno;
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const requested = list
      .map((v) => (v && typeof v === "object" ? v : { pjobcardno: v }))
      .map((v) => ({
        pjobcardno: String(v?.pjobcardno ?? "").trim(),
        planqty: Number(v?.planqty ?? v?.plan_qty ?? 0) || 0,
      }))
      .filter((v) => v.pjobcardno)
      .slice(0, 200);

    if (!requested.length) {
      return res.status(400).json({ success: false, message: "At least one job card number is required." });
    }

    const excludeIssueUid = parsePositiveIntId(req.body?.exclude_issue_uid ?? req.body?.issue_uid);
    const rows = await findIssuedQtyByJobCards(
      requested.map((v) => v.pjobcardno),
      { excludeIssueUid }
    );
    const byKey = new Map(rows.map((r) => [String(r.pjobcardno || ""), r]));

    const data = requested.map(({ pjobcardno, planqty }) => {
      const hit = byKey.get(pjobcardno.toUpperCase());
      const issued_qty = round(hit?.issued_qty);
      const approved_qty = round(hit?.approved_qty);
      return {
        pjobcardno,
        plan_qty: planqty,
        issued_qty,
        approved_qty,
        unapproved_qty: round(issued_qty - approved_qty),
        pending_qty: planqty > 0 ? round(planqty - issued_qty) : 0,
        request_count: Number(hit?.request_count || 0),
        last_issue_uid: hit?.last_issue_uid ?? null,
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** FIFO coil pool minus reservations from other issue requests (IMS FN style). */
export const getAvailableCoils = async (req, res) => {
  try {
    const rm_item_code = req.body?.rm_item_code != null ? String(req.body.rm_item_code).trim() : "";
    const rm_item_dcode = parsePositiveIntId(req.body?.rm_item_dcode);
    const excludeIssueUid = parsePositiveIntId(req.body?.exclude_issue_uid ?? req.body?.issue_uid);

    if (!rm_item_code && !rm_item_dcode) {
      return res.status(400).json({ success: false, message: "RM item code or item_dcode is required." });
    }

    const result = await buildAvailableCoilsForIssue({
      rm_item_code: rm_item_code || null,
      rm_item_dcode: rm_item_dcode || null,
      excludeIssueUid,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Create Issue Request.
 * body: { shift, job_cards: [{ pjobcardno, itemdcode, planqty, issue_qty, coils: [...] }], remarks, approved }
 * Legacy: { production_id, requested_qty, coils } still accepted as single-row.
 */
export const createIssueRequest = async (req, res) => {
  try {
    const remarks = req.body?.remarks != null ? String(req.body.remarks).trim() : null;
    const shift = normalizeShift(req.body?.shift);
    const normalizedApproved = normalizeApprovedInput(req.body?.approved);
    const user = auditUserName(req);

    let built;
    if (Array.isArray(req.body?.job_cards) && req.body.job_cards.length) {
      try {
        built = await buildJobCardsPayload(req.body.job_cards, { user: req.user });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    } else {
      // Legacy single production_id path
      const production_id = parsePositiveIntId(req.body?.production_id);
      const requested_qty = Number(req.body?.requested_qty);
      const coilInputs = Array.isArray(req.body?.coils) ? req.body.coils : [];
      if (!production_id) {
        return res.status(400).json({ success: false, message: "Add at least one job card." });
      }
      if (!Number.isFinite(requested_qty) || requested_qty <= 0) {
        return res.status(400).json({ success: false, message: "Requested quantity must be greater than 0." });
      }
      if (!coilInputs.length) {
        return res.status(400).json({ success: false, message: "At least one coil is required." });
      }
      const prod = await findProduction({ production_id });
      if (!prod?.approved) {
        return res.status(400).json({ success: false, message: "Production mapping not found or not approved." });
      }
      const prodFields = mapProductionFields(prod);
      const allowedRmItemCodes = productionAllowedRmCodes(prod);
      let resolved;
      try {
        resolved = await resolveCoils(coilInputs, {
          allowedRmItemCodes: allowedRmItemCodes.length ? allowedRmItemCodes : null,
        });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      const rmFields = rmFieldsFromCoils(resolved, prodFields);
      built = {
        jobCards: [
          {
            pjobcardno: req.body?.pjobcardno || `PROD-${production_id}`,
            item_code: prodFields.item_code,
            itemdcode: prodFields.item_dcode,
            itemdesc: prodFields.item_desc,
            planqty: requested_qty,
            issue_qty: requested_qty,
            production_id: prodFields.production_id,
            rm_item_dcode: rmFields.rm_item_dcode,
            rm_item_code: rmFields.rm_item_code,
            rm_item_desc: rmFields.rm_item_desc,
            coils: resolved.map((c) => ({
              coil_no_uid: c.coil_no_uid,
              qty: c.qty,
            })),
          },
        ],
        flatCoils: resolved.map((c) => ({
          coil_no_uid: c.coil_no_uid,
          qty: c.qty,
        })),
        requestedQty: requested_qty,
      };
    }

    const coilUids = (built.flatCoils || []).map((c) => c.coil_no_uid);

    let row;
    try {
      row = await withTransaction(async (client) => {
        await lockCoilUidsForReserve(client, coilUids);
        await assertIssueRequestCoilsAvailable(built.jobCards, { client });

        const created = await insertIssueRequest(
          {
            requested_qty: 0,
            coil_count: built.flatCoils.length,
            shift,
            remarks,
            created_by: user,
          },
          { client }
        );

        await replaceIssueRequestJobCards(
          {
            issue_uid: created.issue_uid,
            jobCards: built.jobCards,
            userName: user,
          },
          { client }
        );

        if (normalizedApproved === true) {
          const fields = {};
          applyApprovalUpdateFields({
            req,
            fields,
            incomingApproved: true,
            hasBusinessChanges: false,
            alreadyApproved: false,
            auditAsName: true,
          });
          await updateIssueRequest(created.issue_uid, fields, { client });
        }

        return created;
      });
    } catch (e) {
      const status = e.status || e.statusCode;
      if (status === 400 || status === 403 || status === 409) {
        return res.status(status).json({ success: false, message: e.message });
      }
      throw e;
    }

    const data = await findIssueRequest(row.issue_uid);
    const coils = await findIssueRequestCoils(row.issue_uid);
    const job_cards = await findIssueRequestJobCards(row.issue_uid);
    log(req, "create", String(row.issue_uid), {
      issue_uid: row.issue_uid,
      job_card_count: job_cards?.length ?? 0,
      coil_count: coils?.length ?? 0,
      approved: data?.approved === true,
    }, data);
    return res.status(201).json({
      success: true,
      data: { ...data, coils, job_cards },
      toast_type: data?.approved ? "success" : "warning",
      message: data?.approved
        ? "Issue request authorized. Coils are reserved."
        : "Issue request saved. Coils are reserved.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400 || err?.statusCode === 409) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Update Issue Request (edit / approve).
 */
export const updateIssueRequestCtrl = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });

    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({
        success: false,
        message: "This issue request is locked for store out.",
      });
    }

    const editBlocked = assertWithinEditDays(req, existing.created_at, "edit");
    if (editBlocked) {
      return res.status(editBlocked.status).json({ success: false, message: editBlocked.message });
    }

    const user = auditUserName(req);
    const shift =
      req.body?.shift !== undefined ? normalizeShift(req.body.shift) : normalizeShift(existing.shift);

    let requested_qty = Number(existing.requested_qty);
    let coil_count = Number(existing.coil_count) || 0;
    let jobCards = await findIssueRequestJobCards(id);
    let coils = await findIssueRequestCoils(id);
    let jobCardsChanged = false;

    if (Array.isArray(req.body?.job_cards)) {
      let built;
      try {
        built = await buildJobCardsPayload(req.body.job_cards, { excludeIssueUid: id, user: req.user });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      if (!issueJobCardsEqual(jobCards, built.jobCards)) {
        requested_qty = built.requestedQty;
        coil_count = built.flatCoils.length;
        jobCards = built.jobCards;
        coils = built.flatCoils;
        jobCardsChanged = true;
      }
    } else if (Array.isArray(req.body?.coils)) {
      if (!req.body.coils.length) {
        return res.status(400).json({ success: false, message: "At least one coil is required." });
      }
      const jcRows = await findIssueRequestJobCards(id);
      const headerRm = jcRows[0] || {};
      let resolved;
      try {
        resolved = await resolveCoils(req.body.coils, {
          allowedRmItemCodes: headerRm.rm_item_code ? [headerRm.rm_item_code] : null,
        });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
      coil_count = resolved.length;
      coils = resolved.map((c) => ({
        coil_no_uid: c.coil_no_uid,
        qty: c.qty,
        pjobcardno: jcRows[0]?.pjobcardno || null,
      }));
      jobCardsChanged = true;
      jobCards = [
        {
          ...(jcRows[0] || {}),
          issue_qty: requested_qty,
          rm_item_code: headerRm.rm_item_code,
          rm_item_dcode: headerRm.rm_item_dcode,
          coils: resolved.map((c) => ({
            coil_no_uid: c.coil_no_uid,
            qty: c.qty,
            mrn_uid: c.mrn_uid ?? null,
            mrn_no: c.mrn_no ?? null,
          })),
        },
      ];
      if (req.body?.requested_qty != null) {
        requested_qty = Number(req.body.requested_qty);
        if (!Number.isFinite(requested_qty) || requested_qty <= 0) {
          return res.status(400).json({ success: false, message: "Requested quantity must be greater than 0." });
        }
        jobCards = jobCards.map((jc) => ({ ...jc, issue_qty: requested_qty }));
      }
    }

    const remarks =
      req.body?.remarks !== undefined
        ? req.body.remarks != null
          ? String(req.body.remarks).trim()
          : null
        : existing.remarks;

    const normalizedApproved =
      req.body?.approved !== undefined ? normalizeApprovedInput(req.body.approved) : undefined;

    const hasBusinessChanges =
      jobCardsChanged ||
      shift !== normalizeShift(existing.shift) ||
      Number(coil_count) !== Number(existing.coil_count) ||
      (req.body?.remarks !== undefined && String(remarks || "") !== String(existing.remarks || ""));

    const updateFields = {};
    if (hasBusinessChanges) {
      updateFields.coil_count = coil_count;
      updateFields.shift = shift;
      updateFields.remarks = remarks;
    }

    const approvalOnly = !hasBusinessChanges && normalizedApproved === true;

    if (normalizedApproved === undefined && !hasBusinessChanges) {
      const data = await findIssueRequest(id);
      const jcRows = await findIssueRequestJobCards(id);
      const coilRows = await findIssueRequestCoils(id);
      return res.json({
        success: true,
        data: { ...data, coils: coilRows, job_cards: jcRows },
        message: "No change",
      });
    }

    if (normalizedApproved !== undefined || hasBusinessChanges) {
      applyApprovalUpdateFields({
        req,
        fields: updateFields,
        incomingApproved: normalizedApproved,
        hasBusinessChanges,
        alreadyApproved: existing.approved === true,
        auditAsName: true,
      });
    }

    try {
      await withTransaction(async (client) => {
        if (jobCardsChanged) {
          const coilUids = (coils || []).map((c) => c.coil_no_uid);
          await lockCoilUidsForReserve(client, coilUids);
          await assertIssueRequestCoilsAvailable(jobCards, {
            excludeIssueUid: id,
            client,
          });
        }

        await updateIssueRequest(id, updateFields, { client });
        if (jobCardsChanged) {
          await replaceIssueRequestJobCards(
            {
              issue_uid: id,
              jobCards,
              userName: user,
            },
            { client }
          );
        }
      });
    } catch (e) {
      const status = e.status || e.statusCode;
      if (status === 400 || status === 403 || status === 409) {
        return res.status(status).json({ success: false, message: e.message });
      }
      throw e;
    }

    const data = await findIssueRequest(id);
    const coilRows = coils?.length ? coils : await findIssueRequestCoils(id);
    const jcRows = await findIssueRequestJobCards(id);
    log(req, data?.approved ? "approve" : "update", String(id), {
      issue_uid: id,
      job_card_count: jcRows?.length ?? 0,
      coil_count: coilRows?.length ?? 0,
      approved: data?.approved === true,
      approval_only: approvalOnly,
    }, data);
    return res.json({
      success: true,
      data: { ...data, coils: coilRows, job_cards: jcRows },
      toast_type: data?.approved ? "success" : "warning",
      message: data?.approved
        ? "Issue request authorized. Coils are reserved."
        : jobCardsChanged
          ? "Issue request updated. Coils are reserved."
          : "Issue request updated. Pending authorization.",
    });
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 400 || err?.statusCode === 409) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteIssueRequest = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({
        success: false,
        message: "This issue request is locked for store out.",
      });
    }
    await softDeleteIssueRequest(id, auditUserName(req));
    log(req, "delete", String(id), {
      issue_uid: id,
      job_card_count: Number(existing.job_card_count || 0),
      coil_count: Number(existing.coil_count || 0),
      approved: existing.approved === true,
    }, existing);
    return res.json({
      success: true,
      message: "Issue request deleted. Coil reserve released.",
    });
  } catch (err) {
    if (err?.statusCode === 409) {
      return res.status(409).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const lockIssueRequestForStoreOut = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    if (existing.out_entry_locked) {
      return res.status(409).json({ success: false, message: "This issue request is already locked." });
    }
    const locked = await applyIssueRequestStoreOutLock({ issue_uid: id, userName: auditUserName(req) });
    if (!locked) return res.status(404).json({ success: false, message: "Not found" });
    log(req, "lock_store_out", String(id), {
      issue_uid: id,
      out_entry_locked: true,
    }, locked);
    return res.json({
      success: true,
      message: "Issue request locked successfully.",
      data: locked,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const unlockIssueRequestForStoreOut = async (req, res) => {
  try {
    const id = parsePositiveIntId(req.body?.issue_uid ?? req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "A valid issue request ID is required." });
    const existing = await findIssueRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Issue request not found." });
    const unlocked = await applyIssueRequestStoreOutUnlock({ issue_uid: id });
    if (!unlocked) return res.status(404).json({ success: false, message: "Not found" });
    log(req, "unlock_store_out", String(id), {
      issue_uid: id,
      out_entry_locked: false,
    }, unlocked);
    return res.json({
      success: true,
      message: "Issue request unlocked successfully.",
      data: unlocked,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
