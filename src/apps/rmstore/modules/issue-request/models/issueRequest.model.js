import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { ISSUE_REQUEST_MACHINE_JOB_CARD_LOCK } from "../../../lib/config/app.config.js";
import { findActiveJobCardsByIssueUid, jobCardRowToApi, softDeleteJobCardsByIssueUid } from "./issueRequestJobCard.model.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.ISSUE_REQUEST;
const JC_TABLE = T.ISSUE_REQUEST_JOB_CARD;
const COIL = T.COIL_TABLE;
const OUT_ENTRY = T.OUT_ENTRY;
const OUT_SCANNED = T.OUT_ENTRY_SCANNED_COIL;

const MASTER_COLUMNS = `
  r.issue_uid,
  r.shift,
  r.remarks,
  r.requested_qty,
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

/** Aggregate job-card rows for master list / get-by-id (replaces legacy master JSONB). */
const JC_AGG_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(jsonb_agg(
        jsonb_build_object(
          'pjobcardno', jc.pjobcardno,
          'issue_qty', CASE
            WHEN COALESCE(jc_out.out_coil_count, 0) > 0 THEN jc_out.out_qty
            ELSE jc.issue_qty
          END,
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
      COALESCE(SUM(
        CASE
          WHEN COALESCE(jc_out.out_coil_count, 0) > 0 THEN jc_out.out_qty
          ELSE jc.issue_qty
        END
      ), 0)::float8 AS issued_qty_display,
      COALESCE(SUM(
        CASE
          WHEN COALESCE(jc_out.out_coil_count, 0) > 0 THEN jc_out.out_coil_count
          ELSE jc.coil_count
        END
      ), 0)::int AS coil_count_display,
      (array_agg(jc.item_code ORDER BY jc.id))[1] AS item_code,
      (array_agg(jc.item_desc ORDER BY jc.id))[1] AS item_desc,
      (array_agg(jc.rm_item_code ORDER BY jc.id))[1] AS rm_item_code,
      (array_agg(jc.rm_item_desc ORDER BY jc.id))[1] AS rm_item_desc,
      (array_agg(jc.production_id ORDER BY jc.id))[1] AS production_id,
      (array_agg(jc.part_weight ORDER BY jc.id))[1] AS part_weight,
      (array_agg(jc.rm_weight ORDER BY jc.id))[1] AS rm_weight
    FROM ${JC_TABLE} jc
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int AS out_coil_count,
        COALESCE(SUM(oc.qty), 0)::float8 AS out_qty
      FROM ${OUT_ENTRY} o
      INNER JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
      INNER JOIN ${COIL} oc
        ON oc.is_deleted = false
       AND LOWER(TRIM(oc.coil_no_uid)) = LOWER(TRIM(s.coil_no_uid))
      WHERE o.is_deleted = false
        AND COALESCE(o.approved, false) = true
        AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
        AND o.issue_uid = jc.issue_uid
        AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(jc.pjobcardno))
    ) jc_out ON true
    WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
  ) jc_agg ON true
`;

const MASTER_STORE_OUT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE TRIM(c.coil->>'coil_no_uid') <> '')::int AS assigned_coil_count,
      (
        SELECT COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int
        FROM ${OUT_ENTRY} o
        INNER JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid
        WHERE o.is_deleted = false
          AND o.approved = true
          AND o.issue_uid = r.issue_uid
      ) AS out_coil_count
    FROM ${JC_TABLE} jc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS c(coil)
    WHERE jc.issue_uid = r.issue_uid AND jc.is_deleted = false
  ) st ON true
`;

const JC_STORE_OUT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE TRIM(c.coil->>'coil_no_uid') <> '')::int AS assigned_coil_count,
      (
        SELECT COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int
        FROM ${OUT_ENTRY} o
        INNER JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid
        WHERE o.is_deleted = false
          AND o.approved = true
          AND o.issue_uid = jc.issue_uid
          AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(COALESCE(jc.pjobcardno, '')))
      ) AS out_coil_count,
      (
        SELECT COALESCE(SUM(oc.qty), 0)::float8
        FROM ${OUT_ENTRY} o
        INNER JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
        INNER JOIN ${COIL} oc
          ON oc.is_deleted = false
         AND LOWER(TRIM(oc.coil_no_uid)) = LOWER(TRIM(s.coil_no_uid))
        WHERE o.is_deleted = false
          AND COALESCE(o.approved, false) = true
          AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
          AND o.issue_uid = jc.issue_uid
          AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(COALESCE(jc.pjobcardno, '')))
      ) AS out_qty
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
    ) AS c(coil)
  ) jst ON true
`;

