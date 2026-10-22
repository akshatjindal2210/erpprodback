import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { ENGINEERING_TABLES as E } from "../../../../../config/db/dbTables.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { PROCESS_FLAGS, flagsOf } from "../../process-master/models/processMaster.model.js";

/**
 * Item process — Prime / Finish process plans (eng_item_process). Engineering only: no Item RM (rmstore) link.
 *
 *   HN006   → #1  type 1 (prime), item_dcode HN006
 *   HN006   → #2  type 2 (fg),    item_dcode HN006     ┐
 *   HN006TW → #3  type 2 (fg),    item_dcode HN006TW   ├ same basic steps (HN006 prime), then each its own Finish process
 *   HN006Y  → #4  type 2 (fg),    item_dcode HN006Y    ┘
 * `type` alone says prime / fg. An FG finds its prime by item, live from IMS (primitemdcode → type 1 row of that item).
 *
 * `process` JSON is the same shape for both types (see item_process.table.js), so a prime and its FG read as one.
 */
export const PROCESS_TYPE = { PRIME: 1, FG: 2 };
/** `type` value written in the `process` JSON. */
export const PROCESS_TYPE_KEY = { [PROCESS_TYPE.PRIME]: "prime", [PROCESS_TYPE.FG]: "fg" };

const IP = E.ITEM_PROCESS;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const uniqNums = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
/** [{ machine_id: 1 }, 2, { id: 3 }] → [1, 2, 3] (order kept, duplicates dropped). */
const idsOf = (list, key) => uniqNums((list || []).map((x) => x?.[key] ?? x?.id ?? x));

/* ─────────── One process in the JSON — change the shape only in these two functions ─────────── */

/**
 * SAVE: form process → JSON line.  e.g. { "process": 1, "machines": [1, 2], "rm": [1078] }
 * RM only when the process has RM wire ON in Process Master (`proc.rm_wire`).
 * New field? add it here, e.g.  cycle_time: Number(p.cycle_time) || null,
 */
function toLine(p, proc) {
  return {
    process: Number(p.process_id),
    machines: idsOf(p.machines, "machine_id"),
    rm: proc.rm_wire ? idsOf(p.rm_items, "rm_item_dcode") : [], // order = priority
  };
}

/**
 * READ: JSON line → process for the form / API / job card. Names and flags come live from Process / Machine Master.
 * New field? add it here too, e.g.  cycle_time: line.cycle_time ?? null,
 */
function fromLine(line, index, m) {
  const proc = m.procById.get(Number(line.process));
  const flags = flagsOf(proc); // every Process Master flag: true / false exactly as set there
  return {
    process_id: Number(line.process),
    process_name: proc?.name || `Process ${line.process}`,
    process_order: index + 1,
    flags,
    ...flags,
    machines: (line.machines || [])
      .map((id) => m.macById.get(Number(id)))
      .filter(Boolean)
      .map((mac) => ({
        machine_id: Number(mac.id),
        machine_label: `${mac.number} — ${mac.macname}`,
        name: mac.macname,
        macname: mac.macname,
        number: mac.number,
        speed: mac.speed ?? null,
        duration: Number(mac.duration) || 0,
        setup_time: Number(mac.setup_time) || 0,
      })),
    rm_items: flags.rm_wire ? (line.rm || []).map((d) => ({ rm_item_dcode: Number(d) })) : [],
  };
}

/** Process + Machine Master rows the lines use — live names and flags. `activeOnly` on save. */
async function loadMasters(lines, { activeOnly = false } = {}) {
  const active = activeOnly ? " AND is_deleted = false" : "";
  const [procs, machines] = await Promise.all([
    dbQuery(`SELECT id, name, ${PROCESS_FLAGS.join(", ")} FROM ${E.PROCESS_MASTER} WHERE id = ANY($1::int[])${active}`, [uniqNums(lines.map((l) => l.process))]),
    dbQuery(
      `SELECT id, macname, number, process_id, speed, duration, setup_time FROM ${E.MACHINE_MASTER} WHERE id = ANY($1::int[])${active}`,
      [uniqNums(lines.flatMap((l) => l.machines || []))]
    ),
  ]);
  return {
    procById: new Map(procs.map((p) => [Number(p.id), p])),
    macById: new Map(machines.map((mac) => [Number(mac.id), mac])),
  };
}

