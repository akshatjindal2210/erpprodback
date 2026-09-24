import dbQuery from "../../../../../config/db/db.js";
import { withTransaction } from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";

const TABLE = T.ISSUE_REQUEST_JOB_CARD;

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
    production_id: row.production_id ?? null,
    planqty: row.planqty ?? 0,
    issue_qty: row.issue_qty ?? 0,
    part_weight: row.part_weight ?? 0,
    rm_weight: row.rm_weight ?? 0,
    coils,
  };
}

function normalizeCoilPayload(raw) {
  return normalizeJsonArray(raw)
    .map((c) => {
      const coil_no_uid = String(c?.coil_no_uid || "").trim();
      if (!coil_no_uid) return null;
      const qty = Number(c?.qty);
      const mrn_uid = c?.mrn_uid != null && String(c.mrn_uid).trim() !== "" ? String(c.mrn_uid).trim() : null;
      const mrn_no = c?.mrn_no != null && String(c.mrn_no).trim() !== "" ? c.mrn_no : null;
      return {
        coil_no_uid,
        qty: Number.isFinite(qty) ? qty : 0,
        ...(mrn_uid ? { mrn_uid } : {}),
        ...(mrn_no != null ? { mrn_no } : {}),
      };
    })
    .filter(Boolean);
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
    production_id: raw?.production_id ?? null,
    planqty: Number(raw?.planqty ?? raw?.plan_qty ?? 0) || 0,
    issue_qty: Number(raw?.issue_qty ?? 0) || 0,
    part_weight: Number(raw?.part_weight ?? 0) || 0,
    rm_weight: Number(raw?.rm_weight ?? 0) || 0,
    coil_count: coils.length,
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
      rm_item_dcode, rm_item_code, rm_item_desc, production_id,
      planqty, issue_qty, part_weight, rm_weight, coil_count, coils, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
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
      data.production_id,
      data.planqty,
      data.issue_qty,
      data.part_weight,
      data.rm_weight,
      data.coil_count,
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
