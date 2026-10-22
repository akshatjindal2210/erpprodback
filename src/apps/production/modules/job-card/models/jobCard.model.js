import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E, IMS_TABLES } from "../../../../../config/db/dbTables.js";
import { findPrimeIdsByItems, loadStages, PROCESS_TYPE } from "../../../../engineering/modules/item-process/models/itemProcess.model.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { rmItemMap, labelStageRm } from "../../../../rmstore/modules/production/utils/erpItems.js";
import { sqlDocDtText } from "../../../../ims/modules/box/utils/inventory/boxInventorySql.js";
import { JC_START, jobCardNo, JOB_CARD_TYPE, JOB_CARD_TYPE_DEFAULT, JOB_CARD_TYPE_KEY } from "../jobCard.config.js";

/**
 * Maintain Job Card — DB layer (prod_job_card).
 * Stored here: type (jc=0 default | 2c=1 | …), shortage_ids (FK), remarks, tooling_*.
 * Joined from ims_shortage via shortage_ids: qty, items, shortage_approved, shortage_remark.
 */

export const JOB_CARD_STATUSES = ["Pending", "Planning", "Running", "Hold", "Complete"];
export { JOB_CARD_TYPE, JOB_CARD_TYPE_DEFAULT, JOB_CARD_TYPE_KEY };

/** JC whose shortage_ids are all ims_shortage.is_approved = true (joined — not stored on JC). */
export function shortageFullyApprovedSql(jcAlias = "") {
  const ids = jcAlias ? `${jcAlias}.shortage_ids` : "shortage_ids";
  return `(
    cardinality(${ids}) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(${ids}) AS sid(id)
      LEFT JOIN ${IMS_TABLES.SHORTAGE} s ON s.id = sid.id AND COALESCE(s.is_deleted, false) = false
      WHERE s.is_approved IS DISTINCT FROM true
    )
  )`;
}
const UPDATABLE = [
  "pldt", "schedule_shift", "status", "remarks", "process_plan", "shortage_ids",
  "approved", "approved_by", "approved_at",
  "tooling_approved", "tooling_remark", "tooling_by", "tooling_at",
  "updated_by", "updated_at",
];

const READ_COLS = `docno, pjobcardno, ${sqlDocDtText("pldt")} AS pldt, schedule_shift, type, itemdcode, shortage_ids, process_plan, status, remarks,
              approved, approved_by, approved_at,
              tooling_approved, tooling_remark, tooling_by, tooling_at,
              created_by, created_at, updated_by, updated_at`;

/** Register: JC type by default; only cards whose linked shortages are all approved (joined). */
export async function findAllJobCards({ approved, type = JOB_CARD_TYPE_DEFAULT } = {}) {
  const where = ["is_deleted = false", "type = $1", shortageFullyApprovedSql()];
  const values = [Number(type)];
  if (approved === true || approved === false) where.push(`approved = $${values.push(approved)}`);
  return dbQuery(`SELECT ${READ_COLS} FROM ${T.JOB_CARD} WHERE ${where.join(" AND ")} ORDER BY docno DESC`, values);
}

export async function findJobCard(docno) {
  const [row] = await dbQuery(`SELECT ${READ_COLS} FROM ${T.JOB_CARD} WHERE docno = $1 AND is_deleted = false`, [docno]);
  return row ?? null;
}

/** Open draft = JC whose shortages are not all approved yet (still pending on shortage side). */
export async function findOpenShortageDraft(primeKey, type = JOB_CARD_TYPE_DEFAULT) {
  const [row] = await dbQuery(
    `SELECT ${READ_COLS} FROM ${T.JOB_CARD}
     WHERE itemdcode = $1 AND type = $2 AND is_deleted = false AND NOT ${shortageFullyApprovedSql()}
     ORDER BY docno DESC LIMIT 1`,
    [Number(primeKey), Number(type)]
  );
  return row ?? null;
}

