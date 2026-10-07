import dbQuery from "../../../../../config/db/db.js";
import { withTransaction } from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.ISSUE_REQUEST_JOB_CARD;
const IR_TABLE = T.ISSUE_REQUEST;
const COIL_TABLE = T.COIL_TABLE;
const OUT_ENTRY = T.OUT_ENTRY;
const OUT_SCANNED = T.OUT_ENTRY_SCANNED_COIL;

const jcMetaKey = (jc) => String(jc || "").replace(/^JC[\s\-]*/i, "").trim().toUpperCase();

function registerMetaRow(r) {
  if (!r) return null;
  return {
    pjobcardno: r.pjobcardno ? String(r.pjobcardno).trim() : null,
    macname: r.macname ? String(r.macname).trim() : null,
    fg_item_code: r.fg_item_code ? String(r.fg_item_code).trim() : null,
    fg_item_desc: r.fg_item_desc ? String(r.fg_item_desc).trim() : null,
    rm_item_code: r.rm_item_code ? String(r.rm_item_code).trim() : null,
    rm_item_desc: r.rm_item_desc ? String(r.rm_item_desc).trim() : null,
  };
}

function normalizeJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Total coils from MRN-quota JSON (or legacy per-coil rows). */
export function coilCountFromCoilsJson(raw) {
  let n = 0;
  for (const c of normalizeJsonArray(raw)) {
    const cnt = Number(c?.coil_count);
    if (Number.isFinite(cnt) && cnt > 0 && String(c?.mrn_uid || "").trim()) {
      n += Math.floor(cnt);
      continue;
    }
    if (String(c?.coil_no_uid || "").trim()) n += 1;
  }
  return n;
}

/**
 * Persist shape: MRN quotas only — no specific coil_no_uid.
 * Accepts FE coil picks `{coil_no_uid, qty, mrn_uid}` OR quotas `{mrn_uid, coil_count, qty}`.
 */
export function aggregateToMrnQuotas(raw) {
  const map = new Map();
  for (const c of normalizeJsonArray(raw)) {
    const mrn_uid = String(c?.mrn_uid || "").trim();
    if (!mrn_uid) continue;
    const qty = Number(c?.qty);
    const safeQty = Number.isFinite(qty) ? qty : 0;
    const explicitCount = Number(c?.coil_count);
    const addCount =
      Number.isFinite(explicitCount) && explicitCount > 0
        ? Math.floor(explicitCount)
        : String(c?.coil_no_uid || "").trim()
          ? 1
          : 0;
    if (addCount <= 0 && safeQty <= 0) continue;
    const prev = map.get(mrn_uid) || { mrn_uid, coil_count: 0, qty: 0 };
    prev.coil_count += addCount > 0 ? addCount : 0;
    prev.qty += safeQty;
    map.set(mrn_uid, prev);
  }
  return [...map.values()].filter((q) => q.coil_count > 0);
}

/** API shape (matches legacy job_cards JSONB). */
export function jobCardRowToApi(row) {
  if (!row) return null;
  const coils = normalizeJsonArray(row.coils);
  return {
    pjobcardno: row.pjobcardno ?? null,
    pldt: row.pldt ?? null,
    macname: row.macname ?? null,
    item_code: row.item_code ?? null,
    itemdcode: row.item_dcode ?? null,
    item_desc: row.item_desc ?? null,
    itemdesc: row.item_desc ?? null,
    rm_item_dcode: row.rm_item_dcode ?? null,
    rm_item_code: row.rm_item_code ?? null,
    rm_item_desc: row.rm_item_desc ?? null,
    planqty: row.planqty ?? 0,
    issue_qty: row.issue_qty ?? 0,
    part_weight: row.part_weight ?? 0,
    rm_weight: row.rm_weight ?? 0,
    coil_count: coilCountFromCoilsJson(coils),
    coils,
  };
}

