/**
 * Plan APIs — Board / Calendar / Table / manpower.
 * Controllers only: read body → call model → return JSON.
 */
import { getImsMapsSafe } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { fetchEmpMaster, filterEmployeesLocal, sortEmployeesLocal } from "../../../../hrms/lib/erpApi.js";
import { toEmployeePickerRow } from "../../../../hrms/lib/config/views/employeeHelperViews.js";
import { deletePlanLine, findPlanLine, reorderMachinePlanQueue, updatePlanLine } from "../models/plan.model.js";
import { getShiftOp, listActiveShiftCodes, listShiftOps, appendShiftOpSegment, deleteShiftOpSegments, updateShiftOpSegment, isShiftActiveOnDate } from "../models/planManpower.model.js";
import { attachPlanLineEstimates, enrichPlanRows, listPlanningTableRows } from "./plan.controller.helpers.js";

function positiveId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function currentUser(req) {
  return auditUserName(req) || "System";
}

/** POST /plan/table */
export async function getPlanningTable(req, res) {
  try {
    const body = req.body || {};
    const filters = body.filters && typeof body.filters === "object" ? body.filters : body;
    const data = await listPlanningTableRows(null, {
      from_date: filters.from_date || filters.fromDate || "",
      to_date: filters.to_date || filters.toDate || "",
    });
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load planning table." });
  }
}

