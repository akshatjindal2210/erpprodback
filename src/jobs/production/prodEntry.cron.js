import dbQuery from "../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../config/db/dbTables.js";
import { qtyFromSlotHours } from "../../apps/production/modules/jc/jobCardProductionTime.js";
import { parseProcessPlan } from "../../apps/production/modules/jc/processPlanStatus.js";
import { listActiveShiftCodes, ratesByMac, isShiftActiveOnDate } from "../../apps/production/modules/plan/models/planManpower.model.js";
import { netShiftHours } from "../../apps/core/lib/utils/shift/shiftHours.util.js";
import { scheduleDeferred, deferCronWork, getCronDateString, getCronTimeHm, addCalendarDaysYmd } from "../shared/cronUtil.js";

function procs(plan, mac) {
  const st = [...parseProcessPlan(plan)].sort((a, b) => Number(a.stage_no || 0) - Number(b.stage_no || 0));
  let i = st.findIndex((s) => (s.machines || []).some((m) => Number(m.machine_id) === mac));
  if (i < 0) i = 0;
  return [st[i]?.process_id || null, st[i + 1]?.process_id || null];
}

/** Normalize any TIME / timestamp / Date-ish value → HH:MM (24h, zero-padded). */
function toHm(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  }
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/);
  const m = iso || s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (!(h >= 0 && h <= 23)) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function toMinutes(value) {
  const hm = toHm(value);
  if (!hm) return null;
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
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

/** DATE + TIME → `YYYY-MM-DD HH:MM:SS` for TIMESTAMP columns. */
function toStamp(dateYmd, timeStr) {
  const day = String(dateYmd || "").slice(0, 10);
  const hm = toHm(timeStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !hm) return null;
  const secMatch = String(timeStr || "").trim().match(/^\d{1,2}:\d{2}:(\d{2})/);
  const sec = secMatch ? secMatch[1] : "00";
  return `${day} ${hm}:${sec}`;
}

/**
 * Hours already logged on JC from prod_entry start/end.
 * Pass `mac` to scope to this machine line (stage) — avoids pending later stages eating remain.
 */
async function loggedHoursForJc(jc, mac = null) {
  const pjc = String(jc || "").trim();
  if (!pjc) return 0;
  const params = [pjc];
  let sql = `SELECT shift_start, shift_end FROM ${T.ENTRY}
     WHERE jc = $1 AND COALESCE(is_deleted, false) = false`;
  if (Number(mac) > 0) {
    params.push(Number(mac));
    sql += ` AND machine = $2::int`;
  }
  const rows = await dbQuery(sql, params);
  let h = 0;
  for (const row of rows || []) {
    /** Lunch on — wall span 07:00–17:30 matches Settings net 10h. */
    h += Number(netShiftHours(row.shift_start, row.shift_end, true).hours) || 0;
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
    `SELECT planqty FROM ${T.JC} WHERE pjobcardno = $1 AND COALESCE(is_deleted, false) = false LIMIT 1`,
    [pjc]
  );
  const qty = Number(jcRow?.planqty) || 0;
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

/**
 * Active plan line on this machine only (planning / running / hold — never pending).
 * Prefer a line that still has remaining hours on this machine.
 */
async function pickPlanForMac(mac, macRow, fullShift) {
  const plans = await dbQuery(
    `SELECT p.maccode, p.proccode, p.stage_no, p.pjobcardno, j.itemdcode, p.status
     FROM ${T.PLAN} p
     JOIN ${T.JC} j ON j.pjobcardno = p.pjobcardno AND COALESCE(j.is_deleted, false) = false
     WHERE p.maccode = $1
       AND LOWER(COALESCE(p.status, '')) IN ('planning', 'running', 'hold')
     ORDER BY p.mp_start NULLS LAST, p.stage_no ASC NULLS LAST, p.docno ASC`,
    [mac]
  );
  if (!plans?.length) return null;

  let first = null;
  for (const p of plans) {
    const jc = String(p.pjobcardno || "").trim();
    if (!jc) continue;
    const row = { ...p, jc };
    if (!first) first = row;
    const need = await needHoursForJcMac(jc, mac, macRow, fullShift);
    const logged = await loggedHoursForJc(jc, mac);
    const remain = Math.max(0, Math.round((need - logged) * 100) / 100);
    if (remain > 0.05) return { ...row, remain };
  }
  return first ? { ...first, remain: 0 } : null;
}

/** Insert one prod_entry log row per machine cell for this shift (skip if already logged). */
async function insertShift(date, shift, start_time, end_time, shiftHours = null, settingAllow = false, overnight = false) {
  /**
   * Only cells that still need an entry — keeps catch-up cheap every minute after shift end.
   * Same uniqueness as before: machine + docdt + shift.
   */
  const cells = await dbQuery(
    `SELECT mp.maccode, COUNT(*)::int AS n,
            string_agg(NULLIF(TRIM(mp.emp_code), ''), ', ' ORDER BY mp.id) AS operator_id,
            string_agg(NULLIF(TRIM(mp.emp_name), ''), ', ' ORDER BY mp.id) AS operator
     FROM ${T.PLAN_MANPOWER} mp
     WHERE mp.plan_date = $1::date AND mp.shift_no = $2
       AND NOT EXISTS (
         SELECT 1 FROM ${T.ENTRY} e
         WHERE e.machine = mp.maccode
           AND e.docdt = $1::date
           AND e.shift = $2::smallint
           AND COALESCE(e.is_deleted, false) = false
       )
     GROUP BY mp.maccode`,
    [date, shift]
  );
  if (!cells?.length) return 0;

  const macs = cells.map((c) => Number(c.maccode)).filter((n) => n > 0);
  const fullShift = Number(shiftHours) > 0 ? Math.round(Number(shiftHours) * 100) / 100 : null;
  const macMap = await ratesByMac(macs);

  const planCache = new Map();
  const pjcNos = [];
  for (const mac of macs) {
    try {
      const picked = await pickPlanForMac(mac, macMap.get(mac) || {}, fullShift || 8);
      if (picked) {
        planCache.set(mac, picked);
        if (picked.jc) pjcNos.push(picked.jc);
      }
    } catch (err) {
      console.error(`[prod-entry] pickPlan mac ${mac}:`, err?.message || err);
    }
  }

  const stageRows = pjcNos.length
    ? await dbQuery(
        `SELECT pjobcardno, proccode AS process_id, stage_no, maccode AS machine_id
         FROM ${T.PLAN} WHERE pjobcardno = ANY($1::text[])`,
        [[...new Set(pjcNos)]]
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

  const endDay = overnight ? addCalendarDaysYmd(date, 1) : date;
  let n = 0;

  for (const c of cells) {
    const mac = Number(c.maccode);
    if (!(mac > 0)) continue;

    try {
      const m = macMap.get(mac) || {};
      const p = planCache.get(mac) || null;
      const jc = String(p?.jc || "").trim();
      /** No active planning/running/hold JC on this machine → skip (never null-jc rows). */
      if (!jc) continue;

      /**
       * Progressive hours: JC need 15h, already 4h logged, shift 8h → entry 8h.
       * Last slice: remain 3h on 8h shift → entry 3h (rest = waste; next JC if setting_allow).
       * Same gate as before when remain <= 0 and setting_allow is off → skip.
       */
      let hours = fullShift;
      let entryEndTime = end_time || null;
      let entryEndDay = endDay;
      if (jc && fullShift > 0) {
        const rem =
          Number.isFinite(Number(p?.remain)) && Number(p.remain) >= 0
            ? Number(p.remain)
            : Math.max(
                0,
                Math.round(((await needHoursForJcMac(jc, mac, m, fullShift)) - (await loggedHoursForJc(jc, mac))) * 100) / 100
              );
        if (rem <= 0.05) {
          if (!settingAllow) continue;
          hours = fullShift;
        } else {
          hours = Math.min(fullShift, rem);
          if (hours < fullShift - 0.05) {
            entryEndTime = endAfterHours(start_time, hours) || end_time;
            const startM = toMinutes(start_time);
            const endM = toMinutes(entryEndTime);
            entryEndDay = startM != null && endM != null && endM <= startM ? addCalendarDaysYmd(date, 1) : date;
          }
        }
      }

      const [run_proc, next_proc] = procs(planByJc.get(jc) || [], mac);
      const target = qtyFromSlotHours(m, fullShift || hours) || 0;
      const prd = qtyFromSlotHours(m, hours) || 0;
      const shiftStart = toStamp(date, start_time);
      const shiftEnd = toStamp(entryEndDay, entryEndTime);

      if (!shiftStart || !shiftEnd) {
        console.error(`[prod-entry] mac ${mac}: bad timestamps start=${start_time} end=${entryEndTime}`);
        continue;
      }

      const rows = await dbQuery(
        `INSERT INTO ${T.ENTRY} (
           docdt, jc, itemdcode, shift, shift_start, shift_end, run_proc, next_proc, operator_id, operator,
           machine, cavity, cycle, target_qty, prd_qty, loose_qty, rej_qty, ok_qty,
           created_by, created_at
         )
         SELECT $1::date,$2,$3::int,$4::smallint,$5::timestamp,$6::timestamp,$7::int,$8::int,$9,$10,
                $11::int,$12,$13::int,$14,$15,$16,0,$15,'System',NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM ${T.ENTRY}
           WHERE machine = $11::int AND docdt = $1::date AND shift = $4::smallint
             AND COALESCE(is_deleted, false) = false
         )
         RETURNING 1`,
        [
          date,
          jc || null,
          p?.itemdcode != null ? Number(p.itemdcode) : null,
          shift,
          shiftStart,
          shiftEnd,
          run_proc || (p?.proccode != null ? Number(p.proccode) : null),
          next_proc,
          c.operator_id || null,
          c.operator || null,
          mac,
          m.cavity != null ? String(m.cavity) : null,
          Number(m.maccycletime) > 0 ? Number(m.maccycletime) : null,
          target,
          prd,
          Math.max(0, target - prd),
        ]
      );
      if (rows?.length) n += 1;
    } catch (err) {
      console.error(`[prod-entry] mac ${mac} ${date} shift ${shift}:`, err?.message || err);
    }
  }
  return n;
}

/**
 * True when the shift that started on `date` has already ended by (today, hmNow) IST.
 * Day shift ends same calendar day; overnight ends next morning at end_time.
 */
function hasShiftEnded(shift, date, today, hmNow) {
  const endHm = toHm(shift.end_time);
  if (!endHm || !hmNow || !date) return false;
  if (shift.overnight) {
    const endDay = addCalendarDaysYmd(date, 1);
    if (endDay < today) return true;
    if (endDay > today) return false;
    return hmNow >= endHm;
  }
  if (date < today) return true;
  if (date > today) return false;
  return hmNow >= endHm;
}

/** How many past calendar days to backfill (missed cron / server down). */
const PROD_ENTRY_LOOKBACK_DAYS = 2;

/**
 * Runs every minute; inserts prod_entry for ended shifts (today + short lookback).
 * Idempotent via NOT EXISTS — safe to re-run.
 */
export async function runProdEntryAtShiftEnd() {
  const hm = getCronTimeHm();
  const today = getCronDateString();
  let total = 0;

  for (const s of await listActiveShiftCodes()) {
    for (let i = 0; i <= PROD_ENTRY_LOOKBACK_DAYS; i++) {
      const date = addCalendarDaysYmd(today, -i);
      if (!isShiftActiveOnDate(s, date)) continue;
      if (!hasShiftEnded(s, date, today, hm)) continue;

      try {
        const n = await insertShift(date, s.id, s.start_time, s.end_time, s.hours, !!s.setting_allow, !!s.overnight);
        if (n) {
          total += n;
          console.log(`[prod-entry] shift ${s.code || s.id} ${date}: +${n}`);
        }
      } catch (err) {
        console.error(`[prod-entry] shift ${s.code || s.id} ${date}:`, err?.message || err);
      }
    }
  }

  return total;
}

export function initProdEntryCron() {
  scheduleDeferred("* * * * *", runProdEntryAtShiftEnd, {
    name: "prod-entry",
    onMissed: runProdEntryAtShiftEnd,
  });
  /** Restart / deploy — backfill recently ended shifts (NOT EXISTS keeps safe). */
  deferCronWork(() => runProdEntryAtShiftEnd());
}