export async function findJobCardByShortageIds(primeKey, shortageIds = [], type = JOB_CARD_TYPE_DEFAULT) {
  const ids = [...new Set((shortageIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return null;
  const [row] = await dbQuery(
    `SELECT ${READ_COLS} FROM ${T.JOB_CARD}
     WHERE itemdcode = $1 AND type = $2 AND is_deleted = false AND shortage_ids @> $3::int[]
     ORDER BY docno DESC LIMIT 1`,
    [Number(primeKey), Number(type), ids]
  );
  return row ?? null;
}

/**
 * Join shortage lines via shortage_ids → qty, items, shortage_approved, shortage_remark.
 * Returns Map docno → { items, qty, shortage_approved, shortage_remark }
 */
export async function loadQtyItemsByShortageIds(cards = []) {
  const out = new Map();
  const allIds = [...new Set(cards.flatMap((c) => c.shortage_ids || []).map(Number).filter(Boolean))];
  if (!allIds.length) {
    for (const c of cards) out.set(c.docno, { items: [], qty: 0, shortage_approved: false, shortage_remark: null });
    return out;
  }

  const lines = await dbQuery(
    `SELECT id, itemdcode, qty, is_approved, approval_remark
     FROM ${IMS_TABLES.SHORTAGE}
     WHERE id = ANY($1::int[]) AND is_deleted = false`,
    [allIds]
  );
  const byId = new Map(lines.map((r) => [Number(r.id), r]));

  for (const c of cards) {
    const ids = (c.shortage_ids || []).map(Number).filter(Boolean);
    const qtyByItem = new Map();
    const remarks = [];
    let allApproved = ids.length > 0;

    for (const sid of ids) {
      const row = byId.get(sid);
      if (!row || row.is_approved !== true) allApproved = false;
      if (!row) continue;
      const dcode = Number(row.itemdcode);
      qtyByItem.set(dcode, (qtyByItem.get(dcode) || 0) + (Number(row.qty) || 0));
      const r = String(row.approval_remark ?? "").trim();
      if (r) remarks.push(r);
    }

    const items = [...qtyByItem].map(([itemdcode, qty]) => ({ itemdcode, qty }));
    out.set(c.docno, {
      items,
      qty: items.reduce((s, it) => s + it.qty, 0),
      shortage_approved: allApproved,
      shortage_remark: [...new Set(remarks)].join(" | ") || null,
    });
  }
  return out;
}

export async function insertJobCard(client, {
  itemdcode, shortage_ids, process_plan = [], remarks = null, created_by,
  type = JOB_CARD_TYPE_DEFAULT,
  status = "Pending",
  approved = false, approved_by = null, approved_at = null,
  tooling_approved = null, tooling_remark = null,
  tooling_by = null, tooling_at = null,
}) {
  await client.query(`LOCK TABLE ${T.JOB_CARD} IN EXCLUSIVE MODE`);
  const { rows } = await client.query(`SELECT GREATEST(COALESCE(MAX(docno), 0) + 1, $1::int) AS docno FROM ${T.JOB_CARD}`, [JC_START]);
  const docno = Number(rows[0].docno);
  const cardType = Number.isFinite(Number(type)) ? Number(type) : JOB_CARD_TYPE_DEFAULT;
  const toolingDecided = tooling_approved === true || tooling_approved === false;

  const out = await client.query(
    `INSERT INTO ${T.JOB_CARD} (
       docno, pjobcardno, type, itemdcode, shortage_ids, process_plan, status, remarks, created_by,
       approved, approved_by, approved_at, tooling_approved, tooling_remark, tooling_by, tooling_at
     )
     VALUES ($1, $2, $3, $4, $5::int[], $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${READ_COLS}`,
    [
      docno, jobCardNo(docno), cardType, itemdcode, shortage_ids, JSON.stringify(process_plan ?? []), status, remarks, created_by,
      approved === true, approved === true ? approved_by : null, approved === true ? approved_at : null,
      toolingDecided ? tooling_approved === true : null,
      tooling_remark ?? null,
      toolingDecided ? (tooling_by ?? null) : null,
      toolingDecided ? (tooling_at ?? null) : null,
    ]
  );
  return out.rows[0];
}

export async function updateJobCard(docno, fields = {}) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (!cols.length) return null;
  const values = cols.map((k) => (k === "process_plan" ? JSON.stringify(fields[k] ?? []) : fields[k]));
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD}
     SET ${cols.map((k, i) => `${k} = $${i + 2}${k === "process_plan" ? "::jsonb" : k === "shortage_ids" ? "::int[]" : ""}`).join(", ")}
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`,
    [docno, ...values]
  );
  return row ?? null;
}

export async function softDeleteJobCard(docno, deletedBy) {
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD} SET is_deleted = true, deleted_by = $2, deleted_at = NOW()
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`,
    [docno, deletedBy ?? null]
  );
  return row ?? null;
}

