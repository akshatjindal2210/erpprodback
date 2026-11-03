/**
 * Process plan helpers (API shape).
 * Stored on prod_plan rows — not on prod_jc.
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

export function machineStatusKey(processId, machineId) {
  return `${Number(processId)}:${Number(machineId) || 0}`;
}

function normalizeRmItems(raw) {
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const rm_item_dcode = Number(r?.rm_item_dcode);
      if (!Number.isFinite(rm_item_dcode) || rm_item_dcode <= 0) return null;
      return { rm_item_dcode, rm_item_code: r.rm_item_code ? String(r.rm_item_code).trim() : null };
    })
    .filter(Boolean);
}

/** Safe parse — null / bad JSON → []. */
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
      const machines = (Array.isArray(row.machines) ? row.machines : [])
        .map((m) => {
          const machine_id = Number(m?.machine_id ?? m?.machineId);
          if (!Number.isFinite(machine_id) || machine_id <= 0) return null;
          return {
            machine_id,
            machine_name: String(m.machine_name ?? m.macname ?? m.name ?? "").trim() || `Machine ${machine_id}`,
            status: normalizeStatus(m.status ?? row.status),
          };
        })
        .filter(Boolean);
      return {
        stage_no: row.stage_no != null ? Number(row.stage_no) : null,
        process_id,
        process_name: String(row.process_name ?? row.processName ?? "").trim() || `Process ${process_id}`,
        machines,
        rm_items: normalizeRmItems(row.rm_items),
        status: normalizeStatus(machines[0]?.status ?? row.status),
      };
    })
    .filter(Boolean);
}

/** Flat: one row per machine (or process if no machines). */
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

/** Structure for prod_plan upsert (no status). */
export function stripPlanStatuses(plan = []) {
  return parseProcessPlan(plan).map((stage) => ({
    stage_no: stage.stage_no,
    process_id: stage.process_id,
    process_name: stage.process_name,
    machines: (stage.machines || []).map((m) => ({
      machine_id: m.machine_id,
      machine_name: m.machine_name,
    })),
    rm_items: stage.rm_items || [],
  }));
}

/** Rebuild process_plan[] from prod_plan DB rows. */
export function buildProcessPlanFromPlanRows(rows = []) {
  const byKey = new Map();
  for (const r of rows || []) {
    const process_id = Number(r.proccode ?? r.process_id);
    if (!Number.isFinite(process_id) || process_id <= 0) continue;
    const stage_no = r.stage_no != null ? Number(r.stage_no) : null;
    const key = `${stage_no ?? ""}:${process_id}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        stage_no,
        process_id,
        process_name: String(r.process_name || "").trim() || `Process ${process_id}`,
        machines: [],
        rm_items: normalizeRmItems(r.rm_items),
        status: normalizeStatus(r.status),
      });
    }
    const stage = byKey.get(key);
    if (!stage.rm_items.length) stage.rm_items = normalizeRmItems(r.rm_items);
    const mac = Number(r.maccode ?? r.machine_id);
    if (Number.isFinite(mac) && mac > 0) {
      stage.machines.push({
        machine_id: mac,
        machine_name: String(r.machine_name || "").trim() || `Machine ${mac}`,
        status: normalizeStatus(r.status),
      });
      stage.status = normalizeStatus(stage.machines[0].status);
    }
  }
  return [...byKey.values()].sort((a, b) => (Number(a.stage_no) || 0) - (Number(b.stage_no) || 0));
}

/** Client picks → Map("proccode:maccode" → status). */
export function statusMapFromPicks(picks = []) {
  const map = new Map();
  for (const pick of Array.isArray(picks) ? picks : []) {
    if (!pick || typeof pick !== "object") continue;
    const processId = Number(pick.process_id ?? pick.processId);
    if (!Number.isFinite(processId) || processId <= 0) continue;

    const machineIds = (Array.isArray(pick.machine_ids) ? pick.machine_ids : [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0);

    if (pick.machine_status && typeof pick.machine_status === "object" && !Array.isArray(pick.machine_status)) {
      for (const [mid, st] of Object.entries(pick.machine_status)) {
        const machineId = Number(mid);
        if (!Number.isFinite(machineId) || machineId <= 0 || st == null || st === "") continue;
        map.set(machineStatusKey(processId, machineId), normalizeStatus(st));
      }
    }

    if (Array.isArray(pick.machines)) {
      for (const m of pick.machines) {
        const machineId = Number(m?.machine_id ?? m?.machineId);
        if (!Number.isFinite(machineId) || machineId <= 0 || m?.status == null || m?.status === "") continue;
        map.set(machineStatusKey(processId, machineId), normalizeStatus(m.status));
      }
    }

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
