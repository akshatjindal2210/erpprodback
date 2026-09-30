import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK } from "../../../lib/config/app.config.js";
import { findActiveJobCardsByIssueUid, jobCardRowToApi, softDeleteJobCardsByIssueUid, coilCountFromCoilsJson } from "./issueRequestJobCard.model.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.ISSUE_REQUEST;
const JC_TABLE = T.ISSUE_REQUEST_JOB_CARD;
const COIL = T.COIL_TABLE;
const OUT_ENTRY = T.OUT_ENTRY;
const OUT_SCANNED = T.OUT_ENTRY_SCANNED_COIL;

/** Match approved out-entry rows to a job-card line. */
const JC_OUT_MATCH = `
  o.is_deleted = false
  AND o.approved = true
  AND o.issue_uid = jc.issue_uid
  AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(COALESCE(jc.pjobcardno, '')))
`;

/** Per JC: scanned coil count + approved job_card total_qty. */
const JC_OUT_STATS_LATERAL = `
LEFT JOIN LATERAL (
  SELECT
    (
      SELECT COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int
      FROM ${OUT_ENTRY} o
      JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
      WHERE ${JC_OUT_MATCH}
    ) AS out_coil_count,
    COALESCE((
      SELECT SUM(o.total_qty)::float8
      FROM ${OUT_ENTRY} o
      WHERE ${JC_OUT_MATCH}
        AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
    ), 0)::float8 AS out_total_qty
) jc_out ON true`;

/** After store-out: show out qty/count; else JC issue_qty / coils JSON length. */
const JC_ISSUE_QTY_DISPLAY_SQL = `CASE WHEN COALESCE(jc_out.out_coil_count, 0) > 0 THEN jc_out.out_total_qty ELSE jc.issue_qty END`;
/** Coil count from JC coils JSON — MRN quotas (`coil_count`) or legacy UID rows. */
const JC_COIL_COUNT_SQL = `COALESCE((
  SELECT SUM(
    CASE
      WHEN NULLIF(TRIM(e.elem->>'mrn_uid'), '') IS NOT NULL
           AND COALESCE((e.elem->>'coil_count')::int, 0) > 0
        THEN (e.elem->>'coil_count')::int
      WHEN NULLIF(TRIM(e.elem->>'coil_no_uid'), '') IS NOT NULL THEN 1
      ELSE 0
    END
  )::int
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
  ) AS e(elem)
), 0)::int`;
const JC_COIL_COUNT_DISPLAY_SQL = `CASE WHEN COALESCE(jc_out.out_coil_count, 0) > 0 THEN jc_out.out_coil_count ELSE ${JC_COIL_COUNT_SQL} END`;

const MASTER_COLUMNS = `
  r.issue_uid,
  r.shift,
  r.remarks,
  r.coil_count,
  r.out_entry_locked,
  r.out_entry_locked_by,
  r.out_entry_locked_at,
  r.approved,
  r.approved_by,
  r.approved_at,
  r.is_deleted,
  r.deleted_by,
  r.deleted_at,
  r.created_by,
  r.created_at,
  r.updated_by,
  r.updated_at
`;

/** Aggregate job-card rows for master list / get-by-id. */
const JC_AGG_JOIN = `
LEFT JOIN LATERAL (
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'pjobcardno', jc.pjobcardno,
        'issue_qty', ${JC_ISSUE_QTY_DISPLAY_SQL},
        'planqty', jc.planqty,
        'macname', jc.macname,
        'pldt', jc.pldt,
        'item_code', jc.item_code,
        'item_desc', jc.item_desc,
        'rm_item_code', jc.rm_item_code,
        'rm_item_desc', jc.rm_item_desc,
        'part_weight', jc.part_weight,
        'rm_weight', jc.rm_weight
      ) ORDER BY jc.id
    ), '[]'::jsonb) AS job_cards,
    COALESCE(SUM((${JC_ISSUE_QTY_DISPLAY_SQL})), 0)::float8 AS job_cards_issue_qty_sum,
    COALESCE(SUM((${JC_COIL_COUNT_DISPLAY_SQL})), 0)::int AS job_cards_coil_count_sum,
    (array_agg(jc.item_code ORDER BY jc.id))[1] AS item_code,
    (array_agg(jc.item_desc ORDER BY jc.id))[1] AS item_desc,
    (array_agg(jc.rm_item_code ORDER BY jc.id))[1] AS rm_item_code,
    (array_agg(jc.rm_item_desc ORDER BY jc.id))[1] AS rm_item_desc,
    (array_agg(jc.part_weight ORDER BY jc.id))[1] AS part_weight,
    (array_agg(jc.rm_weight ORDER BY jc.id))[1] AS rm_weight
  FROM ${JC_TABLE} jc
  ${JC_OUT_STATS_LATERAL}
  WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
) jc_agg ON true
`;

