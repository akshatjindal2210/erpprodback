import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";
import { findPrimeIdsByItems, loadStages } from "../../../../engineering/modules/item-process/models/itemProcess.model.js";
import { rmItemMap, labelStageRm } from "../../../../rmstore/modules/production/utils/erpItems.js";
import { sqlDocDtText } from "../../../../ims/modules/box/utils/inventory/boxInventorySql.js";
import { JC_START, jobCardNo } from "../jobCard.config.js";

/** Maintain Job Card — DB layer (prod_job_card, key = docno). */

const UPDATABLE = ["job_date", "status", "remarks", "process_plan", "approved", "approved_by", "approved_at", "updated_by", "updated_at"];

/** job_date as `YYYY-MM-DD` text (same as IMS doc_dt — no node-pg timezone shift). */
const READ_COLS = `docno, job_card_no, ${sqlDocDtText("job_date")} AS job_date, prime_item_dcode, qty, items, shortage_ids, process_plan, status, remarks,
              approved, approved_by, approved_at, created_by, created_at, updated_by, updated_at`;

/** Active job cards, newest first. approved: true → authorized · false → pending · undefined → all. */
export async function findAllJobCards({ approved } = {}) {
  const where = ["is_deleted = false"];
  const values = [];
  if (approved === true || approved === false) where.push(`approved = $${values.push(approved)}`);
  return dbQuery(`SELECT ${READ_COLS} FROM ${T.JOB_CARD} WHERE ${where.join(" AND ")} ORDER BY docno DESC`, values);
}

export async function findJobCard(docno) {
  const [row] = await dbQuery(`SELECT ${READ_COLS} FROM ${T.JOB_CARD} WHERE docno = $1 AND is_deleted = false`, [docno]);
  return row ?? null;
}

/**
 * Insert inside a transaction (new card = Pending).
 * docno = last docno + 1 (not below JC_START); the table lock stops two creates taking the same number.
 */
export async function insertJobCard(client, { prime_item_dcode, qty, items, shortage_ids, process_plan, remarks = null, created_by }) {
  await client.query(`LOCK TABLE ${T.JOB_CARD} IN EXCLUSIVE MODE`);
  const { rows } = await client.query(`SELECT GREATEST(COALESCE(MAX(docno), 0) + 1, $1::int) AS docno FROM ${T.JOB_CARD}`, [JC_START]);
  const docno = Number(rows[0].docno);

  const out = await client.query(
    `INSERT INTO ${T.JOB_CARD} (docno, job_card_no, prime_item_dcode, qty, items, shortage_ids, process_plan, remarks, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::int[], $7::jsonb, $8, $9)
     RETURNING ${READ_COLS}`,
    [docno, jobCardNo(docno), prime_item_dcode, qty, JSON.stringify(items), shortage_ids, JSON.stringify(process_plan), remarks, created_by]
  );
  return out.rows[0];
}

export async function updateJobCard(docno, fields = {}) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (!cols.length) return null;
  const values = cols.map((k) => (k === "process_plan" ? JSON.stringify(fields[k] ?? []) : fields[k]));
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD}
     SET ${cols.map((k, i) => `${k} = $${i + 2}${k === "process_plan" ? "::jsonb" : ""}`).join(", ")}
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`,
    [docno, ...values]
  );
  return row ?? null;
}

/** Soft delete — its shortage entries become free for a new job card. */
export async function softDeleteJobCard(docno, deletedBy) {
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD} SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`,
    [docno, deletedBy ?? null]
  );
  return row ?? null;
}

/**
 * Prime process of many prime items — Engineering → Prime Process Master (eng_item_process).
 * Returns Map item_dcode → stages.
 */
export async function loadPrimeProcesses(itemDcodes = []) {
  const result = new Map();
  const primeByItem = await findPrimeIdsByItems(itemDcodes);
  if (!primeByItem.size) return result;

  const stageMap = await loadStages([...primeByItem.values()]);
  const rmMap = await rmItemMap();
  for (const [itemDcode, primeId] of primeByItem) {
    const stages = stageMap.get(primeId)?.stages;
    if (stages?.length) result.set(itemDcode, await labelStageRm(stages, rmMap));
  }
  return result;
}

/** Prime process of one item (null when nothing saved). */
export async function findPrimeProcess(itemDcode) {
  return (await loadPrimeProcesses([itemDcode])).get(Number(itemDcode)) || null;
}
