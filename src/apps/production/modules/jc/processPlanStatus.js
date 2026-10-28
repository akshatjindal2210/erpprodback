/**
 * process_plan machine status — stored ON each plan machine (no separate process_status column).
 * Stage shape: stage_no, process_id, process_name, machines[{ machine_id, machine_name, status }], rm_items.
 * Legacy stage.status is migrated onto every machine on parse.
 */
export const PROCESS_STATUS = {
  PENDING: "pending",
  PLANNING: "planning",
  RUNNING: "running",
  HOLD: "hold",
  COMPLETE: "complete",
};

export const PROCESS_STATUS_VALUES = Object.values(PROCESS_STATUS);

export const PROCESS_STATUS_LABELS = {
  [PROCESS_STATUS.PENDING]: "Pending",
  [PROCESS_STATUS.PLANNING]: "Planning",
  [PROCESS_STATUS.RUNNING]: "Running",
  [PROCESS_STATUS.HOLD]: "Hold",
  [PROCESS_STATUS.COMPLETE]: "Complete",
};

function normalizeStatus(raw) {
  const status = String(raw || PROCESS_STATUS.PENDING).toLowerCase();
  return PROCESS_STATUS_VALUES.includes(status) ? status : PROCESS_STATUS.PENDING;
}

/** Map key for process + machine (machine_id 0 = no machine / stage-only legacy). */
export function machineStatusKey(processId, machineId) {
  return `${Number(processId)}:${Number(machineId) || 0}`;
}

function normalizeMachines(rawMachines, stageStatus) {
  const list = Array.isArray(rawMachines) ? rawMachines : [];
  const fallback = normalizeStatus(stageStatus);
  return list
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const machine_id = Number(m.machine_id ?? m.machineId);
      if (!Number.isFinite(machine_id) || machine_id <= 0) return null;
      return {
        ...m,
        machine_id,
        machine_name: String(m.machine_name ?? m.macname ?? m.name ?? "").trim() || `Machine ${machine_id}`,
        status: normalizeStatus(m.status ?? fallback),
      };
    })
    .filter(Boolean);
}

/** Safe parse — null / bad JSON / non-array → []. Ensures each machine has status. */
export function parseProcessPlan(raw) {
  if (raw == null || raw === "") return [];
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const process_id = Number(row.process_id ?? row.processId);
      if (!Number.isFinite(process_id) || process_id <= 0) return null;
      const stageStatus = row.status;
      const machines = normalizeMachines(row.machines, stageStatus);
      // No machines: keep stage-level status for history / empty machine plans
      const status = machines.length
        ? normalizeStatus(machines[0].status)
        : normalizeStatus(stageStatus);
      return {
        ...row,
        process_id,
        process_name: String(row.process_name ?? row.processName ?? "").trim() || `Process ${process_id}`,
        machines,
        status,
      };
    })
    .filter(Boolean);
}

/** Flat rows: one per machine (or one per process if no machines). */
export function machineStatusRows(raw) {
  const out = [];
  for (const stage of parseProcessPlan(raw)) {
    const machines = stage.machines || [];
    if (!machines.length) {
      out.push({
        key: machineStatusKey(stage.process_id, 0),
        stage_no: stage.stage_no,
        process_id: stage.process_id,
        process_name: stage.process_name,
        machine_id: null,
        machine_name: null,
        status: normalizeStatus(stage.status),
      });
      continue;
    }
    for (const m of machines) {
      out.push({
        key: machineStatusKey(stage.process_id, m.machine_id),
        stage_no: stage.stage_no,
        process_id: stage.process_id,
        process_name: stage.process_name,
        machine_id: m.machine_id,
        machine_name: m.machine_name,
        status: normalizeStatus(m.status),
      });
    }
  }
  return out;
}

/** Status map key → status from a plan. */
export function statusMapFromPlan(raw) {
  const map = new Map();
  for (const row of machineStatusRows(raw)) {
    map.set(row.key, row.status);
  }
  return map;
}

/**
 * Attach status onto built plan machines.
 * Priority: explicit map → previous plan machine → previous/legacy process status → pending.
 */
