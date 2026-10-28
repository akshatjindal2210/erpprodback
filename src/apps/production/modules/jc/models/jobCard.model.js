import dbQuery, { withTransaction } from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T, ENGINEERING_TABLES as E, IMS_TABLES } from "../../../../../config/db/dbTables.js";
import { findPrimeIdsByItems, loadStages, PROCESS_TYPE } from "../../../../engineering/modules/item-process/models/itemProcess.model.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { rmItemMap, labelStageRm } from "../../../../rmstore/modules/production/utils/erpItems.js";
import { sqlDocDtText } from "../../../../ims/modules/box/utils/inventory/boxInventorySql.js";
import { formatPJobCardNo, JC_START, JOB_CARD_TYPE, JOB_CARD_TYPE_DEFAULT, JOB_CARD_TYPE_KEY } from "../jobCard.config.js";
import { JC_SERIES_CODE, nextJobcardno, resolveFyidForJobCard } from "../jobCardErp.js";

/**
 * Maintain Job Card — DB layer (prod_job_card).
 * Stored here: type (jc=0 default | 2c=1 | …), remarks, tooling_*.
 * Shortage lines joined via ims_shortage.docno → prod_job_card.docno.
 */

export const JOB_CARD_STATUSES = ["Pending", "Planning", "Running", "Hold", "Complete"];
export { JOB_CARD_TYPE, JOB_CARD_TYPE_DEFAULT, JOB_CARD_TYPE_KEY };

/** Linked shortages (ims_shortage.docno) all is_accepted = true. */
export function shortageFullyApprovedSql(jcAlias = "") {
  const doc = jcAlias ? `${jcAlias}.docno` : "docno";
  return `(
    EXISTS (
      SELECT 1 FROM ${IMS_TABLES.SHORTAGE} s
      WHERE s.docno = ${doc} AND COALESCE(s.is_deleted, false) = false
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${IMS_TABLES.SHORTAGE} s
      WHERE s.docno = ${doc} AND COALESCE(s.is_deleted, false) = false
        AND s.is_accepted IS DISTINCT FROM true
    )
  )`;
}

const UPDATABLE = [
  "jobcarddt", "schedule_shift", "status", "remarks", "process_plan", "planqty",
  "approved", "approved_by", "approved_at",
  "tooling_approved", "tooling_remark", "tooling_by", "tooling_at",
  "updated_by", "updated_at",
];

const JSONB_COLS = new Set(["process_plan"]);

/** Set ims_shortage.docno for shortage lines (optional: only rows with docno IS NULL). */
async function linkShortageIdsToDocno(docno, shortageIds, { onlyWhenDocnoNull = true } = {}, client = null) {
  const jcDocno = Number(docno);
  const ids = [...new Set((shortageIds || []).map(Number).filter(Boolean))];
  if (!jcDocno || !ids.length) return;
  const nullFilter = onlyWhenDocnoNull ? " AND docno IS NULL" : "";
  const sql = `UPDATE ${IMS_TABLES.SHORTAGE} SET docno = $1 WHERE id = ANY($2::int[]) AND COALESCE(is_deleted, false) = false${nullFilter}`;
  const params = [jcDocno, ids];
  if (client) await client.query(sql, params);
  else await dbQuery(sql, params);
}

const READ_COLS = `docno, pjobcardno, ${sqlDocDtText("jobcarddt")} AS jobcarddt, schedule_shift, type, itemdcode, process_plan, status, remarks,
              jobcardno, jcseriescode, fyid, planqty,
              approved, approved_by, approved_at,
              tooling_approved, tooling_remark, tooling_by, tooling_at,
              created_by, created_at, updated_by, updated_at`;

/** Register: JC type by default; only cards whose linked shortages are all approved (joined). */
export async function findAllJobCards({ approved, type = JOB_CARD_TYPE_DEFAULT } = {}) {
  const where = ["is_deleted = false", "type = $1", shortageFullyApprovedSql()];
  const values = [Number(type)];
  if (approved === true || approved === false) where.push(`approved = $${values.push(approved)}`);
  return dbQuery(`SELECT ${READ_COLS} FROM ${T.JC} WHERE ${where.join(" AND ")} ORDER BY docno DESC`, values);
}

export async function findJobCard(docno) {
  const [row] = await dbQuery(`SELECT ${READ_COLS} FROM ${T.JC} WHERE docno = $1 AND is_deleted = false`, [docno]);
  return row ?? null;
}

