import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { qtyFromSlotHours } from "../../apps/production/modules/jc/jobCardProductionTime.js";
import { parseProcessPlan } from "../../apps/production/modules/jc/processPlanStatus.js";
import { listActiveShiftCodes, ratesByMac } from "../../apps/production/modules/plan/models/planManpower.model.js";
import { netShiftHours } from "../../apps/core/lib/utils/shift/shiftHours.util.js";
import { scheduleDeferred, getCronDateString, getCronTimeHm, addCalendarDaysYmd } from "../shared/cronUtil.js";

function procs(plan, mac) {
  const st = [...parseProcessPlan(plan)].sort((a, b) => Number(a.stage_no || 0) - Number(b.stage_no || 0));
  let i = st.findIndex((s) => (s.machines || []).some((m) => Number(m.machine_id) === mac));
  if (i < 0) i = 0;
  return [st[i]?.process_id || null, st[i + 1]?.process_id || null];
}

function toMinutes(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Shift start + N hours → HH:MM:SS (overnight ok). */
function endAfterHours(start_time, hours) {
  const a = toMinutes(start_time);
  const h = Number(hours);
  if (a == null || !(h > 0)) return null;
  const mins = (a + Math.round(h * 60)) % (24 * 60);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${hh}:${mm}:00`;
}

/** Hours already logged on JC (all machines) from prod_entry start/end. */
async function loggedHoursForJc(jc) {
  const pjc = String(jc || "").trim();
  if (!pjc) return 0;
  const rows = await dbQuery(
    `SELECT shift_start, shift_end FROM ${T.ENTRY}
     WHERE jc = $1 AND COALESCE(is_deleted, false) = false`,
    [pjc]
  );
  let h = 0;
  for (const row of rows || []) {
    h += Number(netShiftHours(row.shift_start, row.shift_end, false).hours) || 0;
  }
  return Math.round(h * 100) / 100;
}

/**
 * JC need hours for this machine line — from qty × machine cycle (same idea as plan est).
 * Fallback: full shift hours when rates missing.
 */
async function needHoursForJcMac(jc, mac, macRow, fallbackShiftHours) {
  const pjc = String(jc || "").trim();
  if (!pjc) return Number(fallbackShiftHours) || 0;
  const [jcRow] = await dbQuery(
    `SELECT qty FROM ${T.JC} WHERE pjobcardno = $1 AND COALESCE(is_deleted, false) = false LIMIT 1`,
    [pjc]
  );
  const qty = Number(jcRow?.qty) || 0;
  const cavity = Math.max(1, Number(macRow?.cavity) || 1);
  const cycle = Number(macRow?.maccycletime) || 0;
  const setup = Math.max(0, Number(macRow?.setup_time) || 0);
  if (qty > 0 && cycle > 0) {
    const cycles = Math.ceil(qty / cavity);
    const sec = setup + cycles * cycle;
    return Math.round((sec / 3600) * 100) / 100;
  }
  return Number(fallbackShiftHours) > 0 ? Number(fallbackShiftHours) : 8;
}

/** Insert one prod_entry log row per machine cell for this shift (skip if already logged). */
async function insertShift(date, shift, start_time, end_time, shiftHours = null, settingAllow = false) {
  const cells = await dbQuery(
    `SELECT maccode, COUNT(*)::int AS n,
            string_agg(NULLIF(TRIM(emp_code), ''), ', ') AS operator_id,
            string_agg(NULLIF(TRIM(emp_name), ''), ', ') AS operator
     FROM ${T.PLAN_MANPOWER}
     WHERE plan_date = $1::date AND shift_no = $2
     GROUP BY maccode`,
    [date, shift]
  );
  if (!cells?.length) return 0;

  const macs = cells.map((c) => Number(c.maccode)).filter((n) => n > 0);
  const fullShift = Number(shiftHours) > 0 ? Math.round(Number(shiftHours) * 100) / 100 : null;
  const [macMap, plans] = await Promise.all([
    ratesByMac(macs),
    dbQuery(
      `SELECT DISTINCT ON (p.maccode) p.maccode, p.proccode, p.stage_no, p.pjobcardno
       FROM ${T.PLAN} p
       JOIN ${T.JC} j ON j.pjobcardno = p.pjobcardno AND COALESCE(j.is_deleted, false) = false
       WHERE p.maccode = ANY($1::int[])
         AND LOWER(COALESCE(p.status, '')) NOT IN ('complete', 'completed')
       ORDER BY p.maccode, p.mp_start NULLS LAST, p.docno`,
      [macs]
    ),
  ]);
  const planMap = new Map((plans || []).map((p) => [Number(p.maccode), p]));
  const pjcNos = [...new Set((plans || []).map((p) => String(p.pjobcardno || "").trim()).filter(Boolean))];
  const stageRows = pjcNos.length
    ? await dbQuery(
        `SELECT pjobcardno, proccode AS process_id, stage_no, maccode AS machine_id
         FROM ${T.PLAN} WHERE pjobcardno = ANY($1::text[])`,
        [pjcNos]
      )
    : [];
  const planByJc = new Map();
  for (const r of stageRows || []) {
    const pjc = String(r.pjobcardno);
    if (!planByJc.has(pjc)) planByJc.set(pjc, []);
    const stages = planByJc.get(pjc);
    let stage = stages.find((s) => Number(s.stage_no) === Number(r.stage_no) && Number(s.process_id) === Number(r.process_id));
    if (!stage) {
      stage = { stage_no: r.stage_no, process_id: r.process_id, machines: [] };
      stages.push(stage);
    }
    if (r.machine_id) stage.machines.push({ machine_id: r.machine_id });
  }
  let n = 0;

  for (const c of cells) {
    const mac = Number(c.maccode);
    if (!(mac > 0)) continue;
    const m = macMap.get(mac) || {};
    const p = planMap.get(mac) || {};
    const jc = String(p.pjobcardno || "").trim();

    /**
     * Progressive hours: JC need 15h, already 4h logged, shift 8h → entry 8h.
     * Last slice: remain 3h on 8h shift → entry 3h (rest = waste; next JC if setting_allow).
     */
    let hours = fullShift;
    let entryEnd = end_time || null;
    if (jc && fullShift > 0) {
      const need = await needHoursForJcMac(jc, mac, m, fullShift);
      const logged = await loggedHoursForJc(jc);
      const remain = Math.max(0, Math.round((need - logged) * 100) / 100);
      if (remain <= 0.05) {
        /** JC need already met — only create if setting_allow (next JC can use waste). */
        if (!settingAllow) continue;
        hours = fullShift;
      } else {
        hours = Math.min(fullShift, remain);
        if (hours < fullShift - 0.05) {
          entryEnd = endAfterHours(start_time, hours) || end_time;
        }
      }
    }

    const [run_proc, next_proc] = procs(planByJc.get(jc) || [], mac);
    const rows = await dbQuery(
      `INSERT INTO ${T.ENTRY} (
         docdt, jc, shift, shift_start, shift_end, run_proc, next_proc, operator_id, operator,
         machine, cavity, cycle, prd_qty, rej_qty, ok_qty,
         created_by, created_at
       )
       SELECT $1::date,$2,$3::smallint,$4::time,$5::time,$6::int,$7::int,$8,$9,
              $10::int,$11,$12::int,$13,0,$13,'System',NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM ${T.ENTRY}
         WHERE machine = $10::int AND docdt = $1::date AND shift = $3::smallint AND is_deleted = false
       )
       RETURNING 1`,
      [
        date, jc || null, shift,
        start_time || null, entryEnd,
        run_proc || p.proccode || null, next_proc,
        c.operator_id || null, c.operator || null, mac,
        m.cavity != null ? String(m.cavity) : null,
        Number(m.maccycletime) > 0 ? Number(m.maccycletime) : null,
        qtyFromSlotHours(m, hours) || 0,
      ]
    );
    if (rows?.length) n += 1;
  }
  return n;
}

/** Runs every minute; inserts prod_entry when current IST time matches a shift end_time. */
export async function runProdEntryAtShiftEnd() {
  const hm = getCronTimeHm();
  const today = getCronDateString();
  for (const s of await listActiveShiftCodes()) {
    if (String(s.end_time || "").slice(0, 5) !== hm) continue;
    const date = s.overnight ? addCalendarDaysYmd(today, -1) : today;
    const n = await insertShift(date, s.id, s.start_time, s.end_time, s.hours, !!s.setting_allow);
    if (n) console.log(`[prod-entry] shift ${s.id} ${date}: +${n}`);
  }
}

export function initProdEntryCron() {
  scheduleDeferred("* * * * *", runProdEntryAtShiftEnd, { name: "prod-entry", onMissed: runProdEntryAtShiftEnd });
}
