/**
 * Production Planning — reads/writes prod_plan only (Board / Calendar / Table).
 * prod_jc is written only from Maintain Job Card (process / machine / stage at JC save).
 */
import { getImsMapsSafe } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { fetchEmpMaster, filterEmployeesLocal, sortEmployeesLocal } from "../../../../hrms/lib/erpApi.js";
import { toEmployeePickerRow } from "../../../../hrms/lib/config/views/employeeHelperViews.js";
import { deletePlanLine, findPlanLine, updatePlanLine } from "../models/plan.model.js";
import { getShiftOp, listActiveShiftCodes, listShiftOps, appendShiftOpSegment, deleteShiftOpSegments, updateShiftOpSegment } from "../models/planManpower.model.js";
import { attachPlanLineEstimates, enrichPlanRows, listPlanningTableRows } from "./plan.controller.helpers.js";

function toDocno(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** POST /plan/table — plan lines + joins; optional IMS date filters { from_date, to_date } on plan_start */
export async function getPlanningTable(req, res) {
  try {
    const body = req.body || {};
    const filters = body.filters && typeof body.filters === "object" ? body.filters : body;
    const from_date = filters.from_date || filters.fromDate || "";
    const to_date = filters.to_date || filters.toDate || "";
    const data = await listPlanningTableRows(null, { from_date, to_date });
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load planning table." });
  }
}

/** POST /plan/get — body { docno } — one prod_plan row + joins */
export async function getPlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
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

/** POST /plan/update — body { docno, plan_start?, plan_end?, status?, maccode? } — prod_plan only */
export async function updatePlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const existing = await findPlanLine(docno);
    if (!existing) return res.status(404).json({ success: false, message: "Plan line not found." });

    const updated = await updatePlanLine(docno, {
      plan_start: req.body?.plan_start,
      plan_end: req.body?.plan_end,
      status: req.body?.status,
      maccode: req.body?.maccode,
    });
    return res.json({ success: true, message: "Plan line updated.", data: updated });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to update plan line." });
  }
}

/** POST /plan/delete — body { docno } — remove one prod_plan row */
export async function deletePlanningLine(req, res) {
  try {
    const docno = toDocno(req.body?.docno ?? req.body?.id);
    if (!docno) return res.status(400).json({ success: false, message: "docno is required." });

    const deleted = await deletePlanLine(docno);
    if (!deleted) return res.status(404).json({ success: false, message: "Plan line not found." });

    const label = [deleted.pjobcardno, deleted.process_name, deleted.machine_name].filter(Boolean).join(" · ");
    const prev = deleted.reopened_stage;
    const message =
      prev != null
        ? `Plan line removed (${label}). Job card back on stage ${prev} (Pending) on Board.`
        : `Plan line removed (${label}).`;
    return res.json({
      success: true,
      message,
      data: { docno, reopened_stage: prev ?? null },
    });
  } catch (err) {
    const code = Number(err.statusCode) || 500;
    return res.status(code).json({ success: false, message: err.message || "Failed to delete plan line." });
  }
}

/** POST /plan/shifts — Settings → active shift codes for calendar. */
export async function getPlanningShifts(_req, res) {
  try {
    const data = await listActiveShiftCodes();
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load shifts." });
  }
}

/** POST /plan/shift-op/get — { maccode, date, shift } OR list { from_date, to_date, maccode? } */
export async function getPlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const from_date = String(body.from_date || body.fromDate || "").slice(0, 10);
    const to_date = String(body.to_date || body.toDate || "").slice(0, 10);
    if (from_date || to_date) {
      const maccode = toDocno(body.maccode ?? body.machine_id);
      const data = await listShiftOps({ from_date: from_date || null, to_date: to_date || null, maccode });
      return res.json({ success: true, data });
    }
    const maccode = toDocno(body.maccode ?? body.machine_id);
    const date = String(body.date || body.plan_date || "").slice(0, 10);
    const shift = Number(body.shift ?? body.shift_no);
    if (!maccode || !date || !Number.isFinite(shift) || shift < 1) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }
    const data = await getShiftOp(maccode, date, shift);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load operator." });
  }
}

/** POST /plan/shift-op/save — machine+shift manpower (no JC; live from board). */
export async function savePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = toDocno(body.maccode ?? body.machine_id);
    const emp_code = String(body.emp_code || "").trim();
    const emp_name = body.emp_name;
    const slots = Array.isArray(body.slots) ? body.slots : null;

    if (slots) {
      if (!maccode || !emp_code || !slots.length) {
        return res.status(400).json({ success: false, message: "maccode, emp_code, slots required." });
      }
      const data = [];
      for (const s of slots) {
        const plan_date = String(s?.date || s?.plan_date || "").slice(0, 10);
        const shift_no = Number(s?.shift ?? s?.shift_no);
        if (!plan_date || !Number.isFinite(shift_no) || shift_no < 1) continue;
        const hu = Number(s?.hours_used ?? s?.hours);
        data.push(
          await appendShiftOpSegment({
            maccode,
            plan_date,
            shift_no,
            emp_code,
            emp_name,
            hours_used: Number.isFinite(hu) && hu > 0 ? hu : null,
          })
        );
      }
      if (!data.length) return res.status(400).json({ success: false, message: "No valid slots." });
      return res.json({ success: true, message: `Manpower saved · ${data.length} slot(s).`, data });
    }

    const plan_date = String(body.date || body.plan_date || "").slice(0, 10);
    const shift_no = Number(body.shift ?? body.shift_no);
    if (!maccode || !plan_date || !Number.isFinite(shift_no) || shift_no < 1 || !emp_code) {
      return res.status(400).json({ success: false, message: "maccode, date, shift, emp_code required." });
    }
    const hu = Number(body.hours_used ?? body.hours);
    const data = await appendShiftOpSegment({
      maccode,
      plan_date,
      shift_no,
      emp_code,
      emp_name,
      hours_used: Number.isFinite(hu) && hu > 0 ? hu : null,
    });
    return res.json({ success: true, message: "Manpower saved.", data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to save manpower." });
  }
}