export async function findJobCardByShortageIds(shortageIds = []) {
  const ids = [...new Set((shortageIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return null;

  const shortages = await dbQuery(
    `SELECT id, itemdcode, is_accepted, docno FROM ${IMS_TABLES.SHORTAGE}
     WHERE id = ANY($1::int[]) AND COALESCE(is_deleted, false) = false`,
    [ids]
  );
  if (!shortages.length) return null;

  let stubDocno = null;
  for (const d of [...new Set(shortages.map((s) => Number(s.docno)).filter(Boolean))]) {
    const jc = await findJobCard(d);
    if (jc) stubDocno = d;
    else {
      await dbQuery(
        `UPDATE ${IMS_TABLES.SHORTAGE} SET docno = NULL WHERE id = ANY($1::int[]) AND docno = $2`,
        [ids, d]
      );
    }
  }
  if (stubDocno) {
    await linkShortageIdsToDocno(stubDocno, ids);
    return findJobCard(stubDocno);
  }

  if (!shortages.every((s) => s.is_accepted === true)) return null;

  const { itemMap } = await getImsMapsSafe();
  const primeOf = (d) => Number(itemMap.get(canonicalCode(d))?.primitemdcode) || Number(d);
  const primeKeys = [...new Set(shortages.map((s) => primeOf(s.itemdcode)).filter(Boolean))];
  if (primeKeys.length !== 1) return null;

  // Prefer open stub; else reuse existing JC for this prime (avoid second card after authorize).
  const [stub] = await dbQuery(
    `SELECT ${READ_COLS} FROM ${T.JC}
     WHERE is_deleted = false AND itemdcode = $1
     ORDER BY
       CASE WHEN approved IS DISTINCT FROM true AND jobcardno IS NULL THEN 0 ELSE 1 END,
       docno DESC
     LIMIT 1`,
    [primeKeys[0]]
  );
  if (stub) {
    await linkShortageIdsToDocno(stub.docno, ids);
    return stub;
  }

  await applyShortageDecisionToJobCards({
    primeKeys: [primeKeys[0]],
    approved: true,
    user: "system",
    shortageIdsByPrime: new Map([[primeKeys[0], ids]]),
  });
  const [linked] = await dbQuery(
    `SELECT docno FROM ${IMS_TABLES.SHORTAGE}
     WHERE id = ANY($1::int[]) AND docno IS NOT NULL LIMIT 1`,
    [ids]
  );
  return linked?.docno ? findJobCard(Number(linked.docno)) : null;
}

/**
 * Shortage lines via ims_shortage.docno → qty, items, shortage_approved, shortage_remark.
 * Returns Map docno → { items, qty, shortage_approved, shortage_remark, shortage_count }
 */
export async function loadQtyItemsByShortageIds(cards = []) {
  const empty = { items: [], qty: 0, shortage_approved: false, shortage_remark: null, shortage_count: 0 };
  const out = new Map();
  const jcDocnos = [...new Set(cards.map((c) => Number(c.docno)).filter(Boolean))];
  if (!jcDocnos.length) {
    for (const c of cards) out.set(c.docno, { ...empty });
    return out;
  }

  const lines = await dbQuery(
    `SELECT id, itemdcode, qty, is_accepted, accepted_remark, docno
     FROM ${IMS_TABLES.SHORTAGE}
     WHERE COALESCE(is_deleted, false) = false AND docno = ANY($1::int[])`,
    [jcDocnos]
  );
  const byId = new Map(lines.map((r) => [Number(r.id), r]));
  const idsByJc = new Map();
  for (const r of lines) {
    const d = Number(r.docno);
    if (!d) continue;
    if (!idsByJc.has(d)) idsByJc.set(d, []);
    idsByJc.get(d).push(Number(r.id));
  }

  for (const c of cards) {
    const ids = idsByJc.get(Number(c.docno)) || [];
    const qtyByItem = new Map();
    const remarks = [];
    let allApproved = ids.length > 0;

    for (const sid of ids) {
      const row = byId.get(sid);
      if (!row || row.is_accepted !== true) allApproved = false;
      if (!row) continue;
      const dcode = Number(row.itemdcode);
      qtyByItem.set(dcode, (qtyByItem.get(dcode) || 0) + (Number(row.qty) || 0));
      const r = String(row.accepted_remark ?? "").trim();
      if (r) remarks.push(r);
    }

    const items = [...qtyByItem].map(([itemdcode, qty]) => ({ itemdcode, qty }));
    out.set(c.docno, {
      items,
      qty: items.reduce((s, it) => s + it.qty, 0),
      shortage_approved: allApproved,
      shortage_remark: [...new Set(remarks)].join(" | ") || null,
      shortage_count: ids.length,
    });
  }
  return out;
}

/** Sum shortage qty for planqty default. */
export async function sumShortageQty(shortageIds = [], client = null) {
  const ids = [...new Set((shortageIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const sql = `SELECT COALESCE(SUM(qty), 0)::float AS q FROM ${IMS_TABLES.SHORTAGE}
               WHERE id = ANY($1::int[]) AND COALESCE(is_deleted, false) = false`;
  if (client) {
    const { rows } = await client.query(sql, [ids]);
    return Number(rows[0]?.q) || 0;
  }
  const [row] = await dbQuery(sql, [ids]);
  return Number(row?.q) || 0;
}

/** First New save with plan — assign ERP jobcardno / fyid / pjobcardno. */
export async function assignErpNumbersToJobCard(docno, { jobcarddt, fyid, jobcardnoOverride } = {}, client) {
  const [row] = await client.query(
    `SELECT docno, jobcardno, jcseriescode FROM ${T.JC} WHERE docno = $1 AND is_deleted = false FOR UPDATE`,
    [docno]
  ).then((r) => r.rows);
  if (!row || row.jobcardno != null) return null;

  const dt = String(jobcarddt ?? "").trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
  const resolvedFy = await resolveFyidForJobCard(dt, fyid);
  const seriesCode = Number(row.jcseriescode) || JC_SERIES_CODE;
  let jobcardno;
  if (jobcardnoOverride != null && jobcardnoOverride !== "") {
    jobcardno = Number(jobcardnoOverride);
  } else {
    jobcardno = await nextJobcardno(seriesCode, resolvedFy, client);
  }
  const cardType = JOB_CARD_TYPE_DEFAULT;
  const pjobcardno = formatPJobCardNo(cardType, jobcardno);
  const out = await client.query(
    `UPDATE ${T.JC}
     SET jobcardno = $2, fyid = $3, jcseriescode = $4, pjobcardno = $5, jobcarddt = $6::date
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`,
    [docno, jobcardno, resolvedFy, seriesCode, pjobcardno, dt]
  );
  return out.rows[0] ?? null;
}

/** `client` optional — pass transaction client when pairing with process log inserts. */
export async function updateJobCard(docno, fields = {}, client = null) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (!cols.length) return null;
  const values = cols.map((k) => (JSONB_COLS.has(k) ? JSON.stringify(fields[k] ?? []) : fields[k]));
  const sql = `UPDATE ${T.JC}
     SET ${cols.map((k, i) => `${k} = $${i + 2}${JSONB_COLS.has(k) ? "::jsonb" : ""}`).join(", ")}
     WHERE docno = $1 AND is_deleted = false
     RETURNING ${READ_COLS}`;
  const params = [docno, ...values];
  if (client) {
    const out = await client.query(sql, params);
    return out.rows[0] ?? null;
  }
  const [row] = await dbQuery(sql, params);
  return row ?? null;
}

/** Linked shortage lines → pending again (is_accepted / accepted_remark / docno cleared). */
async function resetShortageApprovalForJobCard(shortageIds, jcDocno, client = null) {
  const ids = [...new Set((shortageIds || []).map(Number).filter(Boolean))];
  const docno = Number(jcDocno) || 0;
  if (!ids.length && !docno) return 0;
  const run = client
    ? (sql, params) => client.query(sql, params).then((r) => r.rows)
    : (sql, params) => dbQuery(sql, params);
  const rows = await run(
    `UPDATE ${IMS_TABLES.SHORTAGE}
     SET is_accepted = NULL, accepted_remark = NULL, docno = NULL
     WHERE COALESCE(is_deleted, false) = false
       AND (($1::int > 0 AND docno = $1) OR (cardinality($2::int[]) > 0 AND id = ANY($2::int[])))
     RETURNING id`,
    [docno, ids]
  );
  return rows.length;
}

/** Hard delete — reset linked shortages, then job card row (plan lines/history cascade). */
export async function hardDeleteJobCard(docno, client = null) {
  const id = Number(docno);
  if (!id) return null;
  const run = client
    ? (sql, params) => client.query(sql, params).then((r) => r.rows)
    : (sql, params) => dbQuery(sql, params);

  const [row] = await run(
    `SELECT ${READ_COLS} FROM ${T.JC} WHERE docno = $1 AND is_deleted = false`,
    [id]
  );
  if (!row) return null;

  await resetShortageApprovalForJobCard([], id, client);
  await run(`DELETE FROM ${T.JC} WHERE docno = $1`, [id]);
  return row;
}

/**
 * Accept → stub JC (docno + planqty, no ERP no). Reject → clear docno + drop empty stubs.
 */
export async function applyShortageDecisionToJobCards({
  primeKeys, approved, user, shortageIdsByPrime = null, type = JOB_CARD_TYPE_DEFAULT, client = null,
}) {
  const keys = [...new Set((primeKeys || []).map(Number).filter(Boolean))];
  if (!keys.length) return 0;
  const cardType = Number(type);
  const run = (sql, params) =>
    client ? client.query(sql, params).then((r) => r.rows) : dbQuery(sql, params);

  if (approved === true) {
    for (const key of keys) {
      const ids = shortageIdsByPrime?.get?.(key) || [];
      if (!ids.length) continue;

      let existingStubDocno = null;
      const docRows = await run(
        `SELECT DISTINCT docno FROM ${IMS_TABLES.SHORTAGE}
         WHERE id = ANY($1::int[]) AND docno IS NOT NULL`,
        [ids]
      );
      for (const r of docRows) {
        const d = Number(r.docno);
        if (await findJobCard(d)) existingStubDocno = d;
        else {
          await run(
            `UPDATE ${IMS_TABLES.SHORTAGE} SET docno = NULL WHERE id = ANY($1::int[]) AND docno = $2`,
            [ids, d]
          );
        }
      }
      if (!existingStubDocno) {
        // Reuse any JC for this prime (open stub first) — one card per prime item.
        const [existingJc] = await run(
          `SELECT docno FROM ${T.JC}
           WHERE is_deleted = false AND itemdcode = $1
           ORDER BY
             CASE WHEN approved IS DISTINCT FROM true AND jobcardno IS NULL THEN 0 ELSE 1 END,
             docno DESC
           LIMIT 1`,
          [key]
        );
        if (existingJc?.docno) existingStubDocno = Number(existingJc.docno);
      }
      if (existingStubDocno) {
        await linkShortageIdsToDocno(existingStubDocno, ids, { onlyWhenDocnoNull: false }, client);
        continue;
      }

      const planqty = await sumShortageQty(ids, client);
      const who = user ?? "system";
      const insertStub = async (tx) => {
        await tx.query(`LOCK TABLE ${T.JC} IN EXCLUSIVE MODE`);
        const { rows: dr } = await tx.query(
          `SELECT GREATEST(COALESCE(MAX(docno), 0) + 1, $1::int) AS docno FROM ${T.JC}`,
          [JC_START]
        );
        const jcDocno = Number(dr[0].docno);
        await tx.query(
          `INSERT INTO ${T.JC} (docno, pjobcardno, type, itemdcode, process_plan, status, created_by, planqty, jcseriescode)
           VALUES ($1, NULL, $2, $3, '[]'::jsonb, 'Pending', $4, $5, $6)`,
          [jcDocno, cardType, key, who, Number(planqty) || 0, JC_SERIES_CODE]
        );
        await linkShortageIdsToDocno(jcDocno, ids, { onlyWhenDocnoNull: false }, tx);
      };
      if (client) await insertStub(client);
      else await withTransaction(insertStub);
    }
    return keys.length;
  }

  const shortageIds = [
    ...new Set(keys.flatMap((k) => shortageIdsByPrime?.get?.(k) || []).map(Number).filter(Boolean)),
  ];
  let stubDocnos = [];
  if (shortageIds.length) {
    const cleared = await run(
      `WITH u AS (
         UPDATE ${IMS_TABLES.SHORTAGE} SET docno = NULL
         WHERE id = ANY($1::int[]) AND COALESCE(is_deleted, false) = false
         RETURNING docno
       )
       SELECT DISTINCT docno FROM u WHERE docno IS NOT NULL`,
      [shortageIds]
    );
    stubDocnos = cleared.map((r) => Number(r.docno)).filter(Boolean);
  }
  if (stubDocnos.length) {
    await run(
      `DELETE FROM ${T.JC} WHERE docno = ANY($1::int[]) AND jobcardno IS NULL AND is_deleted = false`,
      [stubDocnos]
    );
  }
  await run(
    `UPDATE ${T.JC}
     SET tooling_approved = NULL, tooling_remark = NULL, tooling_by = NULL, tooling_at = NULL,
         updated_by = $3, updated_at = NOW()
     WHERE is_deleted = false AND type = $1 AND itemdcode = ANY($2::int[])`,
    [cardType, keys, user ?? null]
  );
  return keys.length;
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
        tooling_by, tooling_at
     FROM ${T.JC}
     WHERE ${where}
     ORDER BY itemdcode, docno DESC`,
    [Number(type)]
  );
}

export async function saveJobCardTooling({ primeKey, tooling, remark, user, type = JOB_CARD_TYPE_DEFAULT }) {
  const [row] = await dbQuery(
    `UPDATE ${T.JC}
     SET tooling_approved = $2,
         tooling_remark = $3,
         tooling_by = $4,
         tooling_at = NOW(),
         updated_by = $4,
         updated_at = NOW()
     WHERE docno = (
       SELECT docno FROM ${T.JC}
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
    `UPDATE ${T.JC}
     SET tooling_approved = NULL,
         tooling_remark = NULL,
         tooling_by = NULL,
         tooling_at = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE docno = (
       SELECT docno FROM ${T.JC}
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