/** Shortage create → draft JC (status Pending). Only shortage_ids stored; approval comes from shortage join. */
export async function ensureDraftJobCardForShortage({ primeKey, shortageId, user, type = JOB_CARD_TYPE_DEFAULT }) {
  const prime = Number(primeKey);
  const sid = Number(shortageId);
  if (!prime || !sid) return null;

  const draft = await findOpenShortageDraft(prime, type);
  if (draft) {
    const ids = [...new Set([...(draft.shortage_ids || []), sid])];
    return updateJobCard(draft.docno, {
      shortage_ids: ids,
      updated_by: user ?? null,
      updated_at: new Date(),
    });
  }

  return withTransaction(async (client) =>
    insertJobCard(client, {
      type,
      itemdcode: prime,
      shortage_ids: [sid],
      process_plan: [],
      status: "Pending",
      created_by: user ?? "system",
    })
  );
}

/**
 * Shortage approve → ensure JC exists with shortage_ids (approval itself is on ims_shortage).
 * Shortage reject → clear tooling on linked JCs (shortage_approved becomes false via join).
 */
export async function applyShortageDecisionToJobCards({
  primeKeys, approved, user, shortageIdsByPrime = null, type = JOB_CARD_TYPE_DEFAULT,
}) {
  const keys = [...new Set((primeKeys || []).map(Number).filter(Boolean))];
  if (!keys.length) return 0;
  const cardType = Number(type);

  if (approved === true) {
    for (const key of keys) {
      const existing = await dbQuery(
        `SELECT docno, shortage_ids FROM ${T.JOB_CARD}
         WHERE is_deleted = false AND type = $1 AND itemdcode = $2
         ORDER BY docno DESC LIMIT 1`,
        [cardType, key]
      );
      const ids = shortageIdsByPrime?.get?.(key) || [];
      if (existing.length) {
        if (ids.length) {
          const merged = [...new Set([...(existing[0].shortage_ids || []).map(Number), ...ids.map(Number)].filter(Boolean))];
          await updateJobCard(existing[0].docno, {
            shortage_ids: merged,
            updated_by: user ?? null,
            updated_at: new Date(),
          });
        }
        continue;
      }
      if (!ids.length) continue;
      await withTransaction(async (client) =>
        insertJobCard(client, {
          type: cardType,
          itemdcode: key,
          shortage_ids: ids,
          process_plan: [],
          status: "Pending",
          created_by: user ?? "system",
        })
      );
    }
    return keys.length;
  }

  const result = await dbQuery(
    `UPDATE ${T.JOB_CARD}
     SET tooling_approved = NULL,
         tooling_remark = NULL,
         tooling_by = NULL,
         tooling_at = NULL,
         updated_by = $3,
         updated_at = NOW()
     WHERE is_deleted = false
       AND type = $1
       AND itemdcode = ANY($2::int[])
     RETURNING docno`,
    [cardType, keys, user ?? null]
  );
  return result.length;
}