export function withPlanStatuses(plan = [], oldPlan = [], statusByMachineKey = null) {
  const prev = statusMapFromPlan(oldPlan);
  const prevProcess = new Map();
  for (const stage of parseProcessPlan(oldPlan)) {
    if (!prevProcess.has(stage.process_id)) prevProcess.set(stage.process_id, normalizeStatus(stage.status));
  }
  const explicit = statusByMachineKey instanceof Map ? statusByMachineKey : null;

  return parseProcessPlan(plan).map((stage) => {
    const machines = (stage.machines || []).map((m) => {
      const key = machineStatusKey(stage.process_id, m.machine_id);
      let status = PROCESS_STATUS.PENDING;
      if (explicit?.has(key)) status = explicit.get(key);
      else if (prev.has(key)) status = prev.get(key);
      else if (prevProcess.has(stage.process_id)) status = prevProcess.get(stage.process_id);
      else if (m.status) status = m.status;
      else if (stage.status) status = stage.status;
      return { ...m, status: normalizeStatus(status) };
    });
    const status = machines.length
      ? normalizeStatus(machines[0].status)
      : normalizeStatus(
          explicit?.get(machineStatusKey(stage.process_id, 0))
            ?? prev.get(machineStatusKey(stage.process_id, 0))
            ?? prevProcess.get(stage.process_id)
            ?? stage.status
        );
    return { ...stage, machines, status };
  });
}

/**
 * Compare old vs new plan by process_id + machine_id status.
 * @returns {{ process_id: number, machine_id: number|null, status: string }[]}
 */
export function diffProcessPlan(oldPlan, newPlan) {
  const oldMap = statusMapFromPlan(oldPlan);
  const newRows = machineStatusRows(newPlan);
  const seen = new Set();
  const out = [];

  for (const row of newRows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    const status = normalizeStatus(row.status);
    const from = oldMap.has(row.key) ? oldMap.get(row.key) : null;
    if (from !== status) {
      out.push({
        process_id: row.process_id,
        machine_id: row.machine_id,
        status,
      });
    }
  }
  return out;
}

/**
 * Build status Map from client picks.
 * Accepts per-stage: machine_status { [machine_id]: status }, machines[{machine_id,status}],
 * or legacy stage-level status (applied to every machine_id on that pick).
 */
export function statusMapFromPicks(picks = []) {
  const map = new Map();
  const list = Array.isArray(picks) ? picks : [];
  for (const pick of list) {
    if (!pick || typeof pick !== "object") continue;
    const processId = Number(pick.process_id ?? pick.processId);
    if (!Number.isFinite(processId) || processId <= 0) continue;

    const machineIds = (Array.isArray(pick.machine_ids) ? pick.machine_ids : [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0);

    if (pick.machine_status && typeof pick.machine_status === "object" && !Array.isArray(pick.machine_status)) {
      for (const [mid, st] of Object.entries(pick.machine_status)) {
        const machineId = Number(mid);
        if (!Number.isFinite(machineId) || machineId <= 0) continue;
        if (st == null || st === "") continue;
        map.set(machineStatusKey(processId, machineId), normalizeStatus(st));
      }
    }

    if (Array.isArray(pick.machines)) {
      for (const m of pick.machines) {
        const machineId = Number(m?.machine_id ?? m?.machineId);
        if (!Number.isFinite(machineId) || machineId <= 0) continue;
        if (m?.status == null || m?.status === "") continue;
        map.set(machineStatusKey(processId, machineId), normalizeStatus(m.status));
      }
    }

    // Legacy: one status for the process → every machine on the pick
    if (pick.status != null && pick.status !== "" && machineIds.length) {
      const st = normalizeStatus(pick.status);
      for (const machineId of machineIds) {
        const key = machineStatusKey(processId, machineId);
        if (!map.has(key)) map.set(key, st);
      }
    } else if (pick.status != null && pick.status !== "" && !machineIds.length) {
      map.set(machineStatusKey(processId, 0), normalizeStatus(pick.status));
    }
  }
  return map;
}

/** @deprecated use statusMapFromPicks — kept for migration of legacy process_status lists */
export function statusMapFromInput(raw) {
  const map = new Map();
  if (!raw) return map;
  if (raw instanceof Map) return raw;
  const list = Array.isArray(raw) ? raw : [];
  for (const row of list) {
    const id = Number(row?.process_id ?? row?.processId);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (row?.status == null || row?.status === "") continue;
    const machineId = Number(row?.machine_id ?? row?.machineId) || 0;
    map.set(machineStatusKey(id, machineId), normalizeStatus(row.status));
  }
  return map;
}
