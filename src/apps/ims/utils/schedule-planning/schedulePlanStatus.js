/** is_planned TINYINT values for ims_schedule_plan */
export const SCHEDULE_PLAN_STATUS = {
  PENDING: 0,
  PLANNED: 1,
  RUNNING: 2,
  COMPLETE: 3,
  REJECT: 4,
  DELETE: 5,
  HOLD: 6,
};

export const SCHEDULE_PLAN_STATUS_LABEL = {
  0: "Pending",
  1: "Planned",
  2: "Running",
  3: "Complete",
  4: "Reject",
  6: "Hold",
};

export const SCHEDULE_PLAN_ACTION = {
  PLAN: "plan",
  HOLD: "hold",
  REJECT: "reject",
};

/** List page filter modes (sent as body.status). */
export const SCHEDULE_LIST_FILTER = {
  PENDING: "pending",
  SCHEDULE: "schedule",
  COMPLETE: "complete",
  COMPARISON: "comparison",
  ALL: "all",
  REJECT: "reject",
  HOLD: "hold",
};

const ACTIVE_SCHEDULE_STATUSES = [
  SCHEDULE_PLAN_STATUS.PLANNED,
  SCHEDULE_PLAN_STATUS.RUNNING,
];

export function parseListFilter(raw) {
  const s = String(raw ?? SCHEDULE_LIST_FILTER.PENDING).toLowerCase().trim();
  const map = {
    pending: SCHEDULE_LIST_FILTER.PENDING,
    "0": SCHEDULE_LIST_FILTER.PENDING,
    schedule: SCHEDULE_LIST_FILTER.SCHEDULE,
    planned: SCHEDULE_LIST_FILTER.SCHEDULE,
    plan: SCHEDULE_LIST_FILTER.SCHEDULE,
    running: SCHEDULE_LIST_FILTER.SCHEDULE,
    "1": SCHEDULE_LIST_FILTER.SCHEDULE,
    "2": SCHEDULE_LIST_FILTER.SCHEDULE,
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
    onhold: SCHEDULE_LIST_FILTER.HOLD,
    "6": SCHEDULE_LIST_FILTER.HOLD,
  };
  return map[s] ?? SCHEDULE_LIST_FILTER.PENDING;
}

/** @deprecated use parseListFilter */
export function parseListStatus(raw) {
  const f = parseListFilter(raw);
  if (f === SCHEDULE_LIST_FILTER.SCHEDULE) return SCHEDULE_PLAN_STATUS.PLANNED;
  if (f === SCHEDULE_LIST_FILTER.COMPLETE) return SCHEDULE_PLAN_STATUS.COMPLETE;
  if (f === SCHEDULE_LIST_FILTER.REJECT) return SCHEDULE_PLAN_STATUS.REJECT;
  if (f === SCHEDULE_LIST_FILTER.HOLD) return SCHEDULE_PLAN_STATUS.HOLD;
  return SCHEDULE_PLAN_STATUS.PENDING;
}

export function isActiveScheduleStatus(code) {
  return ACTIVE_SCHEDULE_STATUSES.includes(Number(code));
}

export function statusLabel(code) {
  return SCHEDULE_PLAN_STATUS_LABEL[Number(code)] ?? "Pending";
}

export function actionTypeLabel(actionType) {
  const map = {
    plan: "Planned",
    hold: "Hold",
    reject: "Rejected",
  };
  return map[String(actionType || "").toLowerCase()] ?? String(actionType || "—");
}

/** Allowed transitions: from → [to, ...] */
export const SCHEDULE_PLAN_TRANSITIONS = {
  0: [1, 4, 6],
  1: [2, 4, 6],
  2: [3, 4, 6],
  4: [1, 6],
  6: [1, 4],
};

export function canTransition(from, to) {
  const f = Number(from);
  const t = Number(to);
  if (t === SCHEDULE_PLAN_STATUS.DELETE) return true;
  if (f === t) return true;
  return (SCHEDULE_PLAN_TRANSITIONS[f] || []).includes(t);
}

export function canPlanFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.REJECT,
    SCHEDULE_PLAN_STATUS.HOLD,
  ].includes(s);
}

export function canRejectFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.HOLD,
  ].includes(s);
}

export function canHoldFrom(status) {
  const s = Number(status);
  return [
    SCHEDULE_PLAN_STATUS.PENDING,
    SCHEDULE_PLAN_STATUS.PLANNED,
    SCHEDULE_PLAN_STATUS.RUNNING,
    SCHEDULE_PLAN_STATUS.REJECT,
  ].includes(s);
}
