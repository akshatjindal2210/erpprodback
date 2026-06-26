import { listSchedulePlanning, listScheduleActionDates, saveSchedulePlan, rejectSchedulePlan, holdSchedulePlan, listScheduleItemTransactions, removeSchedulePlan } from "../utils/schedule-planning/schedulePlanService.js";
import { clearImsMetaForResponse, toPublicImsMessage } from "../utils/erp-api/imsMeta.js";

// Sends a simple JSON response
function sendSimple(res, { success, message, data, status = 200, extra = {} }) {
  clearImsMetaForResponse();
  const body = { success, data };
  const raw = message != null ? String(message).trim() : "";
  if (raw) {
    body.message = success ? raw : toPublicImsMessage(raw, "Request failed.");
  } else if (!success) {
    body.message = "Request failed.";
  }
  return res.status(status).json({ ...body, ...extra });
}

export const getSchedulePlanning = async (req, res) => {
  try {
    const out = await listSchedulePlanning(req.body || {});
    if (out?.success === false && out?.status === 400 && out?.message?.includes("fin_year_id")) {
      return sendSimple(res, { success: false, message: out.message, data: [] });
    }
    const data = Array.isArray(out?.records) ? out.records : [];
    return sendSimple(res, {
      success: out?.success !== false,
      message: out?.success !== false ? out?.message : (out?.message || "Could not load schedule data."),
      data,
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not load schedule data.", data: [] });
  }
};

export const getScheduleActionDates = async (req, res) => {
  try {
    const out = await listScheduleActionDates(req.body || {});
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message,
        data: { action_dates: [], reject_reasons: [] },
        status: out.status || 400,
        extra: { reasons: [] },
      });
    }
    const payload = out.data && typeof out.data === "object" && !Array.isArray(out.data)
      ? out.data
      : { action_dates: Array.isArray(out.data) ? out.data : [], reject_reasons: out.reasons ?? [] };
    const reasons = Array.isArray(out.reasons) ? out.reasons : (payload.reject_reasons ?? []);
    return sendSimple(res, {
      success: true,
      data: payload,
      extra: { reasons },
    });
  } catch {
    return sendSimple(res, {
      success: false,
      message: "Could not load action dates.",
      data: { action_dates: [], reject_reasons: [] },
      extra: { reasons: [] },
    });
  }
};

export const saveSchedulePlanning = async (req, res) => {
  try {
    const out = await saveSchedulePlan(req.body || {}, req.user?.id ?? null);
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message || "Could not save schedule plan.",
        data: null,
        status: out.status || 400,
      });
    }
    return sendSimple(res, {
      success: true,
      message: out.message || "Schedule plan saved.",
      data: out.data ?? null,
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not save schedule plan.", data: null, status: 500 });
  }
};

export const rejectSchedulePlanning = async (req, res) => {
  try {
    const out = await rejectSchedulePlan(req.body || {}, req.user?.id ?? null);
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message || "Could not reject schedule.",
        data: null,
        status: out.status || 400,
      });
    }
    return sendSimple(res, {
      success: true,
      message: out.message || "Schedule rejected.",
      data: out.data ?? null,
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not reject schedule.", data: null, status: 500 });
  }
};

export const holdSchedulePlanning = async (req, res) => {
  try {
    const out = await holdSchedulePlan(req.body || {}, req.user?.id ?? null);
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message || "Could not hold schedule.",
        data: null,
        status: out.status || 400,
      });
    }
    return sendSimple(res, {
      success: true,
      message: out.message || "Schedule put on hold.",
      data: out.data ?? null,
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not hold schedule.", data: null, status: 500 });
  }
};

export const getScheduleItemTransactions = async (req, res) => {
  try {
    const out = await listScheduleItemTransactions(req.body || {});
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message || "Could not load transaction history.",
        data: [],
        status: out.status || 400,
      });
    }
    return sendSimple(res, {
      success: true,
      data: Array.isArray(out.data) ? out.data : [],
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not load transaction history.", data: [], status: 500 });
  }
};

export const submitScheduleShortagePlanning = async (req, res) => {
  try {
    const body = req.body || {};
    const shortageQty = Number(body.shortage_qty);
    if (!Number.isFinite(shortageQty) || shortageQty < 0) {
      return sendSimple(res, {
        success: false,
        message: "Enter a valid shortage quantity.",
        data: null,
        status: 400,
      });
    }
    console.log("[schedule-planning] shortage", JSON.stringify({ ...body, shortage_qty: shortageQty, user_id: req.user?.id ?? null }, null, 2));
    return sendSimple(res, {
      success: true,
      message: "Shortage submitted successfully.",
      data: null,
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not submit shortage.", data: null, status: 500 });
  }
};

export const deleteSchedulePlanning = async (req, res) => {
  try {
    const out = await removeSchedulePlan(req.body || {});
    if (out?.success === false) {
      return sendSimple(res, {
        success: false,
        message: out.message || "Could not delete schedule plan.",
        data: null,
        status: out.status || 400,
      });
    }
    return sendSimple(res, {
      success: true,
      message: out.message || "Schedule plan deleted.",
      data: null,
      extra: out.deleted_count != null ? { deleted_count: out.deleted_count } : {},
    });
  } catch {
    return sendSimple(res, { success: false, message: "Could not delete schedule plan.", data: null, status: 500 });
  }
};