/** Master-level store-out completeness (issue-wide). */
const MASTER_STORE_OUT_JOIN = `
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(${JC_COIL_COUNT_SQL}), 0)::int AS assigned_coil_count,
    (
      SELECT COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int
      FROM ${OUT_ENTRY} o
      JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
      WHERE o.is_deleted = false
        AND o.approved = true
        AND o.issue_uid = r.issue_uid
    ) AS out_coil_count
  FROM ${JC_TABLE} jc
  WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
) st ON true
`;

function applyIssueRequestListFilters(filters = {}, conditions, values, { iRef, statsAlias = "st", assignedSql = null } = {}) {
  let i = iRef.value;

  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`r.approved = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`r.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`r.created_at <= $${i++}`);
  }
  if (filters.out_entry_locked !== undefined && filters.out_entry_locked !== null && filters.out_entry_locked !== "") {
    const locked = filters.out_entry_locked === true || filters.out_entry_locked === "true";
    conditions.push(`COALESCE(r.out_entry_locked, false) = ${locked ? "true" : "false"}`);
  }
  const assigned = assignedSql || `COALESCE(${statsAlias}.assigned_coil_count, 0)`;
  const outCount = `COALESCE(${statsAlias}.out_coil_count, 0)`;
  if (filters.out_entry_complete === true || filters.out_entry_complete === "true") {
    conditions.push(`(${assigned} > 0 AND ${outCount} >= ${assigned})`);
  } else if (filters.out_entry_complete === false || filters.out_entry_complete === "false") {
    conditions.push(`NOT (${assigned} > 0 AND ${outCount} >= ${assigned})`);
  }

  iRef.value = i;
  return iRef;
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

function mapMasterRow(row) {
  if (!row) return null;
  const qtyDisplay = Number(row.job_cards_issue_qty_sum);
  const coilDisplay = Number(row.job_cards_coil_count_sum);
  return {
    ...row,
    job_cards: normalizeJsonArray(row.job_cards),
    requested_qty: Number.isFinite(qtyDisplay) ? qtyDisplay : 0,
    coil_count: Number.isFinite(coilDisplay) ? coilDisplay : Number(row.coil_count) || 0,
  };
}

