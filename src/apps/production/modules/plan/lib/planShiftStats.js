/**
 * Board shifts / hours:
 * 1) manpower planned → use it
 * 2) half planned → avg hours/shift × need shifts
 * 3) nothing → machine estimate
 */
import { SHIFT_HOURS } from "../../jc/jobCard.config.js";

/**
 * @param {{ needShifts?: number, needHours?: number, plannedShifts?: number, plannedHours?: number }} p
 * @returns {{ shifts: number|null, hours: number|null, source: "manpower"|"partial"|"estimate" }}
 */
export function resolveShiftStats({ needShifts, needHours, plannedShifts, plannedHours } = {}) {
  const needS = Number(needShifts) > 0 ? Number(needShifts) : 0;
  const needH = Number(needHours) > 0 ? Number(needHours) : 0;
  const pS = Number(plannedShifts) > 0 ? Number(plannedShifts) : 0;
  const pH = Number(plannedHours) > 0 ? Number(plannedHours) : 0;

  if (pS > 0) {
    const avg = pH > 0 ? pH / pS : SHIFT_HOURS;
    if (needS > 0 && pS < needS) {
      return { shifts: needS, hours: Math.round(avg * needS * 10) / 10, source: "partial" };
    }
    return { shifts: pS, hours: Math.round((pH > 0 ? pH : avg * pS) * 10) / 10, source: "manpower" };
  }

  if (needS > 0 || needH > 0) {
    return {
      shifts: needS || null,
      hours: Math.round((needH > 0 ? needH : needS * SHIFT_HOURS) * 10) / 10,
      source: "estimate",
    };
  }
  return { shifts: null, hours: null, source: "estimate" };
}

/**
 * FIFO: burn machine manpower slots into plan lines by need hours.
 * slots = [{ d, s, h }]  ·  lines = [{ id, needHours }]
 * needHours must be > 0 — never Infinity (that filled every slot with one JC).
 */
export function attributeManpowerFifo(slots = [], lines = []) {
  const out = new Map();
  for (const line of lines) {
    out.set(line.id, { shifts: 0, hours: 0, fromDate: null, toDate: null });
  }
  if (!slots.length || !lines.length) return out;

  let li = 0;
  const needOf = (line) => (Number(line?.needHours) > 0 ? Number(line.needHours) : 0);
  while (li < lines.length && !(needOf(lines[li]) > 0)) li += 1;
  let remain = li < lines.length ? needOf(lines[li]) : 0;

  for (const slot of slots) {
    while (li < lines.length && !(remain > 0.05)) {
      li += 1;
      while (li < lines.length && !(needOf(lines[li]) > 0)) li += 1;
      remain = li < lines.length ? needOf(lines[li]) : 0;
    }
    if (li >= lines.length || !(remain > 0.05)) break;

    const line = lines[li];
    const hrs = Number(slot.h) > 0 ? Number(slot.h) : SHIFT_HOURS;
    const cur = out.get(line.id);
    cur.shifts += 1;
    cur.hours = Math.round((cur.hours + hrs) * 100) / 100;
    const d = String(slot.d || "").slice(0, 10);
    if (d) {
      if (!cur.fromDate || d < cur.fromDate) cur.fromDate = d;
      if (!cur.toDate || d > cur.toDate) cur.toDate = d;
    }
    remain = Math.max(0, Math.round((remain - hrs) * 100) / 100);
  }
  return out;
}