/** POST /plan/get */
export async function getPlanningLine(req, res) {
  try {
    const docno = positiveId(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const row = await findPlanLine(docno);
    if (!row) return res.status(404).json({ success: false, message: "Plan line not found." });

    const { itemMap } = await getImsMapsSafe();
    const [data] = await attachPlanLineEstimates(enrichPlanRows([row], itemMap));
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load plan line." });
  }
}

/** POST /plan/update */
export async function updatePlanningLine(req, res) {
  try {
    const docno = positiveId(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findPlanLine(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Plan line not found." });

    const data = await updatePlanLine(docno, {
      mp_start: req.body?.mp_start,
      mp_end: req.body?.mp_end,
      status: req.body?.status,
      maccode: req.body?.maccode,
      updated_by: currentUser(req),
    });
    return res.json({ success: true, message: "Plan line updated.", data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to update plan line." });
  }
}

/**
 * POST /plan/reorder — same-machine JC up/down.
 * Body: { maccode, ordered_docnos: [planDocno…] }
 * Running on that machine → 409 (Hold first).
 */
export async function reorderPlanningQueue(req, res) {
  try {
    const maccode = positiveId(req.body?.maccode ?? req.body?.machine_id);
    const ordered = req.body?.ordered_docnos || req.body?.orderedDocnos || req.body?.docnos || [];
    const data = await reorderMachinePlanQueue({
      maccode,
      orderedDocnos: Array.isArray(ordered) ? ordered : [],
      by: currentUser(req),
    });
    return res.json({ success: true, message: "Queue order updated.", data });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to reorder queue." });
  }
}

/** POST /plan/delete */
export async function deletePlanningLine(req, res) {
  try {
    const docno = positiveId(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const deleted = await deletePlanLine(docno, currentUser(req));
    if (!deleted) return res.status(404).json({ success: false, message: "Plan line not found." });

    const label = [deleted.pjobcardno, deleted.process_name, deleted.machine_name].filter(Boolean).join(" · ");
    const prev = deleted.reopened_stage;
    const message =
      prev != null
        ? `Plan line removed (${label}). Job card back on stage ${prev} (Pending) on Board.`
        : `Plan line removed (${label}).`;

    return res.json({ success: true, message, data: { docno, reopened_stage: prev ?? null } });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to delete plan line." });
  }
}

/** POST /plan/shifts */
export async function getPlanningShifts(_req, res) {
  try {
    const data = await listActiveShiftCodes();
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load shifts." });
  }
}

/** POST /plan/shift-op/get — one cell OR date range list */
export async function getPlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const fromDate = String(body.from_date || body.fromDate || "").slice(0, 10);
    const toDate = String(body.to_date || body.toDate || "").slice(0, 10);

    if (fromDate || toDate) {
      const data = await listShiftOps({
        from_date: fromDate || null,
        to_date: toDate || null,
        maccode: positiveId(body.maccode ?? body.machine_id),
      });
      return res.json({ success: true, data });
    }

    const maccode = positiveId(body.maccode ?? body.machine_id);
    const date = String(body.date || body.plan_date || "").slice(0, 10);
    const shift = Number(body.shift ?? body.shift_no);
    if (!maccode || !date || !(shift >= 1)) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }

    const data = await getShiftOp(maccode, date, shift);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load operator." });
  }
}

/** POST /plan/shift-op/save — one slot or many slots */
export async function savePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = positiveId(body.maccode ?? body.machine_id);
    const empCode = String(body.emp_code || "").trim();
    const empName = body.emp_name;
    const user = currentUser(req);
    const shifts = await listActiveShiftCodes();

    function isShiftOk(date, shiftNo) {
      const meta = shifts.find((s) => Number(s.id) === Number(shiftNo));
      return !!(meta && isShiftActiveOnDate(meta, date));
    }

    // Bulk save: body.slots = [{ date, shift }, ...]
    if (Array.isArray(body.slots)) {
      if (!maccode || !empCode || !body.slots.length) {
        return res.status(400).json({ success: false, message: "maccode, emp_code, slots required." });
      }

      const slots = body.slots
        .map((s) => ({
          date: String(s?.date || s?.plan_date || "").slice(0, 10),
          shift: Number(s?.shift ?? s?.shift_no),
        }))
        .filter((s) => s.date && s.shift >= 1)
        .sort((a, b) => a.date.localeCompare(b.date) || a.shift - b.shift);

      const data = [];
      for (const slot of slots) {
        if (!isShiftOk(slot.date, slot.shift)) {
          return res.status(400).json({
            success: false,
            message: `Shift ${slot.shift} is not active on ${slot.date}.`,
          });
        }
        data.push(
          await appendShiftOpSegment({
            maccode,
            plan_date: slot.date,
            shift_no: slot.shift,
            emp_code: empCode,
            emp_name: empName,
            created_by: user,
          })
        );
      }
      return res.json({ success: true, message: `Saved ${data.length} slot(s).`, data });
    }

    // Single slot
    const planDate = String(body.date || body.plan_date || "").slice(0, 10);
    const shiftNo = Number(body.shift ?? body.shift_no);
    if (!maccode || !planDate || !(shiftNo >= 1) || !empCode) {
      return res.status(400).json({ success: false, message: "maccode, date, shift, emp_code required." });
    }
    if (!isShiftOk(planDate, shiftNo)) {
      return res.status(400).json({
        success: false,
        message: `Shift ${shiftNo} is not active on ${planDate}.`,
      });
    }

    const data = await appendShiftOpSegment({
      maccode,
      plan_date: planDate,
      shift_no: shiftNo,
      emp_code: empCode,
      emp_name: empName,
      created_by: user,
    });
    return res.json({ success: true, message: "Manpower saved.", data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to save manpower." });
  }
}

/** POST /plan/shift-op/delete */
export async function deletePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = positiveId(body.maccode ?? body.machine_id);
    const planDate = String(body.date || body.plan_date || "").slice(0, 10);
    const shiftNo = Number(body.shift ?? body.shift_no);

    if (!maccode || !planDate || !(shiftNo >= 1)) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }

    /** Always clear whole cell — partial id delete left broken multi-JC / operator state. */
    const data = await deleteShiftOpSegments({
      maccode,
      plan_date: planDate,
      shift_no: shiftNo,
    });
    if (!data?.length) {
      return res.status(404).json({ success: false, message: "No manpower found to remove." });
    }

    return res.json({
      success: true,
      message: "Shift manpower cleared.",
      data,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to remove manpower." });
  }
}

/** POST /plan/shift-op/update */
export async function updatePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = positiveId(body.maccode ?? body.machine_id);
    const planDate = String(body.date || body.plan_date || "").slice(0, 10);
    const shiftNo = Number(body.shift ?? body.shift_no);
    const empCode = String(body.emp_code || "").trim();
    const empName = body.emp_name != null ? String(body.emp_name).trim() : null;
    const user = currentUser(req);

    if (!maccode || !planDate || !(shiftNo >= 1)) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }
    if (!empCode) {
      return res.status(400).json({ success: false, message: "emp_code required." });
    }

    const id = positiveId(body.id ?? body.i);
    if (id) {
      const data = await updateShiftOpSegment({
        id,
        emp_code: empCode,
        emp_name: empName,
        updated_by: user,
      });
      if (!data) return res.status(404).json({ success: false, message: "Manpower row not found." });
      return res.json({ success: true, message: "Manpower updated.", data });
    }

    // No id → replace whole cell
    const removed = await deleteShiftOpSegments({ maccode, plan_date: planDate, shift_no: shiftNo });
    if (!removed?.length) {
      return res.status(404).json({ success: false, message: "No manpower found to update." });
    }
    const data = await appendShiftOpSegment({
      maccode,
      plan_date: planDate,
      shift_no: shiftNo,
      emp_code: empCode,
      emp_name: empName,
      created_by: user,
    });
    return res.json({ success: true, message: "Manpower updated.", data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to update manpower." });
  }
}

/** POST /plan/employees/helper — employee picker */
export async function getPlanningEmployeesHelper(req, res) {
  try {
    const body = req.body || {};
    const empCode = String(body.emp_code ?? body.id ?? "").trim();
    const allEmps = await fetchEmpMaster({});

    if (empCode) {
      const hit = allEmps.find(
        (r) => String(r.emp_code) === empCode || String(r.emp_dcode) === empCode
      );
      return res.json({ success: true, data: hit ? toEmployeePickerRow(hit) : null });
    }

    const { page, limit, search } = extractListParams(body);
    const preferredDept = String(body.deptname || body.preferred_dept || "").trim().toLowerCase();
    const pageNo = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 40));

    let list = sortEmployeesLocal(filterEmployeesLocal(allEmps, { search }), "emp_code", "ASC");
    if (preferredDept) {
      list = [...list].sort((a, b) => {
        const aMatch = String(a.deptname || "").trim().toLowerCase() === preferredDept ? 0 : 1;
        const bMatch = String(b.deptname || "").trim().toLowerCase() === preferredDept ? 0 : 1;
        return aMatch - bMatch || String(a.emp_code || "").localeCompare(String(b.emp_code || ""));
      });
    }

    const start = (pageNo - 1) * pageSize;
    return res.json({
      success: true,
      data: list.slice(start, start + pageSize).map(toEmployeePickerRow),
      total: list.length,
      page: pageNo,
      limit: pageSize,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load employees." });
  }
}