/** DB write: only `{ mrn_uid, coil_count, qty }`. */
function normalizeCoilPayload(raw) {
  return aggregateToMrnQuotas(raw);
}

function jobCardPayloadToRow(issue_uid, raw, userName) {
  const coils = normalizeCoilPayload(raw?.coils);
  return {
    issue_uid: Number(issue_uid),
    pjobcardno: String(raw?.pjobcardno || "").trim(),
    pldt: raw?.pldt ?? null,
    macname: raw?.macname ?? null,
    item_dcode: raw?.itemdcode ?? raw?.item_dcode ?? null,
    item_code: raw?.item_code ?? null,
    item_desc: raw?.itemdesc ?? raw?.item_desc ?? null,
    rm_item_dcode: raw?.rm_item_dcode ?? null,
    rm_item_code: raw?.rm_item_code ?? null,
    rm_item_desc: raw?.rm_item_desc ?? null,
    planqty: Number(raw?.planqty ?? raw?.plan_qty ?? 0) || 0,
    issue_qty: Number(raw?.issue_qty ?? 0) || 0,
    part_weight: Number(raw?.part_weight ?? 0) || 0,
    rm_weight: Number(raw?.rm_weight ?? 0) || 0,
    coils: JSON.stringify(coils),
    created_by: userName ?? null,
  };
}

export const findActiveJobCardsByIssueUid = async (issue_uid, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return [];
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  return run(
    `SELECT *
     FROM ${TABLE}
     WHERE issue_uid = $1 AND is_deleted = false
     ORDER BY id ASC`,
    [id]
  );
};

export const softDeleteJobCardsByIssueUid = async (issue_uid, deleted_by = null, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return;
  const run = client?.query
    ? async (sql, params) => client.query(sql, params)
    : async (sql, params) => dbQuery(sql, params);
  await run(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE issue_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};

export const insertIssueRequestJobCard = async (data, { client = null } = {}) => {
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  const rows = await run(
    `INSERT INTO ${TABLE}
     (issue_uid, pjobcardno, pldt, macname, item_dcode, item_code, item_desc,
      rm_item_dcode, rm_item_code, rm_item_desc,
      planqty, issue_qty, part_weight, rm_weight, coils, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
     RETURNING *`,
    [
      data.issue_uid,
      data.pjobcardno,
      data.pldt,
      data.macname,
      data.item_dcode,
      data.item_code,
      data.item_desc,
      data.rm_item_dcode,
      data.rm_item_code,
      data.rm_item_desc,
      data.planqty,
      data.issue_qty,
      data.part_weight,
      data.rm_weight,
      data.coils,
      data.created_by,
    ]
  );
  return client?.query ? rows[0] : rows[0];
};

export async function replaceIssueRequestJobCards(
  { issue_uid, jobCards = [], userName },
  { client = null } = {}
) {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return [];
  if (!Array.isArray(jobCards) || !jobCards.length) return [];

  const work = async (txnClient) => {
    await softDeleteJobCardsByIssueUid(id, userName, { client: txnClient });
    const inserted = [];
    for (const jc of jobCards) {
      const row = jobCardPayloadToRow(id, jc, userName);
      if (!row.pjobcardno) continue;
      inserted.push(await insertIssueRequestJobCard(row, { client: txnClient }));
    }
    return inserted;
  };

  if (client) return work(client);
  return withTransaction(work);
}

/** Issue Request Register — FG + RM per job card (latest approved IR). */
export async function findIssueRequestRegisterMetaByPjobcardnos(pjobcardnos = []) {
  const raw = [...new Set((pjobcardnos || []).map((j) => String(j || "").trim()).filter(Boolean))];
  const keys = raw.map(jcMetaKey).filter(Boolean);
  if (!keys.length) return new Map();

  const rows = await dbQuery(
    `SELECT DISTINCT ON (UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')))
       UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')) AS jc_key,
       jc.pjobcardno,
       jc.macname,
       jc.item_code AS fg_item_code,
       jc.item_desc AS fg_item_desc,
       jc.rm_item_code,
       jc.rm_item_desc
     FROM ${IR_TABLE} r
     INNER JOIN ${TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     WHERE r.is_deleted = false
       AND UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')) = ANY($1::text[])
     ORDER BY
       UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i')),
       COALESCE(r.approved, false) DESC,
       r.issue_uid DESC,
       jc.id DESC`,
    [keys]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.jc_key || "").trim().toUpperCase();
    if (!key || map.has(key)) continue;
    map.set(key, registerMetaRow(r));
  }
  return map;
}