/** POST /plan/shift-op/delete — { maccode, date, shift, id? } */
export async function deletePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = toDocno(body.maccode ?? body.machine_id);
    const plan_date = String(body.date || body.plan_date || "").slice(0, 10);
    const shift_no = Number(body.shift ?? body.shift_no);
    const id = toDocno(body.id ?? body.i);
    if (!maccode || !plan_date || !Number.isFinite(shift_no) || shift_no < 1) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }
    const data = await deleteShiftOpSegments({ maccode, plan_date, shift_no, id });
    if (!data?.length) {
      return res.status(404).json({ success: false, message: "No manpower found to remove." });
    }
    const one = data[0];
    return res.json({
      success: true,
      message:
        data.length === 1
          ? `Removed manpower${one.h != null ? ` (${one.h}h)` : ""}.`
          : `Removed ${data.length} manpower segment(s).`,
      data,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to remove manpower." });
  }
}

/**
 * POST /plan/shift-op/update — operators / hours on one row.
 * Body: { maccode, date, shift, emp_code, emp_name, hours_used?, id? }
 */
export async function updatePlanningShiftOp(req, res) {
  try {
    const body = req.body || {};
    const maccode = toDocno(body.maccode ?? body.machine_id);
    const plan_date = String(body.date || body.plan_date || "").slice(0, 10);
    const shift_no = Number(body.shift ?? body.shift_no);
    const emp_code = String(body.emp_code || "").trim();
    const emp_name = body.emp_name != null ? String(body.emp_name).trim() : null;
    const id = toDocno(body.id ?? body.i);
    const hu = Number(body.hours_used ?? body.hours);
    if (!maccode || !plan_date || !Number.isFinite(shift_no) || shift_no < 1) {
      return res.status(400).json({ success: false, message: "maccode, date, shift required." });
    }
    if (!emp_code) {
      return res.status(400).json({ success: false, message: "emp_code required." });
    }

    if (id) {
      const data = await updateShiftOpSegment({
        id,
        emp_code,
        emp_name,
        hours_used: Number.isFinite(hu) && hu > 0 ? hu : null,
      });
      if (!data) return res.status(404).json({ success: false, message: "Manpower row not found." });
      return res.json({ success: true, message: "Manpower updated.", data });
    }

    const removed = await deleteShiftOpSegments({ maccode, plan_date, shift_no });
    if (!removed?.length) {
      return res.status(404).json({ success: false, message: "No manpower found to update." });
    }
    let hours = Number.isFinite(hu) && hu > 0 ? hu : null;
    if (!(hours > 0)) {
      hours = removed.reduce((n, r) => n + (Number(r.h) > 0 ? Number(r.h) : 0), 0);
      if (!(hours > 0)) hours = null;
    }
    const data = await appendShiftOpSegment({
      maccode,
      plan_date,
      shift_no,
      emp_code,
      emp_name,
      hours_used: hours,
    });
    return res.json({ success: true, message: "Manpower updated.", data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to update manpower." });
  }
}

/** POST /plan/employees/helper — HRMS emp master picker (planning permission). */
export async function getPlanningEmployeesHelper(req, res) {
  try {
    const body = req.body || {};
    const empCode = String(body.emp_code ?? body.id ?? "").trim();
    const mapped = await fetchEmpMaster({});
    if (empCode) {
      const hit = mapped.find((r) => String(r.emp_code) === empCode || String(r.emp_dcode) === empCode);
      return res.json({ success: true, data: hit ? toEmployeePickerRow(hit) : null });
    }
    const { page, limit, search } = extractListParams(body);
    const preferredDept = String(body.deptname || body.preferred_dept || "").trim().toLowerCase();
    const p = Math.max(1, Number(page) || 1);
    const n = Math.min(100, Math.max(1, Number(limit) || 40));
    const filtered = filterEmployeesLocal(mapped, { search });
    const sorted = sortEmployeesLocal(filtered, "emp_code", "ASC");
    const ordered = preferredDept
      ? [...sorted].sort((a, b) => {
          const am = String(a.deptname || "").trim().toLowerCase() === preferredDept ? 0 : 1;
          const bm = String(b.deptname || "").trim().toLowerCase() === preferredDept ? 0 : 1;
          return am - bm || String(a.emp_code || "").localeCompare(String(b.emp_code || ""));
        })
      : sorted;
    const start = (p - 1) * n;
    return res.json({
      success: true,
      data: ordered.slice(start, start + n).map(toEmployeePickerRow),
      total: ordered.length,
      page: p,
      limit: n,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load employees." });
  }
}
