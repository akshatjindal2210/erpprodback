import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { columnExists, dropColumnsIfExist, patchCol, patchTableSchema } from "../../../../../../config/db/ensureDbColumns.js";

/**
 * In-process Request — light header + slim coils JSON.
 *
 * type = consume|return|reassign|reject_coil|reject_lot
 * stage = workflow (was downstream)
 * reassign_jc = JSONB target snapshot when type=reassign
 *
 * Boot: ensure cols + indexes → drop legacy columns (idempotent).
 * Type/backfill helpers below are kept for reference; calls are commented out after migration.
 * RUN_IPR_BACKFILL = true only for one-time live migration if legacy cols still exist.
 */

const RUN_IPR_BACKFILL = false;

const LEGACY_DROP_COLS = [
  "request_type",
  "rejection_type",
  "lot_no",
  "mrn_no",
  "heat_no",
  "item_code",
  "item_desc",
  "seed_coil_uid",
  "scanned_coil_uids",
  "downstream",
  "previous_coils",
  "proposed_coils",
];

/** Idempotent — NULL/empty type + wrong coil/consume/reassign rows only. */
async function recoverIprTypeLight() {
  const hasType = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "type");
  if (!hasType) return;

  await dbQuery(`
    UPDATE ${T.IN_PROCESS_REQUEST}
    SET type = 'reject_coil'
    WHERE type = 'coil'
  `);
  await dbQuery(`
    UPDATE ${T.IN_PROCESS_REQUEST}
    SET type = 'reject_lot'
    WHERE type = 'lot'
  `);

  await dbQuery(`
    UPDATE ${T.IN_PROCESS_REQUEST} r
    SET type = 'reassign'
    WHERE (
      NULLIF(TRIM(COALESCE(r.reassign_jc->>'pjobcardno', '')), '') IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.coils) = 'array' THEN r.coils ELSE '[]'::jsonb END
        ) e
        WHERE COALESCE((e->>'reassign')::boolean, false) = true
      )
    )
    AND COALESCE(NULLIF(TRIM(r.type), ''), '') IS DISTINCT FROM 'reassign'
  `);

  await dbQuery(`
    UPDATE ${T.IN_PROCESS_REQUEST} r
    SET type = CASE
      WHEN r.stage IN ('pending_store_out', 'store_out_done') THEN 'reject_coil'
      WHEN r.stage = 'consumed' THEN 'consume'
      WHEN r.stage IN ('pending_store_in', 'store_in_done')
        AND (
          LOWER(COALESCE(r.reason, '')) LIKE '%status update%'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.coils) = 'array' THEN r.coils ELSE '[]'::jsonb END
            ) e
            WHERE COALESCE(NULLIF(e->>'consumed_qty', '')::numeric, 0) > 0
               OR (
                 NULLIF(e->>'original_qty', '') IS NOT NULL
                 AND NULLIF(e->>'remaining_qty', '') IS NOT NULL
                 AND COALESCE(NULLIF(e->>'remaining_qty', '')::numeric, 0)
                   < COALESCE(NULLIF(e->>'original_qty', '')::numeric, 0)
               )
          )
        )
        THEN 'consume'
      WHEN r.stage IN ('pending_store_in', 'store_in_done') THEN 'return'
      WHEN LOWER(COALESCE(r.reason, '')) LIKE '%status update%'
        OR LOWER(COALESCE(r.remarks, '')) LIKE '%consum%'
        THEN 'consume'
      ELSE COALESCE(NULLIF(TRIM(r.type), ''), 'reject_coil')
    END
    WHERE r.type IS NULL
       OR TRIM(COALESCE(r.type, '')) = ''
       OR (
         r.type = 'reject_coil'
         AND (
           r.stage IN ('consumed', 'pending_store_in', 'store_in_done')
           OR LOWER(COALESCE(r.reason, '')) LIKE '%status update%'
           OR LOWER(COALESCE(r.remarks, '')) LIKE '%consum%'
         )
       )
  `);
}

/**
 * DISABLED — coil.pjobcardno is SOURCE JC after reassign fix, not target.
 * Copying it into reassign_jc would corrupt target job card on boot.
 * New rows always send reassign_jc from the modal header.
 */
async function backfillReassignJcLight() {
  return;
}