export const findIssueRequests = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  const iRef = { value: 1 };
  const conditions = ["r.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`r.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  applyIssueRequestListFilters(filters, conditions, values, { iRef, statsAlias: "st" });
  let i = iRef.value;

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc_agg.item_code,'') ILIKE $${idx} OR
      COALESCE(jc_agg.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc_agg.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc_agg.rm_item_desc,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.shift,'') ILIKE $${idx} OR
      EXISTS (
        SELECT 1 FROM ${JC_TABLE} jc_s
        WHERE jc_s.issue_uid = r.issue_uid
          AND jc_s.is_deleted = false
          AND (
            COALESCE(jc_s.pjobcardno,'') ILIKE $${idx} OR
            COALESCE(jc_s.item_code,'') ILIKE $${idx} OR
            COALESCE(jc_s.item_desc,'') ILIKE $${idx}
          )
      ) OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const fromClause = `FROM ${TABLE} r ${JC_AGG_JOIN} ${MASTER_STORE_OUT_JOIN}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT ${MASTER_COLUMNS},
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name,
            r.out_entry_locked_by AS out_entry_locked_by_name,
            jc_agg.job_cards,
            jc_agg.item_code,
            jc_agg.item_desc,
            jc_agg.rm_item_code,
            jc_agg.rm_item_desc,
            jc_agg.part_weight,
            jc_agg.rm_weight,
            jc_agg.job_cards_issue_qty_sum,
            jc_agg.job_cards_coil_count_sum,
            COALESCE(st.assigned_coil_count, 0)::int AS assigned_coil_count,
            COALESCE(st.out_coil_count, 0)::int AS store_out_coil_count,
            (COALESCE(st.assigned_coil_count, 0) > 0
              AND COALESCE(st.out_coil_count, 0) >= COALESCE(st.assigned_coil_count, 0)) AS out_entry_complete
     ${fromClause}
     ${where}
     ORDER BY r.issue_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows.map(mapMasterRow),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
};

/** Job-card-wise rows — one row per job card on each issue request (like FN item-wise). */
export const findIssueRequestJobCardRows = async (options = {}) => {
  const { filters = {}, search, page = 1, limit = 100, permission = {} } = options;
  const values = [];
  const iRef = { value: 1 };
  const conditions = ["r.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`r.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  applyIssueRequestListFilters(filters, conditions, values, {
    iRef,
    statsAlias: "jc_out",
    assignedSql: JC_COIL_COUNT_SQL,
  });
  let i = iRef.value;

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(jc.item_code,'') ILIKE $${idx} OR
      COALESCE(jc.item_desc,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_code,'') ILIKE $${idx} OR
      COALESCE(jc.rm_item_desc,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(jc.pjobcardno,'') ILIKE $${idx} OR
      COALESCE(jc.macname,'') ILIKE $${idx} OR
      r.issue_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const fromClause = `
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     ${JC_OUT_STATS_LATERAL}`;

  const countRes = await dbQuery(`SELECT COUNT(*) AS count ${fromClause} ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT
       r.issue_uid,
       jc.id AS job_card_id,
       jc.pjobcardno,
       jc.pldt,
       jc.macname,
       jc.item_code,
       jc.item_desc,
       jc.rm_item_code,
       jc.rm_item_desc,
       jc.planqty::float8 AS planqty,
       (${JC_ISSUE_QTY_DISPLAY_SQL})::float8 AS issue_qty,
       jc.part_weight::float8 AS part_weight,
       jc.rm_weight::float8 AS rm_weight,
       (${JC_COIL_COUNT_DISPLAY_SQL}) AS coil_count,
       r.shift,
       r.approved,
       r.remarks,
       r.out_entry_locked,
       r.out_entry_locked_at,
       r.created_at,
       r.updated_at,
       r.approved_at,
       r.created_by AS created_by_name,
       r.updated_by AS updated_by_name,
       r.approved_by AS approved_by_name,
       r.out_entry_locked_by AS out_entry_locked_by_name,
       ${JC_COIL_COUNT_SQL} AS assigned_coil_count,
       COALESCE(jc_out.out_coil_count, 0)::int AS store_out_coil_count,
       (${JC_COIL_COUNT_SQL} > 0
         AND COALESCE(jc_out.out_coil_count, 0) >= ${JC_COIL_COUNT_SQL}) AS out_entry_complete
     ${fromClause}
     ${where}
     ORDER BY r.issue_uid DESC, jc.pjobcardno ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 1 };
};

export const findIssueRequest = async (issue_uid) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ${MASTER_COLUMNS},
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name,
            jc_agg.job_cards,
            jc_agg.item_code,
            jc_agg.item_desc,
            jc_agg.rm_item_code,
            jc_agg.rm_item_desc,
            jc_agg.part_weight,
            jc_agg.rm_weight,
            jc_agg.job_cards_issue_qty_sum,
            jc_agg.job_cards_coil_count_sum
     FROM ${TABLE} r
     ${JC_AGG_JOIN}
     WHERE r.issue_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return mapMasterRow(row) ?? null;
};

/** Expand MRN-quota JSON (or legacy UID rows) to coil rows for API/edit UI. */
async function expandJcCoilsForApi(rawCoils = [], { pjobcardno = null, issue_uid = null } = {}) {
  const list = normalizeJsonArray(rawCoils);
  const legacy = [];
  const quotas = [];
  for (const c of list) {
    const uid = String(c?.coil_no_uid || "").trim();
    if (uid) {
      legacy.push({
        coil_no_uid: uid,
        qty: c?.qty ?? 0,
        mrn_uid: c?.mrn_uid ?? null,
        pjobcardno,
        issue_uid,
      });
      continue;
    }
    const mrn_uid = String(c?.mrn_uid || "").trim();
    const count = Math.max(0, Math.floor(Number(c?.coil_count) || 0));
    if (mrn_uid && count > 0) quotas.push({ mrn_uid, coil_count: count, qty: Number(c?.qty) || 0 });
  }
  if (!quotas.length) return enrichCoilsFromMaster(legacy);

  const mrnIds = [...new Set(quotas.map((q) => q.mrn_uid))];
  const live = await dbQuery(
    `SELECT c.coil_no_uid, c.mrn_uid, c.qty, c.location_id, c.created_at, c.coil_uid,
            m.mrn_no, m.heat_no, m.item_code, m.acc_name
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE COALESCE(c.status, 'active') = 'active'
       AND c.mrn_uid = ANY($1::text[])
     ORDER BY
       CASE WHEN c.location_id IS NULL THEN 1 ELSE 0 END ASC,
       c.created_at ASC NULLS LAST,
       c.coil_uid ASC NULLS LAST,
       c.coil_no_uid ASC`,
    [mrnIds]
  );
  const byMrn = new Map();
  for (const row of live || []) {
    const m = String(row.mrn_uid || "").trim();
    if (!byMrn.has(m)) byMrn.set(m, []);
    byMrn.get(m).push(row);
  }
  const used = new Set(legacy.map((c) => String(c.coil_no_uid).toLowerCase()));
  const expanded = [...legacy];
  for (const q of quotas) {
    let need = q.coil_count;
    for (const row of byMrn.get(q.mrn_uid) || []) {
      if (need <= 0) break;
      const key = String(row.coil_no_uid || "").toLowerCase();
      if (!key || used.has(key)) continue;
      used.add(key);
      expanded.push({
        coil_no_uid: row.coil_no_uid,
        qty: row.qty ?? 0,
        mrn_uid: row.mrn_uid,
        mrn_no: row.mrn_no,
        heat_no: row.heat_no,
        item_code: row.item_code,
        acc_name: row.acc_name,
        location_id: row.location_id,
        created_at: row.created_at,
        coil_uid: row.coil_uid,
        pjobcardno,
        issue_uid,
      });
      need -= 1;
    }
  }
  return enrichCoilsFromMaster(expanded);
}

export const findIssueRequestCoils = async (issue_uid) => {
  const rows = await findActiveJobCardsByIssueUid(issue_uid);
  const id = Number(issue_uid);
  const outByJc = await findApprovedJobCardStoreOutCoilsByIssue(id);
  const all = [];
  for (const jc of rows) {
    const jcKey = String(jc.pjobcardno || "").trim().toUpperCase();
    const outCoils = outByJc.get(jcKey);
    if (outCoils?.length) {
      all.push(...outCoils);
      continue;
    }
    const expanded = await expandJcCoilsForApi(jc.coils, {
      pjobcardno: jc.pjobcardno ?? null,
      issue_uid: id,
    });
    all.push(...expanded);
  }
  return all;
};

/**
 * After job-card store-out is approved, live coils are no longer `active`.
 * Print / view must use the out-entry scanned snapshot (actual sent qty + MRN).
 * @returns {Promise<Map<string, object[]>>} UPPER(pjobcardno) → coil rows
 */
export async function findApprovedJobCardStoreOutCoilsByIssue(issue_uid) {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return new Map();

  const rows = await dbQuery(
    `SELECT
       UPPER(TRIM(COALESCE(o.pjobcardno, ''))) AS jc_key,
       TRIM(o.pjobcardno) AS pjobcardno,
       TRIM(s.coil_no_uid) AS coil_no_uid,
       COALESCE(s.qty, c.qty, 0)::float8 AS qty,
       c.mrn_uid,
       m.mrn_no,
       m.heat_no,
       m.item_code,
       m.acc_name,
       c.location_id,
       c.created_at,
       c.coil_uid
     FROM ${OUT_ENTRY} o
     JOIN ${OUT_SCANNED} s
       ON s.out_uid = o.out_uid AND TRIM(COALESCE(s.coil_no_uid, '')) <> ''
     LEFT JOIN ${COIL} c
       ON c.coil_no_uid = s.coil_no_uid
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE o.is_deleted = false
       AND o.approved = true
       AND o.issue_uid = $1
       AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
     ORDER BY o.out_uid ASC, s.created_at ASC NULLS LAST, s.coil_no_uid ASC`,
    [id]
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = String(r.jc_key || "").trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      coil_no_uid: r.coil_no_uid,
      qty: r.qty ?? 0,
      mrn_uid: r.mrn_uid ?? null,
      mrn_no: r.mrn_no ?? null,
      heat_no: r.heat_no ?? null,
      item_code: r.item_code ?? null,
      acc_name: r.acc_name ?? null,
      location_id: r.location_id ?? null,
      created_at: r.created_at ?? null,
      coil_uid: r.coil_uid ?? null,
      pjobcardno: r.pjobcardno ?? null,
      issue_uid: id,
    });
  }
  return map;
}

export const findIssueRequestJobCards = async (issue_uid) => {
  const id = Number(issue_uid);
  const [header, rows, outByJc] = await Promise.all([
    findIssueRequest(id),
    findActiveJobCardsByIssueUid(id),
    findApprovedJobCardStoreOutCoilsByIssue(id),
  ]);
  const qtyByJc = new Map(
    (header?.job_cards || []).map((j) => [
      String(j?.pjobcardno || "").trim().toUpperCase(),
      Number(j?.issue_qty),
    ])
  );
  const mapped = [];
  for (const row of rows) {
    const api = jobCardRowToApi(row);
    if (!api) continue;
    api.reserved_issue_qty = Number(row.issue_qty) || 0;
    const jcKey = String(api.pjobcardno || "").trim().toUpperCase();
    const q = qtyByJc.get(jcKey);
    if (Number.isFinite(q)) api.issue_qty = q;
    const outCoils = outByJc.get(jcKey);
    if (outCoils?.length) {
      api.coils = outCoils;
      api.coil_count = outCoils.length;
      api.store_out_complete = true;
    } else {
      api.coils = await expandJcCoilsForApi(row.coils, {
        pjobcardno: api.pjobcardno,
        issue_uid: id,
      });
      api.coil_count = api.coils.length || coilCountFromCoilsJson(row.coils);
      api.store_out_complete = false;
    }
    mapped.push(api);
  }
  return mapped;
};

async function enrichCoilsFromMaster(coils = []) {
  const list = Array.isArray(coils) ? coils : [];
  const need = [
    ...new Set(
      list
        .map((c) => String(c?.coil_no_uid || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (!need.length) return list;

  const rows = await dbQuery(
    `SELECT c.coil_no_uid, c.mrn_uid, m.mrn_no, m.heat_no, m.item_code, m.acc_name,
            c.location_id, c.created_at, c.coil_uid
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE LOWER(TRIM(c.coil_no_uid)) = ANY($1::text[])`,
    [need]
  );
  const byUid = new Map(
    (rows || []).map((r) => [String(r.coil_no_uid || "").toLowerCase(), r])
  );

  return list.map((c) => {
    const full = byUid.get(String(c?.coil_no_uid || "").toLowerCase());
    if (!full) return c;
    return {
      coil_no_uid: c.coil_no_uid,
      qty: c.qty ?? 0,
      mrn_uid: full.mrn_uid ?? c.mrn_uid ?? null,
      mrn_no: full.mrn_no ?? null,
      heat_no: full.heat_no ?? null,
      item_code: full.item_code ?? null,
      acc_name: full.acc_name ?? null,
      location_id: full.location_id ?? null,
      created_at: full.created_at ?? null,
      coil_uid: full.coil_uid ?? null,
      ...(c.pjobcardno != null ? { pjobcardno: c.pjobcardno } : {}),
      ...(c.issue_uid != null ? { issue_uid: c.issue_uid } : {}),
    };
  });
}

/**
 * Sum already-requested qty per job card across all saved issue requests.
 * @param {string[]} jobCardNos
 * @param {{ excludeIssueUid?: number|null }} options exclude the request being edited
 */
export const findIssuedQtyByJobCards = async (jobCardNos = [], { excludeIssueUid = null } = {}) => {
  const keys = [
    ...new Set(
      (jobCardNos || []).map((v) => String(v ?? "").trim().toUpperCase()).filter(Boolean)
    ),
  ];
  if (!keys.length) return [];

  const values = [keys];
  let i = 2;
  let excludeClause = "";
  const exclude = Number(excludeIssueUid);
  if (Number.isFinite(exclude) && exclude > 0) {
    values.push(exclude);
    excludeClause = `AND r.issue_uid <> $${i++}`;
  }

  return dbQuery(
    `SELECT UPPER(TRIM(jc.pjobcardno)) AS pjobcardno,
            COALESCE(SUM((${JC_ISSUE_QTY_DISPLAY_SQL})), 0)::float8 AS issued_qty,
            COALESCE(SUM((${JC_ISSUE_QTY_DISPLAY_SQL})) FILTER (WHERE r.approved = true), 0)::float8 AS approved_qty,
            COUNT(*)::int AS request_count,
            MAX(r.issue_uid)::int AS last_issue_uid
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     ${JC_OUT_STATS_LATERAL}
     WHERE r.is_deleted = false
       ${excludeClause}
       AND UPPER(TRIM(jc.pjobcardno)) = ANY($1::text[])
     GROUP BY 1`,
    values
  );
};

/**
 * Open issue requests where a machine is assigned to a different job card than requested.
 * Skipped when ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK is false (app.config.js).
 */
export const findMachineJobCardLockConflicts = async (assignments = [], { excludeIssueUid = null } = {}) => {
  if (!ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK) return [];

  const pairs = [
    ...new Map(
      (assignments || [])
        .map((a) => ({
          macname: String(a?.macname ?? "").trim().toUpperCase(),
          pjobcardno: String(a?.pjobcardno ?? "").trim().toUpperCase(),
        }))
        .filter((p) => p.macname && p.pjobcardno)
        .map((p) => [`${p.macname}::${p.pjobcardno}`, p])
    ).values(),
  ];
  if (!pairs.length) return [];

  const values = [pairs.map((p) => p.macname), pairs.map((p) => p.pjobcardno)];
  let excludeClause = "";
  const exclude = Number(excludeIssueUid);
  if (Number.isFinite(exclude) && exclude > 0) {
    values.push(exclude);
    excludeClause = `AND r.issue_uid <> $3`;
  }

  return dbQuery(
    `WITH requested AS (
       SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(macname, pjobcardno)
     )
     SELECT DISTINCT ON (UPPER(TRIM(jc.macname)))
            UPPER(TRIM(jc.macname)) AS macname,
            r.issue_uid,
            TRIM(jc.pjobcardno) AS pjobcardno
     FROM requested req
     INNER JOIN ${TABLE} r ON r.is_deleted = false ${excludeClause}
     INNER JOIN ${JC_TABLE} jc
       ON jc.issue_uid = r.issue_uid
      AND jc.is_deleted = false
      AND TRIM(COALESCE(jc.macname, '')) <> ''
      AND UPPER(TRIM(jc.macname)) = req.macname
      AND UPPER(TRIM(jc.pjobcardno)) <> req.pjobcardno
     WHERE NOT EXISTS (
       SELECT 1
       FROM ${OUT_ENTRY} o
       WHERE o.is_deleted = false
         AND o.issue_uid = r.issue_uid
         AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(jc.pjobcardno))
         AND COALESCE(o.approved, false) = true
         AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
     )
     ORDER BY UPPER(TRIM(jc.macname)), r.issue_uid DESC`,
    values
  );
};

/** Shop floor coils (status out): block another job card on the same machine. */
export const findMachineShopFloorJobCardConflicts = async (assignments = []) => {
  if (!ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK) return [];

  const pairs = [
    ...new Map(
      (assignments || [])
        .map((a) => ({
          macname: String(a?.macname ?? "").trim().toUpperCase(),
          pjobcardno: String(a?.pjobcardno ?? "").trim().toUpperCase(),
        }))
        .filter((p) => p.macname && p.pjobcardno)
        .map((p) => [`${p.macname}::${p.pjobcardno}`, p])
    ).values(),
  ];
  if (!pairs.length) return [];

  const macnames = pairs.map((p) => p.macname);
  const pjobcards = pairs.map((p) => p.pjobcardno);

  return dbQuery(
    `WITH req AS (
       SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(macname, pjobcardno)
     ),
     blocked AS (
       SELECT
         UPPER(TRIM(jc.macname)) AS macname,
         TRIM(jc.pjobcardno) AS pjobcardno,
         COUNT(*)::int AS coil_count,
         MAX(NULLIF(TRIM(jc.rm_item_code), '')) AS wires
       FROM ${COIL} c
       INNER JOIN ${OUT_ENTRY} o
         ON o.out_uid = c.out_uid
        AND o.is_deleted = false
       INNER JOIN ${JC_TABLE} jc
         ON jc.issue_uid = o.issue_uid
        AND jc.is_deleted = false
        AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM(COALESCE(o.pjobcardno, '')))
       INNER JOIN req
         ON req.macname = UPPER(TRIM(jc.macname))
        AND req.pjobcardno <> UPPER(TRIM(jc.pjobcardno))
       WHERE c.out_uid IS NOT NULL
         AND LOWER(COALESCE(c.status, 'active')) = 'out'
         AND TRIM(COALESCE(jc.macname, '')) <> ''
         AND TRIM(COALESCE(jc.pjobcardno, '')) <> ''
         AND UPPER(TRIM(jc.macname)) = ANY($1::text[])
       GROUP BY UPPER(TRIM(jc.macname)), TRIM(jc.pjobcardno)
     )
     SELECT * FROM blocked
     ORDER BY coil_count DESC`,
    [macnames, pjobcards]
  );
};

/** Shop floor coils (status out): block reassign when another wire is running on the same machine. */
export const findMachineShopFloorDifferentWireConflicts = async ({
  macname,
  wireItemCode,
  excludeCoilUid = null,
} = {}) => {
  if (!ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK) return [];

  const mac = String(macname ?? "").trim();
  const wire = String(wireItemCode ?? "").trim().toUpperCase();
  if (!mac || !wire) return [];

  const excludeUid = String(excludeCoilUid ?? "").trim().toLowerCase();

  return dbQuery(
    `SELECT
       UPPER(TRIM(jc.macname)) AS macname,
       TRIM(jc.pjobcardno) AS pjobcardno,
       COUNT(*)::int AS coil_count,
       MAX(NULLIF(TRIM(COALESCE(m.item_code, jc.rm_item_code, '')), '')) AS wires
     FROM ${COIL} c
     INNER JOIN ${OUT_ENTRY} o
       ON o.out_uid = c.out_uid
      AND o.is_deleted = false
     INNER JOIN ${JC_TABLE} jc
       ON jc.issue_uid = o.issue_uid
      AND jc.is_deleted = false
      AND UPPER(TRIM(jc.pjobcardno)) = UPPER(TRIM(COALESCE(o.pjobcardno, '')))
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE c.out_uid IS NOT NULL
       AND LOWER(COALESCE(c.status, 'active')) = 'out'
       AND TRIM(COALESCE(jc.macname, '')) <> ''
       AND UPPER(TRIM(jc.macname)) = UPPER(TRIM($1))
       AND UPPER(TRIM(COALESCE(m.item_code, jc.rm_item_code, ''))) <> $2
       AND ($3 = '' OR LOWER(TRIM(c.coil_no_uid)) <> $3)
     GROUP BY UPPER(TRIM(jc.macname)), TRIM(jc.pjobcardno)
     ORDER BY coil_count DESC
     LIMIT 5`,
    [mac, wire, excludeUid]
  );
};

export function shopFloorJobCardConflictMessage(hit) {
  const machine = String(hit?.macname || "").trim() || "This machine";
  const jc = String(hit?.pjobcardno || "").trim() || "—";
  const n = Number(hit?.coil_count) || 0;
  const wires = String(hit?.wires || "").trim();
  const wirePart = wires ? ` · wire ${wires}` : "";
  return (
    `${machine} already has ${n} coil(s) on shop floor for job card ${jc}${wirePart}. ` +
    `Complete Consume or Store In for those coils before issuing another job card on this machine.`
  );
}

export function shopFloorDifferentWireConflictMessage(hit) {
  const machine = String(hit?.macname || "").trim() || "This machine";
  const jc = String(hit?.pjobcardno || "").trim() || "—";
  const n = Number(hit?.coil_count) || 0;
  const wires = String(hit?.wires || "").trim();
  const wirePart = wires ? ` · wire ${wires}` : "";
  return (
    `${machine} already has ${n} coil(s) on shop floor for job card ${jc}${wirePart}. ` +
    `Reassign is allowed only when no other wire is running on this machine. Complete Consume or Store In for those coils first.`
  );
}

function runSql(client, sql, params) {
  if (client?.query) {
    return client.query(sql, params).then((r) => r.rows);
  }
  return dbQuery(sql, params);
}

/**
 * Soft-reserved coil UIDs on open issue requests (no approved store-out for that JC).
 * Legacy JSON: exact coil_no_uid.
 * New JSON: MRN quotas → FIFO first N active coils on that MRN (capacity only; Store Out still any-in-MRN).
 */
export const findReservedCoilsFromRequests = async ({
  excludeIssueUid = null,
  client = null,
} = {}) => {
  const values = [];
  let excludeClause = "";
  const exclude = Number(excludeIssueUid);
  if (Number.isFinite(exclude) && exclude > 0) {
    values.push(exclude);
    excludeClause = `AND r.issue_uid <> $1`;
  }

  const jcRows = await runSql(
    client,
    `SELECT r.issue_uid, r.approved, jc.coils
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     WHERE r.is_deleted = false
       ${excludeClause}
       AND NOT EXISTS (
         SELECT 1
         FROM ${OUT_ENTRY} o
         WHERE o.is_deleted = false
           AND o.issue_uid = r.issue_uid
           AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(jc.pjobcardno))
           AND COALESCE(o.approved, false) = true
       )`,
    values
  );

  const reserved = [];
  const quotas = [];
  for (const row of jcRows || []) {
    for (const c of normalizeJsonArray(row.coils)) {
      const uid = String(c?.coil_no_uid || "").trim().toLowerCase();
      if (uid) {
        reserved.push({ coil_no_uid: uid, issue_uid: row.issue_uid, approved: row.approved });
        continue;
      }
      const mrn_uid = String(c?.mrn_uid || "").trim();
      const count = Math.max(0, Math.floor(Number(c?.coil_count) || 0));
      if (mrn_uid && count > 0) {
        quotas.push({
          mrn_uid,
          coil_count: count,
          issue_uid: row.issue_uid,
          approved: row.approved,
        });
      }
    }
  }
  if (!quotas.length) return reserved;

  const mrnIds = [...new Set(quotas.map((q) => q.mrn_uid))];
  const live = await runSql(
    client,
    `SELECT LOWER(TRIM(c.coil_no_uid)) AS coil_no_uid, TRIM(c.mrn_uid) AS mrn_uid
     FROM ${COIL} c
     WHERE COALESCE(c.status, 'active') = 'active'
       AND c.mrn_uid = ANY($1::text[])
       AND TRIM(c.coil_no_uid) <> ''
     ORDER BY
       CASE WHEN c.location_id IS NULL THEN 1 ELSE 0 END ASC,
       c.created_at ASC NULLS LAST,
       c.coil_uid ASC NULLS LAST,
       c.coil_no_uid ASC`,
    [mrnIds]
  );
  const byMrn = new Map();
  for (const row of live || []) {
    if (!byMrn.has(row.mrn_uid)) byMrn.set(row.mrn_uid, []);
    byMrn.get(row.mrn_uid).push(row.coil_no_uid);
  }
  const used = new Set(reserved.map((r) => r.coil_no_uid));
  for (const q of quotas) {
    let need = q.coil_count;
    for (const uid of byMrn.get(q.mrn_uid) || []) {
      if (need <= 0) break;
      if (used.has(uid)) continue;
      used.add(uid);
      reserved.push({ coil_no_uid: uid, issue_uid: q.issue_uid, approved: q.approved });
      need -= 1;
    }
  }
  return reserved;
};

export const insertIssueRequest = async (data, { client = null } = {}) => {
  const rows = await runSql(
    client,
    `INSERT INTO ${TABLE}
     (shift, remarks, coil_count, approved, approved_by, approved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      data.shift === "B" ? "B" : "A",
      data.remarks ?? null,
      data.coil_count ?? 0,
      data.approved === true,
      data.approved_by ?? null,
      data.approved_at ?? null,
      data.created_by ?? null,
    ]
  );
  return rows[0];
};