export async function listJobCardsForTooling(register, type = JOB_CARD_TYPE_DEFAULT) {
  const approved = shortageFullyApprovedSql();
  // Pending: decision not taken (NULL). Register: decided (true = Yes, false = No).
  const where = register
    ? `is_deleted = false AND type = $1 AND ${approved} AND tooling_approved IS NOT NULL`
    : `is_deleted = false AND type = $1 AND ${approved} AND tooling_approved IS NULL`;
  return dbQuery(
    `SELECT DISTINCT ON (itemdcode)
        docno, pjobcardno, type, itemdcode AS item_dcode,
        tooling_approved AS approved, tooling_remark AS remark,
        tooling_by, tooling_at,
        shortage_ids
     FROM ${T.JOB_CARD}
     WHERE ${where}
     ORDER BY itemdcode, docno DESC`,
    [Number(type)]
  );
}

export async function saveJobCardTooling({ primeKey, tooling, remark, user, type = JOB_CARD_TYPE_DEFAULT }) {
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD}
     SET tooling_approved = $2,
         tooling_remark = $3,
         tooling_by = $4,
         tooling_at = NOW(),
         updated_by = $4,
         updated_at = NOW()
     WHERE docno = (
       SELECT docno FROM ${T.JOB_CARD}
       WHERE itemdcode = $1 AND type = $5 AND is_deleted = false AND ${shortageFullyApprovedSql()}
       ORDER BY docno DESC LIMIT 1
     )
     RETURNING ${READ_COLS}`,
    [Number(primeKey), tooling, remark ?? null, user ?? null, Number(type)]
  );
  return row ?? null;
}

export async function resetJobCardToolingToPending({ primeKey, user, type = JOB_CARD_TYPE_DEFAULT }) {
  const [row] = await dbQuery(
    `UPDATE ${T.JOB_CARD}
     SET tooling_approved = NULL,
         tooling_remark = NULL,
         tooling_by = NULL,
         tooling_at = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE docno = (
       SELECT docno FROM ${T.JOB_CARD}
       WHERE itemdcode = $1 AND type = $3 AND is_deleted = false AND tooling_approved IS NOT NULL
       ORDER BY docno DESC LIMIT 1
     )
     RETURNING ${READ_COLS}`,
    [Number(primeKey), user ?? null, Number(type)]
  );
  return row ?? null;
}

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

export async function checkPrimeAndFinish(primeDcode, itemDcodes = []) {
  const prime = Number(primeDcode);
  const items = [...new Set(itemDcodes.map(Number))];

  const rows = await dbQuery(
    `SELECT type, item_dcode, is_approved FROM ${E.ITEM_PROCESS} WHERE is_deleted = false AND item_dcode = ANY($1::int[])`,
    [[prime, ...items]]
  );
  const findRow = (type, dcode) => rows.find((r) => Number(r.type) === type && Number(r.item_dcode) === dcode);

  const { itemMap } = await getImsMapsSafe();
  const codeOf = (dcode) => itemMap.get(canonicalCode(dcode))?.item_code || String(dcode);

  const primeRow = findRow(PROCESS_TYPE.PRIME, prime);
  if (!primeRow) return `Prime Process not saved for ${codeOf(prime)}. Save it in Engineering → Prime Process Master.`;
  if (!primeRow.is_approved) return `Prime Process of ${codeOf(prime)} is pending approval. Approve it in Engineering → Prime Process Master.`;

  const notSaved = items.filter((d) => !findRow(PROCESS_TYPE.FG, d));
  if (notSaved.length) return `Finish Process not saved for ${notSaved.map(codeOf).join(", ")}. Save it in Engineering → Finish Process Master.`;

  const notApproved = items.filter((d) => !findRow(PROCESS_TYPE.FG, d).is_approved);
  if (notApproved.length) return `Finish Process pending approval for ${notApproved.map(codeOf).join(", ")}. Approve it in Engineering → Finish Process Master.`;

  return null;
}

export async function findPrimeProcess(itemDcode) {
  return (await loadPrimeProcesses([itemDcode])).get(Number(itemDcode)) || null;
}
