/**
 * ims_schedule_plan.is_planned codes.
 *
 * 0 = Pending (IMS default / not yet authorized)
 * 7 = Ready to Dispatch (approve step)
 * 1 = Planned … 6 = Hold (unchanged)
 */
export const SCHEDULE_PLAN_STATUS = {
  PENDING: 0,
  PLANNED: 1,
  RUNNING: 2,
  COMPLETE: 3,
  REJECT: 4,
  DELETE: 5,
  HOLD: 6,
  READY_TO_DISPATCH: 7,
};

export const SCHEDULE_PLAN_STATUS_LABEL = {
  0: "Pending",
  1: "Planned",
  2: "Running",
  3: "Complete",
  4: "Reject",
  6: "Hold",
  7: "Ready to Dispatch",
};

export const SCHEDULE_PLAN_ACTION = {
  PLAN: "plan",
  READY: "ready", // authorize → Ready to Dispatch (7)
  HOLD: "hold",
  REJECT: "reject",
  COMPLETE: "complete",
  SHORTAGE: "shortage",
};

export const SCHEDULE_LIST_FILTER = {
  ALL: "all",
  PENDING: "pending",
  READY_TO_DISPATCH: "ready_to_dispatch",
  /** Approve + Sales default queue */
  PENDING_HOLD_REJECT: "pending_hold_reject",
  HOLD: "hold",
  PLAN: "plan",
  REJECT: "reject",
  COMPLETE: "complete",
  COMPARISON: "comparison",
};

export const SCHEDULE_REPORT_FILTER = {
  DEFAULT: "default",
  CUSTOM: "custom",
};

/**
 * Pending → Ready / Hold / Reject (approve).
 * Ready → Planned (add) / Hold / Reject.
 */
export const SCHEDULE_PLAN_TRANSITIONS = {
  [SCHEDULE_PLAN_STATUS.PENDING]: [
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.HOLD,
  ],
  [SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH]: [
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.HOLD,
  ],
  [SCHEDULE_PLAN_STATUS.PLANNED]: [
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.HOLD,
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
  ],
  [SCHEDULE_PLAN_STATUS.RUNNING]: [
    SCHEDULE_PLAN_STATUS.COMPLETE,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.HOLD,
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
  ],
  [SCHEDULE_PLAN_STATUS.REJECT]: [
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.HOLD,
    SCHEDULE_PLAN_STATUS.PENDING,
  ],
  [SCHEDULE_PLAN_STATUS.HOLD]: [
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.PENDING,
  ],
};

export function parseListFilter(raw) {
  const s = String(raw ?? SCHEDULE_LIST_FILTER.READY_TO_DISPATCH).toLowerCase().trim();
  const map = {
    pending: SCHEDULE_LIST_FILTER.PENDING,
    "0": SCHEDULE_LIST_FILTER.PENDING,
    ready_to_dispatch: SCHEDULE_LIST_FILTER.READY_TO_DISPATCH,
    ready: SCHEDULE_LIST_FILTER.READY_TO_DISPATCH,
    "7": SCHEDULE_LIST_FILTER.READY_TO_DISPATCH,
    pending_hold_reject: SCHEDULE_LIST_FILTER.PENDING_HOLD_REJECT,
    ready_hold_reject: SCHEDULE_LIST_FILTER.PENDING_HOLD_REJECT,
    schedule: SCHEDULE_LIST_FILTER.PLAN,
    planned: SCHEDULE_LIST_FILTER.PLAN,
    plan: SCHEDULE_LIST_FILTER.PLAN,
    running: SCHEDULE_LIST_FILTER.PLAN,
    "1": SCHEDULE_LIST_FILTER.PLAN,
    "2": SCHEDULE_LIST_FILTER.PLAN,
    complete: SCHEDULE_LIST_FILTER.COMPLETE,
    completed: SCHEDULE_LIST_FILTER.COMPLETE,
    "3": SCHEDULE_LIST_FILTER.COMPLETE,
    comparison: SCHEDULE_LIST_FILTER.COMPARISON,
    compare: SCHEDULE_LIST_FILTER.COMPARISON,
    all: SCHEDULE_LIST_FILTER.ALL,
    reject: SCHEDULE_LIST_FILTER.REJECT,
    rejected: SCHEDULE_LIST_FILTER.REJECT,
    "4": SCHEDULE_LIST_FILTER.REJECT,
    hold: SCHEDULE_LIST_FILTER.HOLD,
    "6": SCHEDULE_LIST_FILTER.HOLD,
  };
  return map[s] ?? SCHEDULE_LIST_FILTER.READY_TO_DISPATCH;
}

export function statusLabel(code) {
  return SCHEDULE_PLAN_STATUS_LABEL[Number(code)] ?? "Pending";
}

export function actionTypeLabel(actionType) {
  const map = {
    plan: "Planned",
    ready: "Ready to Dispatch",
    hold: "Hold",
    reject: "Rejected",
    complete: "Completed",
    shortage: "Shortage",
  };
  return map[String(actionType || "").toLowerCase()] ?? String(actionType || "—");
}

export function canTransition(from, to) {
  const f = Number(from);
  const t = Number(to);
  if (t === SCHEDULE_PLAN_STATUS.DELETE) return true;
  if (f === t) return true;
  return (SCHEDULE_PLAN_TRANSITIONS[f] || []).includes(t);
}

export function canTransitionAsSuperAdmin(status) {
  const s = Number(status);
  return Number.isFinite(s) && s !== SCHEDULE_PLAN_STATUS.DELETE;
}

/** ADD Plan — from Ready to Dispatch / Planned / Running (not Pending). */
export function canPlanFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
  ].includes(s);
}

/** APPROVE → Ready to Dispatch (7). */
export function canReadyFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.HOLD,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
  ].includes(s);
}

export function canRejectFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.HOLD,
  ].includes(s);
}

export function canHoldFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.READY_TO_DISPATCH,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.REJECT,
  ].includes(s);
}

export function canCompleteFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
  ].includes(s);
}

export function isHoldDueOrPast(row, todayYmd) {
  if (Number(row?.is_planned) !== SCHEDULE_PLAN_STATUS.HOLD) return false;
  const raw = row?.action_date ?? row?.last_action_date ?? null;
  if (!raw) return false;
  let d = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    d = d.slice(0, 10);
  } else {
    const parts = d.split("/");
    if (parts.length !== 3) return false;
    let [dd, mm, y] = parts.map((p) => p.trim());
    if (y.length === 2) y = `20${y}`;
    d = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  const today = String(todayYmd || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !today) return false;
  return d <= today;
}

export function isActiveScheduleStatus(code) {
  const s = Number(code);
  return s === SCHEDULE_PLAN_STATUS.PLANNED || s === SCHEDULE_PLAN_STATUS.RUNNING;
}