function applyIssueRequestListFilters(filters = {}, conditions, values, { iRef, statsAlias = "st" } = {}) {
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
  if (filters.out_entry_complete === true || filters.out_entry_complete === "true") {
    conditions.push(
      `(COALESCE(${statsAlias}.assigned_coil_count, 0) > 0 AND COALESCE(${statsAlias}.out_coil_count, 0) >= COALESCE(${statsAlias}.assigned_coil_count, 0))`
    );
  } else if (filters.out_entry_complete === false || filters.out_entry_complete === "false") {
    conditions.push(
      `NOT (COALESCE(${statsAlias}.assigned_coil_count, 0) > 0 AND COALESCE(${statsAlias}.out_coil_count, 0) >= COALESCE(${statsAlias}.assigned_coil_count, 0))`
    );
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
  const issuedQtyDisplay = Number(row.issued_qty_display);
  const coilCountDisplay = Number(row.coil_count_display);
  return {
    ...row,
    job_cards: normalizeJsonArray(row.job_cards),
    requested_qty: Number.isFinite(issuedQtyDisplay) ? issuedQtyDisplay : Number(row.requested_qty) || 0,
    coil_count: Number.isFinite(coilCountDisplay) ? coilCountDisplay : Number(row.coil_count) || 0,
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
            jc_agg.production_id,
            jc_agg.part_weight,
            jc_agg.rm_weight,
            jc_agg.issued_qty_display,
            jc_agg.coil_count_display,
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

  applyIssueRequestListFilters(filters, conditions, values, { iRef, statsAlias: "jst" });
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
     ${JC_STORE_OUT_JOIN}`;

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
       jc.production_id,
       jc.planqty::float8 AS planqty,
       CASE
         WHEN COALESCE(jst.out_coil_count, 0) > 0 THEN jst.out_qty
         ELSE jc.issue_qty
       END::float8 AS issue_qty,
       jc.part_weight::float8 AS part_weight,
       jc.rm_weight::float8 AS rm_weight,
       CASE
         WHEN COALESCE(jst.out_coil_count, 0) > 0 THEN jst.out_coil_count
         ELSE jc.coil_count
       END AS coil_count,
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
       COALESCE(jst.assigned_coil_count, 0)::int AS assigned_coil_count,
       COALESCE(jst.out_coil_count, 0)::int AS store_out_coil_count,
       (COALESCE(jst.assigned_coil_count, 0) > 0
         AND COALESCE(jst.out_coil_count, 0) >= COALESCE(jst.assigned_coil_count, 0)) AS out_entry_complete
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
            jc_agg.production_id,
            jc_agg.part_weight,
            jc_agg.rm_weight,
            jc_agg.issued_qty_display,
            jc_agg.coil_count_display
     FROM ${TABLE} r
     ${JC_AGG_JOIN}
     WHERE r.issue_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return mapMasterRow(row) ?? null;
};

/** Flat coil list from normalized job-card rows. */
export const findIssueRequestCoils = async (issue_uid) => {
  const rows = await findActiveJobCardsByIssueUid(issue_uid);
  const id = Number(issue_uid);
  const flat = [];
  for (const jc of rows) {
    for (const c of normalizeJsonArray(jc.coils)) {
      const coil_no_uid = String(c?.coil_no_uid || "").trim();
      if (!coil_no_uid) continue;
      flat.push({
        coil_no_uid,
        qty: c?.qty ?? 0,
        mrn_uid: c?.mrn_uid ?? null,
        mrn_no: c?.mrn_no ?? null,
        pjobcardno: jc.pjobcardno ?? c?.pjobcardno ?? null,
        issue_uid: id,
      });
    }
  }
  return enrichCoilsFromMaster(flat);
};

export const findIssueRequestJobCards = async (issue_uid) => {
  const rows = await findActiveJobCardsByIssueUid(issue_uid);
  const mapped = rows.map(jobCardRowToApi).filter(Boolean);
  const allCoils = mapped.flatMap((jc) => jc.coils || []);
  const enriched = await enrichCoilsFromMaster(allCoils);
  const byUid = new Map(
    enriched.map((c) => [String(c.coil_no_uid || "").toLowerCase(), c])
  );
  return mapped.map((jc) => ({
    ...jc,
    coils: (jc.coils || []).map((c) => {
      const hit = byUid.get(String(c?.coil_no_uid || "").toLowerCase());
      return hit || c;
    }),
  }));
};

/** Fill mrn_uid / mrn_no / qty from coil master (legacy JSON often stored only coil_no_uid). */
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
    `SELECT c.coil_no_uid, c.qty, c.mrn_uid, m.mrn_no, m.heat_no, m.item_code, c.location_id, c.created_at, c.coil_uid
     FROM ${COIL} c
     LEFT JOIN ${T.MRN} m ON m.uid = c.mrn_uid
     WHERE c.is_deleted = false
       AND LOWER(TRIM(c.coil_no_uid)) = ANY($1::text[])`,
    [need]
  );
  const byUid = new Map(
    (rows || []).map((r) => [String(r.coil_no_uid || "").toLowerCase(), r])
  );

  return list.map((c) => {
    const full = byUid.get(String(c?.coil_no_uid || "").toLowerCase());
    if (!full) return c;
    return {
      ...c,
      qty: c.qty ?? full.qty,
      mrn_uid: c.mrn_uid || full.mrn_uid || null,
      mrn_no: c.mrn_no ?? full.mrn_no ?? null,
      heat_no: c.heat_no || full.heat_no || null,
      item_code: c.item_code || full.item_code || null,
      location_id: c.location_id ?? full.location_id ?? null,
      created_at: c.created_at || full.created_at || null,
      coil_uid: c.coil_uid ?? full.coil_uid ?? null,
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
            COALESCE(SUM(
              CASE
                WHEN COALESCE(out_act.out_coil_count, 0) > 0 THEN out_act.out_qty
                ELSE jc.issue_qty
              END
            ), 0)::float8 AS issued_qty,
            COALESCE(SUM(
              CASE
                WHEN COALESCE(out_act.out_coil_count, 0) > 0 THEN out_act.out_qty
                ELSE jc.issue_qty
              END
            ) FILTER (WHERE r.approved = true), 0)::float8 AS approved_qty,
            COUNT(*)::int AS request_count,
            MAX(r.issue_uid)::int AS last_issue_uid
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT LOWER(TRIM(s.coil_no_uid)))::int AS out_coil_count,
         COALESCE(SUM(oc.qty), 0)::float8 AS out_qty
       FROM ${OUT_ENTRY} o
       INNER JOIN ${OUT_SCANNED} s ON s.out_uid = o.out_uid AND TRIM(s.coil_no_uid) <> ''
       INNER JOIN ${COIL} oc
         ON oc.is_deleted = false
        AND LOWER(TRIM(oc.coil_no_uid)) = LOWER(TRIM(s.coil_no_uid))
       WHERE o.is_deleted = false
         AND COALESCE(o.approved, false) = true
         AND LOWER(COALESCE(o.entry_type, 'store_out')) = 'job_card'
         AND o.issue_uid = jc.issue_uid
         AND UPPER(TRIM(COALESCE(o.pjobcardno, ''))) = UPPER(TRIM(jc.pjobcardno))
     ) out_act ON true
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
export const findMachineJobCardLockConflicts = async (
  assignments = [],
  { excludeIssueUid = null } = {}
) => {
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

function runSql(client, sql, params) {
  if (client?.query) {
    return client.query(sql, params).then((r) => r.rows);
  }
  return dbQuery(sql, params);
}

/**
 * Coils reserved on issue requests (draft + approved).
 * Active from the moment IR is saved; released only after store-out authorize
 * (or when the IR is deleted). Edit excludes self via excludeIssueUid.
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

  return runSql(
    client,
    `SELECT LOWER(TRIM(c->>'coil_no_uid')) AS coil_no_uid,
            r.issue_uid,
            r.approved
     FROM ${TABLE} r
     INNER JOIN ${JC_TABLE} jc ON jc.issue_uid = r.issue_uid AND jc.is_deleted = false
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(jc.coils) = 'array' THEN jc.coils ELSE '[]'::jsonb END
     ) AS c
     WHERE r.is_deleted = false
       ${excludeClause}
       AND TRIM(c->>'coil_no_uid') <> ''
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
};

export const insertIssueRequest = async (data, { client = null } = {}) => {
  const rows = await runSql(
    client,
    `INSERT INTO ${TABLE}
     (shift, remarks, requested_qty, coil_count, approved, approved_by, approved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.shift === "B" ? "B" : "A",
      data.remarks ?? null,
      data.requested_qty ?? 0,
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
    "shift", "remarks", "requested_qty", "coil_count",
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