/** The `process` JSON stored on a row. Item is the row's item_dcode column. */
function buildProcessJson({ type, stages }) {
  return { type: PROCESS_TYPE_KEY[type], stages };
}

/**
 * SAVE: form `{ stages: [{ processes: [{ process_id, machines, rm_items }] }] }` → checked JSON stages
 *   [{ stage: 1, processes: [toLine(…), …] }, …]   (empty stages dropped, renumbered 1, 2, 3…)
 */
async function buildStages(processJson, type) {
  const formStages = (processJson?.stages || [])
    .map((st) => (st?.processes || []).filter((p) => Number(p?.process_id) > 0))
    .filter((list) => list.length);
  const formProcesses = formStages.flat();
  if (!formProcesses.length) throw httpError(400, "Add at least one process.");

  const m = await loadMasters(
    formProcesses.map((p) => ({ process: Number(p.process_id), machines: idsOf(p.machines, "machine_id") })),
    { activeOnly: true }
  );

  const processIds = formProcesses.map((p) => Number(p.process_id));
  const dup = processIds.find((id, i) => processIds.indexOf(id) !== i);
  if (dup) throw httpError(400, `${m.procById.get(dup)?.name || `Process ${dup}`} is added more than once.`);

  // Prime plan → only processes with "prime" ON; finish plan → only "fg" ON (Process Master)
  const isPrime = type === PROCESS_TYPE.PRIME;
  const needFlag = isPrime ? "prime" : "fg";

  return formStages.map((list, sIdx) => ({
    stage: sIdx + 1,
    processes: list.map((p) => {
      const proc = m.procById.get(Number(p.process_id));
      if (!proc) throw httpError(400, `Process ${p.process_id} not found in Process Master.`);
      if (!proc[needFlag]) throw httpError(400, `${proc.name} is not a ${isPrime ? "Prime" : "finish"} process.`);

      const line = toLine(p, proc);
      const where = `(Stage ${sIdx + 1})`;
      if (!line.machines.length) throw httpError(400, `Select at least one machine for ${proc.name} ${where}.`);
      for (const id of line.machines) {
        const mac = m.macById.get(id);
        if (!mac) throw httpError(400, `Machine ${id} not found in Machine Master.`);
        if (Number(mac.process_id) !== Number(proc.id)) throw httpError(400, `Machine ${mac.macname} is not a ${proc.name} machine ${where}.`);
      }
      return line;
    }),
  }));
}

/* ───────────────────────── Read ───────────────────────── */

/** IMS item master for a save / delete — refused when IMS is not reachable (prime / finish would be guessed wrong). */
async function imsItemMap() {
  const { itemMap } = await getImsMapsSafe();
  if (!itemMap?.size) throw httpError(503, "IMS item master is not available right now. Please try again.");
  return itemMap;
}

/** Prime item of an item from IMS (`primitemdcode`); an item without one is its own prime item. */
export async function resolvePrimeItemDcode(itemDcode) {
  const itemMap = await imsItemMap();
  return Number(itemMap.get(canonicalCode(itemDcode))?.primitemdcode) || Number(itemDcode);
}

/** Active primes of these items → Map item_dcode → id. `approvedOnly` false = master UI / FG prime block. */
export async function findPrimeIdsByItems(itemDcodes = [], { approvedOnly = true } = {}) {
  const dcodes = uniqNums(itemDcodes);
  if (!dcodes.length) return new Map();
  const approvedSql = approvedOnly ? " AND is_approved = true" : "";
  const rows = await dbQuery(
    `SELECT id, item_dcode FROM ${IP} WHERE type = ${PROCESS_TYPE.PRIME} AND item_dcode = ANY($1::int[]) AND is_deleted = false${approvedSql}`,
    [dcodes]
  );
  return new Map(rows.map((r) => [Number(r.item_dcode), Number(r.id)]));
}