export const updateIssueRequest = async (issue_uid, fields = {}, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (Number.isFinite(id) && id > 0) {
    const lockRows = await runSql(
      client,
      `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
      [id]
    );
    if (lockRows[0]?.out_entry_locked) {
      const err = new Error("This issue request is locked for store out.");
      err.statusCode = 409;
      throw err;
    }
  }

  const allowed = [
    "shift", "remarks", "coil_count",
    "approved", "approved_by", "approved_at", "updated_by", "updated_at",
  ];
  const safe = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) safe[k] = fields[k];
  }
  if (safe.shift !== undefined) {
    safe.shift = safe.shift === "B" ? "B" : "A";
  }
  const keys = Object.keys(safe);
  if (!keys.length) return findIssueRequest(issue_uid);
  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(safe);
  values.push(Number(issue_uid));
  const rows = await runSql(
    client,
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE issue_uid = $${nextIndex} AND is_deleted = false
     RETURNING *`,
    values
  );
  return rows[0] ?? null;
};

export const softDeleteIssueRequest = async (issue_uid, deleted_by = null) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id)) return;
  const [lockRow] = await dbQuery(
    `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
    [id]
  );
  if (lockRow?.out_entry_locked) {
    const err = new Error("This issue request is locked for store out.");
    err.statusCode = 409;
    throw err;
  }
  await softDeleteJobCardsByIssueUid(id, deleted_by);
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE issue_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};

export const lockIssueRequestForStoreOut = async ({ issue_uid, userName }, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  const rows = await run(
    `UPDATE ${TABLE}
     SET out_entry_locked = true,
         out_entry_locked_by = COALESCE(out_entry_locked_by, $2),
         out_entry_locked_at = COALESCE(out_entry_locked_at, NOW())
     WHERE issue_uid = $1 AND is_deleted = false
     RETURNING issue_uid, out_entry_locked, out_entry_locked_at`,
    [id, userName ?? null]
  );
  return client?.query ? rows[0] : rows[0];
};

export const unlockIssueRequestForStoreOut = async ({ issue_uid }, { client = null } = {}) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const run = client?.query
    ? async (sql, params) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    : dbQuery;
  const rows = await run(
    `UPDATE ${TABLE}
     SET out_entry_locked = false,
         out_entry_locked_by = NULL,
         out_entry_locked_at = NULL
     WHERE issue_uid = $1 AND is_deleted = false
     RETURNING issue_uid, out_entry_locked, out_entry_locked_at`,
    [id]
  );
  return client?.query ? rows[0] : rows[0];
};

export const isIssueRequestLockedForStoreOut = async (issue_uid) => {
  const id = Number(issue_uid);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [row] = await dbQuery(
    `SELECT out_entry_locked FROM ${TABLE} WHERE issue_uid = $1 AND is_deleted = false LIMIT 1`,
    [id]
  );
  return Boolean(row?.out_entry_locked);
};