/** One-time: VARCHAR reassign_jc → JSONB (existing JC number → { pjobcardno }). */
async function convertReassignJcToJsonb() {
  const table = T.IN_PROCESS_REQUEST;
  if (!(await columnExists(dbQuery, table, "reassign_jc"))) return;

  const [col] = await dbQuery(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'rmstore_in_process_request' AND column_name = 'reassign_jc'
     LIMIT 1`
  );
  const dt = String(col?.data_type || "").toLowerCase();
  if (dt !== "character varying" && dt !== "text") return;

  await dbQuery(`
    ALTER TABLE ${table}
    ALTER COLUMN reassign_jc TYPE jsonb USING (
      CASE
        WHEN NULLIF(TRIM(reassign_jc::text), '') IS NOT NULL
        THEN jsonb_build_object('pjobcardno', TRIM(reassign_jc::text))
        ELSE NULL
      END
    )
  `);
}

/** Heavy one-time migration — only when RUN_IPR_BACKFILL and legacy cols exist. */
async function backfillIprLegacyHeavy() {
  if (!RUN_IPR_BACKFILL) return;

  const hasType = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "type");
  const hasStage = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "stage");
  const hasRequestType = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "request_type");
  const hasDownstream = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "downstream");
  const hasPreviousCoils = await columnExists(dbQuery, T.IN_PROCESS_REQUEST, "previous_coils");

  if (!hasRequestType && !hasPreviousCoils && !hasDownstream) return;

  if (hasType && hasRequestType) {
    await dbQuery(`
      UPDATE ${T.IN_PROCESS_REQUEST} r
      SET type = CASE
        WHEN r.request_type = 'store_in' THEN 'return'
        WHEN r.request_type = 'rejection' AND r.rejection_type = 'lot' THEN 'reject_lot'
        WHEN r.request_type = 'rejection' THEN 'reject_coil'
        WHEN r.request_type = 'consume' AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(r.coils) = 'array' THEN r.coils ELSE '[]'::jsonb END
          ) e
          WHERE COALESCE((e->>'reassign')::boolean, false) = true
        ) THEN 'reassign'
        WHEN r.request_type = 'consume' THEN 'consume'
        WHEN r.request_type = 'transfer' THEN 'consume'
        ELSE COALESCE(NULLIF(TRIM(r.type), ''), 'reject_coil')
      END
      WHERE r.type IS NULL
         OR TRIM(COALESCE(r.type, '')) = ''
    `);
  }

  if (hasStage && hasDownstream) {
    await dbQuery(`
      UPDATE ${T.IN_PROCESS_REQUEST}
      SET stage = downstream
      WHERE stage IS NULL AND downstream IS NOT NULL
    `);
  }

  if (hasRequestType || hasPreviousCoils) {
    await dbQuery(`
      UPDATE ${T.IN_PROCESS_REQUEST} r
      SET coils = COALESCE((
        SELECT jsonb_agg(keep.line ORDER BY ord)
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.coils) = 'array' THEN r.coils ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(elem, ord)
        CROSS JOIN LATERAL (
          SELECT
            NULLIF(TRIM(elem->>'coil_no_uid'), '') AS uid,
            COALESCE(
              NULLIF(elem->>'original_qty', '')::numeric,
              NULLIF(elem->>'qty', '')::numeric,
              0
            ) AS original_qty,
            COALESCE(
              NULLIF(elem->>'remaining_qty', '')::numeric,
              CASE
                WHEN NULLIF(elem->>'consumed_qty', '') IS NOT NULL THEN
                  GREATEST(
                    0,
                    COALESCE(NULLIF(elem->>'original_qty', '')::numeric, NULLIF(elem->>'qty', '')::numeric, 0)
                      - NULLIF(elem->>'consumed_qty', '')::numeric
                  )
                ELSE COALESCE(NULLIF(elem->>'original_qty', '')::numeric, NULLIF(elem->>'qty', '')::numeric, 0)
              END
            ) AS remaining_qty
        ) q
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN q.uid IS NULL THEN NULL
            WHEN q.remaining_qty = q.original_qty THEN
              CASE
                WHEN q.original_qty = 0 THEN jsonb_build_object('coil_no_uid', q.uid)
                ELSE jsonb_build_object('coil_no_uid', q.uid, 'qty', q.original_qty)
              END
            ELSE jsonb_build_object(
              'coil_no_uid', q.uid,
              'original_qty', q.original_qty,
              'remaining_qty', q.remaining_qty
            )
          END AS base_line
        ) slim
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN slim.base_line IS NULL THEN NULL
            ELSE slim.base_line
              || CASE WHEN NULLIF(TRIM(elem->>'pjobcardno'), '') IS NOT NULL
                   THEN jsonb_build_object('pjobcardno', TRIM(elem->>'pjobcardno')) ELSE '{}'::jsonb END
              || CASE WHEN NULLIF(TRIM(elem->>'macname'), '') IS NOT NULL
                   THEN jsonb_build_object('macname', TRIM(elem->>'macname')) ELSE '{}'::jsonb END
              || CASE WHEN COALESCE((elem->>'reassign')::boolean, false) = true
                   THEN jsonb_build_object('reassign', true) ELSE '{}'::jsonb END
          END AS line
        ) keep
        WHERE keep.line IS NOT NULL
      ), '[]'::jsonb)
      WHERE jsonb_typeof(r.coils) = 'array'
        AND jsonb_array_length(r.coils) > 0
    `);
  }

  if (hasRequestType) {
    await dbQuery(`
      UPDATE ${T.IN_PROCESS_REQUEST} r
      SET attachments = COALESCE((
        SELECT jsonb_agg(to_jsonb(path) ORDER BY ord)
        FROM (
          SELECT
            ord,
            CASE
              WHEN jsonb_typeof(elem) = 'string' THEN NULLIF(TRIM(elem #>> '{}'), '')
              WHEN jsonb_typeof(elem) = 'object' THEN COALESCE(
                NULLIF(TRIM(elem->>'path'), ''),
                NULLIF(TRIM(elem->>'url'), ''),
                NULLIF(TRIM(elem->>'filename'), ''),
                NULLIF(TRIM(elem->>'name'), '')
              )
              ELSE NULL
            END AS path
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(r.attachments) = 'array' THEN r.attachments ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS t(elem, ord)
        ) s
        WHERE path IS NOT NULL
      ), '[]'::jsonb)
      WHERE jsonb_typeof(r.attachments) = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(r.attachments) e
          WHERE jsonb_typeof(e) = 'object'
        )
    `);
  }
}

export async function createRmStoreInProcessRequestTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.IN_PROCESS_REQUEST} (
      ipr_uid           SERIAL PRIMARY KEY,
      type              VARCHAR(20) NOT NULL DEFAULT 'reject_coil',
      reason            TEXT,
      remarks           TEXT,
      mrn_uid           VARCHAR(100),
      reassign_jc       JSONB,
      coils             JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments       JSONB DEFAULT '[]'::jsonb,
      stage             VARCHAR(30),
      approved          BOOLEAN DEFAULT false,
      approved_by       TEXT,
      approved_at       TIMESTAMP,
      is_deleted        BOOLEAN DEFAULT false,
      deleted_by        TEXT,
      deleted_at        TIMESTAMP,
      created_by        TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rmstore_in_process_request_created_at_idx
      ON ${T.IN_PROCESS_REQUEST}(created_at DESC);
  `);

  await patchTableSchema(dbQuery, T.IN_PROCESS_REQUEST, {
    columns: [
      patchCol("type", "VARCHAR(20)"),
      patchCol("reassign_jc", "JSONB"),
      patchCol("stage", "VARCHAR(30)"),
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS rmstore_in_process_request_canonical_type_idx
         ON ${T.IN_PROCESS_REQUEST}(type) WHERE is_deleted = false`,
      `CREATE INDEX IF NOT EXISTS rmstore_in_process_request_stage_idx
         ON ${T.IN_PROCESS_REQUEST}(stage) WHERE is_deleted = false AND approved = true`,
    ],
  });

  await convertReassignJcToJsonb();

  // Boot backfill disabled — re-enable only for one-time migration (see in-process-request.md).
  // await recoverIprTypeLight();
  // await backfillReassignJcLight();
  // await backfillIprLegacyHeavy();

  await dropColumnsIfExist(dbQuery, T.IN_PROCESS_REQUEST, LEGACY_DROP_COLS);
}