/** Active rows of one type → [{ id, type, item_dcode, process, created_by, ... }]. */
export async function findPlans({ type, id = null, item_dcode = null, approvedOnly = false } = {}) {
  const conds = [`type = $1`, `is_deleted = false`];
  const values = [type];
  if (id != null) conds.push(`id = $${values.push(Number(id))}`);
  if (item_dcode != null) conds.push(`item_dcode = $${values.push(Number(item_dcode))}`);
  if (approvedOnly) conds.push(`is_approved = true`);
  return dbQuery(
    `SELECT id, type, item_dcode, process, is_approved, approved_by, approved_at,
            created_by, created_at, updated_by, updated_at
     FROM ${IP} WHERE ${conds.join(" AND ")} ORDER BY id DESC`,
    values
  );
}

/** READ: many plans → Map id → { stages: [{ stage_no, processes: [fromLine(…)] }], created_by, created_at, updated_by, updated_at }. */
export async function loadStages(ids = []) {
  const result = new Map();
  const planIds = uniqNums(ids);
  if (!planIds.length) return result;

  const rows = await dbQuery(`SELECT id, process, created_by, created_at, updated_by, updated_at FROM ${IP} WHERE id = ANY($1::int[])`, [planIds]);
  const m = await loadMasters(rows.flatMap((r) => (r.process?.stages || []).flatMap((st) => st.processes || [])));

  for (const r of rows) {
    const stages = (r.process?.stages || []).map((st) => ({
      stage_no: Number(st.stage),
      processes: (st.processes || []).map((line, i) => fromLine(line, i, m)),
    }));
    result.set(Number(r.id), { stages, created_by: r.created_by, created_at: r.created_at, updated_by: r.updated_by, updated_at: r.updated_at });
  }
  return result;
}

const softDelete = (client, id, user) =>
  client.query(`UPDATE ${IP} SET is_deleted = true, deleted_by = $2, deleted_at = NOW() WHERE id = $1 AND is_deleted = false`, [id, user]);