/** Store Out issue line — same FG/RM as that Issue Request Register row. */
export async function findIssueRequestRegisterMetaByCoilUids(coilNoUids = []) {
  const uids = [...new Set((coilNoUids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uids.length) return new Map();

  const rows = await dbQuery(
    `SELECT
       c.coil_no_uid,
       jc.pjobcardno,
       jc.macname,
       jc.item_code AS fg_item_code,
       jc.item_desc AS fg_item_desc,
       jc.rm_item_code,
       jc.rm_item_desc
     FROM ${COIL_TABLE} c
     LEFT JOIN LATERAL (
       SELECT o.out_uid, o.issue_uid, o.pjobcardno
       FROM ${OUT_ENTRY} o
       WHERE o.is_deleted = false
         AND NULLIF(TRIM(o.pjobcardno), '') IS NOT NULL
         AND (
           (c.out_uid IS NOT NULL AND o.out_uid = c.out_uid)
           OR (
             COALESCE(o.approved, false) = true
             AND EXISTS (
               SELECT 1 FROM ${OUT_SCANNED} s
               WHERE s.out_uid = o.out_uid
                 AND LOWER(TRIM(s.coil_no_uid)) = LOWER(TRIM(c.coil_no_uid))
             )
           )
         )
       ORDER BY
         CASE WHEN c.out_uid IS NOT NULL AND o.out_uid = c.out_uid THEN 0 ELSE 1 END,
         COALESCE(o.approved_at, o.created_at) DESC NULLS LAST,
         o.out_uid DESC
       LIMIT 1
     ) o ON TRUE
     INNER JOIN ${TABLE} jc
       ON jc.is_deleted = false
       AND o.issue_uid IS NOT NULL
       AND jc.issue_uid = o.issue_uid
       AND UPPER(REGEXP_REPLACE(TRIM(jc.pjobcardno), '^JC[[:space:]\\-]*', '', 'i'))
         = UPPER(REGEXP_REPLACE(TRIM(o.pjobcardno), '^JC[[:space:]\\-]*', '', 'i'))
     INNER JOIN ${IR_TABLE} r ON r.issue_uid = jc.issue_uid AND r.is_deleted = false
     WHERE c.coil_no_uid = ANY($1::text[])`,
    [uids]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.coil_no_uid || "").trim().toLowerCase();
    if (!key) continue;
    map.set(key, registerMetaRow(r));
  }
  return map;
}

/** FG product on a job card (latest row if duplicate pjobcardno). */
export async function findJobCardFgByPjobcardno(pjobcardno) {
  const jc = String(pjobcardno || "").trim();
  if (!jc) return null;
  const [row] = await dbQuery(
    `SELECT item_code, item_desc
     FROM ${TABLE}
     WHERE is_deleted = false
       AND UPPER(TRIM(pjobcardno)) = UPPER(TRIM($1))
     ORDER BY id DESC
     LIMIT 1`,
    [jc]
  );
  if (!row) return null;
  const fg_item_code = row.item_code ? String(row.item_code).trim() : "";
  if (!fg_item_code) return null;
  const fg_item_desc = row.item_desc ? String(row.item_desc).trim() : "";
  return { fg_item_code, fg_item_desc: fg_item_desc || null };
}
