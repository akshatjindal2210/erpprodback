/**
 * v5.1.0 AUTO migration — eng_item_process becomes self-contained (no Item RM link). Safe to re-run.
 *
 *  1. FG rows get their own item_dcode (from rmstore_master_production.finish_id, read once here).
 *  2. Old flat `stages` lines → `process` JSON:
 *       { type: "prime" | "fg", stages: [{ stage, processes: [{ process, machines, rm }] }] }   (item = item_dcode column)
 *     (JSON saved by an earlier build: "finish" → "fg", `item_dcode` / `prime_item_dcode` keys removed)
 *  3. Nothing left → `stages` + `prime_id` columns dropped (an FG finds its prime by item, from IMS);
 *     rmstore_master_production.prime_id / finish_id dropped.
 *
 * Runs after processJsonToTables.js (file order), which already writes the new shape.
 */
import dbQuery from "../../config/db/db.js";
import { ENGINEERING_TABLES as E, RMSTORE_TABLES as R } from "../../config/db/dbTables.js";
import { columnExists, dropColumnsIfExist } from "../../config/db/ensureDbColumns.js";
import { PROCESS_TYPE, PROCESS_TYPE_KEY } from "../../apps/engineering/modules/item-process/models/itemProcess.model.js";

const TAG = "[v5.1.0 item process self-contained]";
const IP = E.ITEM_PROCESS;
const ITEM = R.MASTER_PRODUCTION;

/** [{ stage, process, machines, rm }] → [{ stage, processes: [{ process, machines, rm }] }] (line order kept). */
function groupLines(lines = []) {
  const stages = [];
  for (const l of lines || []) {
    let st = stages.find((s) => s.stage === Number(l.stage));
    if (!st) stages.push((st = { stage: Number(l.stage), processes: [] }));
    st.processes.push({ process: Number(l.process), machines: l.machines || [], rm: l.rm || [] });
  }
  return stages.sort((a, b) => a.stage - b.stage);
}

export default async function processSelfContained() {
  // 1. FG item from its Item RM row — the last time Engineering reads rmstore_master_production
  if (await columnExists(dbQuery, ITEM, "finish_id")) {
    await dbQuery(
      `UPDATE ${IP} ip SET item_dcode = m.item_dcode FROM ${ITEM} m
       WHERE m.finish_id = ip.id AND ip.type = ${PROCESS_TYPE.FG} AND ip.item_dcode IS NULL`
    );
  }

  // 2. stages → process
  if (await columnExists(dbQuery, IP, "stages")) {
    const rows = await dbQuery(`SELECT id, type, stages FROM ${IP} WHERE process IS NULL`);
    for (const r of rows) {
      const process = { type: PROCESS_TYPE_KEY[r.type] ?? String(r.type), stages: groupLines(r.stages) };
      await dbQuery(`UPDATE ${IP} SET process = $2 WHERE id = $1`, [r.id, JSON.stringify(process)]);
    }
    if (rows.length) console.log(`${TAG} ${rows.length} row(s) moved to process JSON.`);
    await dropColumnsIfExist(dbQuery, IP, ["stages"]);
  }

  // JSON from an earlier build: "type": "finish" → "fg", item_dcode / prime_item_dcode removed (key order of the rest kept)
  const oldJson = await dbQuery(
    `SELECT id, process FROM ${IP}
     WHERE process IS NOT NULL
       AND (process->>'item_dcode' IS NOT NULL OR process->>'prime_item_dcode' IS NOT NULL OR process->>'type' = 'finish')` // no `?` operator — dbQuery reads `?` as a placeholder
  );
  for (const r of oldJson) {
    const { item_dcode, prime_item_dcode, ...process } = r.process; // eslint-disable-line no-unused-vars
    if (process.type === "finish") process.type = PROCESS_TYPE_KEY[PROCESS_TYPE.FG];
    await dbQuery(`UPDATE ${IP} SET process = $2 WHERE id = $1`, [r.id, JSON.stringify(process)]);
  }

  // 3. Item RM link no longer used — drop once every active FG row knows its item
  const [{ pending }] = await dbQuery(
    `SELECT COUNT(*)::int AS pending FROM ${IP} WHERE is_deleted = false AND (item_dcode IS NULL OR process IS NULL)`
  );
  if (pending) return console.warn(`${TAG} ${pending} active row(s) without item / process — prime_id / finish_id kept.`);
  await dropColumnsIfExist(dbQuery, IP, ["prime_id"]);
  if (await columnExists(dbQuery, ITEM, "finish_id")) {
    await dbQuery(`DROP INDEX IF EXISTS rmstore_master_production_finish_idx`);
    await dropColumnsIfExist(dbQuery, ITEM, ["prime_id", "finish_id"]);
    console.log(`✅ ${TAG} prime_id / finish_id dropped from ${ITEM}.`);
  }
}