/** Insert / update the active row of (type, item_dcode). */
async function upsertPlan(client, { type, item_dcode, process, user }) {
  const { rows: found } = await client.query(
    `SELECT id FROM ${IP} WHERE type = $1 AND item_dcode = $2 AND is_deleted = false FOR UPDATE`,
    [type, item_dcode]
  );
  const json = JSON.stringify(process);
  // Two saves of the same item at once → the second hits the unique index (type, item_dcode): 409, not 500
  const insertRace = (err) => {
    if (err?.code === "23505") throw httpError(409, "This item was just saved by another request. Refresh and try again.");
    throw err;
  };
  if (found.length) {
    await client.query(
      `UPDATE ${IP}
       SET process = $2, updated_by = $3, updated_at = NOW(),
           is_approved = false, approved_by = NULL, approved_at = NULL
       WHERE id = $1`,
      [found[0].id, json, user]
    );
    return { id: Number(found[0].id), created: false };
  }
  const { rows } = await client.query(
    `INSERT INTO ${IP} (type, item_dcode, process, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [type, item_dcode, json, user]
  ).catch(insertRace);
  return { id: Number(rows[0].id), created: true };
}

/* ───────────────────────── Prime ───────────────────────── */

/** Insert / update the prime of a PRIME item (IMS PrimItemdcode = itself). Every FG on it sees the change. */
export async function savePrime({ item_dcode, processJson, user }) {
  const itemDcode = Number(item_dcode);
  if (!itemDcode) throw httpError(400, "Select a prime item.");
  if ((await resolvePrimeItemDcode(itemDcode)) !== itemDcode) {
    throw httpError(400, "This is a finish item — save its process in Finish Process Master.");
  }
  const stages = await buildStages(processJson, PROCESS_TYPE.PRIME);
  const process = buildProcessJson({ type: PROCESS_TYPE.PRIME, stages });
  return withTransaction((client) => upsertPlan(client, { type: PROCESS_TYPE.PRIME, item_dcode: itemDcode, process, user }));
}

/** Remove a prime. Blocked while any FG still stands on it (no prime → no FG). */
export async function deletePrime({ id, user }) {
  return withTransaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT id, item_dcode FROM ${IP} WHERE id = $1 AND type = ${PROCESS_TYPE.PRIME} AND is_deleted = false FOR UPDATE`,
      [id]
    );
    if (!found.length) throw httpError(404, "Prime process not found.");

    // FG rows whose item's prime item (IMS) is this prime's item
    const primeItem = Number(found[0].item_dcode);
    const { rows: fgRows } = await client.query(`SELECT item_dcode FROM ${IP} WHERE type = ${PROCESS_TYPE.FG} AND is_deleted = false`);
    const itemMap = await imsItemMap();
    const primeItemOf = (dcode) => Number(itemMap.get(canonicalCode(dcode))?.primitemdcode) || Number(dcode);
    const fg = fgRows.filter((r) => primeItemOf(r.item_dcode) === primeItem);
    if (fg.length) {
      const codes = fg.map((r) => itemMap.get(canonicalCode(r.item_dcode))?.item_code || r.item_dcode);
      throw httpError(409, `Finish process of ${codes.join(", ")} uses this prime. Delete their Finish process first.`);
    }
    await softDelete(client, id, user);
    return { id: Number(id) };
  });
}

/* ───────────────────────── FG ───────────────────────── */

/** Insert / update the finish item's own process on its prime item's prime (IMS PrimItemdcode, else itself). */
export async function saveFg({ item_dcode, processJson, user }) {
  const itemDcode = Number(item_dcode);
  if (!itemDcode) throw httpError(400, "Select a finish item.");
  const primeItem = await resolvePrimeItemDcode(itemDcode);
  const [primePlan] = await findPlans({ type: PROCESS_TYPE.PRIME, item_dcode: primeItem });
  if (!primePlan) throw httpError(400, "Prime process not found for this item's prime item. Save it in Prime Process Master first.");
  if (!primePlan.is_approved) {
    throw httpError(400, "Prime process is pending approval. Approve it in Engineering → Prime Process Master first.");
  }

  const stages = await buildStages(processJson, PROCESS_TYPE.FG);
  const process = buildProcessJson({ type: PROCESS_TYPE.FG, stages });
  return withTransaction((client) => upsertPlan(client, { type: PROCESS_TYPE.FG, item_dcode: itemDcode, process, user }));
}

/** Approve or revoke a plan row (Prime / Finish Process Master). */
export async function setPlanApproval({ type, id, approved, user }) {
  const planId = Number(id);
  if (!planId) throw httpError(400, "id is required.");
  const ok = approved === true;
  const [row] = await dbQuery(
    `UPDATE ${IP}
     SET is_approved = $3, approved_by = $4, approved_at = $5, updated_by = $6, updated_at = NOW()
     WHERE id = $1 AND type = $2 AND is_deleted = false
     RETURNING id`,
    [planId, type, ok, ok ? user : null, ok ? new Date() : null, user]
  );
  if (!row) throw httpError(404, "Process plan not found.");
  return { id: planId, is_approved: ok };
}

/** Delete a finish process. */
export async function deleteFg({ id, user }) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE ${IP} SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
       WHERE id = $1 AND type = ${PROCESS_TYPE.FG} AND is_deleted = false`,
      [id, user]
    );
    if (!rowCount) throw httpError(404, "Finish process not found.");
    return { id: Number(id) };
  });
}
