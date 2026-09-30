import dbQuery from "../../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../../config/db/dbTables.js";
import { dropColumnsIfExist } from "../../../../../../config/db/ensureDbColumns.js";


/**
 * { coil_no_uid, qty, mrn_uid? }[] → { mrn_uid, coil_count, qty }[]
 * Idempotent: rows already without coil_no_uid are skipped.
 */
async function backfillJcCoilsToMrnQuotas() {
  await dbQuery(`
    UPDATE ${T.ISSUE_REQUEST_JOB_CARD} jc
    SET coils = sub.quotas
    FROM (
      SELECT
        jc2.id,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'mrn_uid', g.mrn_uid,
                'coil_count', g.coil_count,
                'qty', g.qty
              )
              ORDER BY g.mrn_uid
            )
            FROM (
              SELECT
                COALESCE(
                  NULLIF(TRIM(e.elem->>'mrn_uid'), ''),
                  NULLIF(TRIM(c.mrn_uid::text), '')
                ) AS mrn_uid,
                COUNT(*)::int AS coil_count,
                COALESCE(SUM(COALESCE((e.elem->>'qty')::float8, c.qty, 0)), 0)::float8 AS qty
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(jc2.coils) = 'array' THEN jc2.coils ELSE '[]'::jsonb END
              ) AS e(elem)
              LEFT JOIN ${T.COIL_TABLE} c
                ON LOWER(TRIM(c.coil_no_uid)) = LOWER(TRIM(e.elem->>'coil_no_uid'))
              WHERE NULLIF(TRIM(e.elem->>'coil_no_uid'), '') IS NOT NULL
              GROUP BY 1
              HAVING COALESCE(
                NULLIF(TRIM(MAX(e.elem->>'mrn_uid')), ''),
                NULLIF(TRIM(MAX(c.mrn_uid::text)), '')
              ) IS NOT NULL
            ) g
            WHERE g.mrn_uid IS NOT NULL
          ),
          '[]'::jsonb
        ) AS quotas
      FROM ${T.ISSUE_REQUEST_JOB_CARD} jc2
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(jc2.coils) = 'array' THEN jc2.coils ELSE '[]'::jsonb END
        ) AS e(elem)
        WHERE NULLIF(TRIM(e.elem->>'coil_no_uid'), '') IS NOT NULL
      )
    ) sub
    WHERE jc.id = sub.id
      AND sub.quotas <> '[]'::jsonb
  `);
}


/** One row per job card — FG/RM mapping + MRN quotas in coils JSONB. */
export async function createRmStoreIssueRequestJobCardTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ${T.ISSUE_REQUEST_JOB_CARD} (
      id               SERIAL PRIMARY KEY,
      issue_uid        INTEGER NOT NULL REFERENCES ${T.ISSUE_REQUEST}(issue_uid) ON DELETE CASCADE,
      pjobcardno       VARCHAR(100) NOT NULL,
      pldt             TIMESTAMP,
      macname          VARCHAR(100),
      item_dcode       INTEGER,
      item_code        VARCHAR(100),
      item_desc        TEXT,
      rm_item_dcode    INTEGER,
      rm_item_code     VARCHAR(100),
      rm_item_desc     TEXT,
      planqty          NUMERIC DEFAULT 0,
      issue_qty        NUMERIC DEFAULT 0,
      part_weight      NUMERIC DEFAULT 0,
      rm_weight        NUMERIC DEFAULT 0,
      coils            JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       TEXT,
      deleted_at       TIMESTAMP,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_jc_issue_uid_idx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(issue_uid) WHERE is_deleted = false;

    CREATE INDEX IF NOT EXISTS rmstore_issue_request_jc_pjobcardno_idx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(UPPER(TRIM(pjobcardno))) WHERE is_deleted = false;

    CREATE UNIQUE INDEX IF NOT EXISTS rmstore_issue_request_jc_issue_pjc_uidx
      ON ${T.ISSUE_REQUEST_JOB_CARD}(issue_uid, UPPER(TRIM(pjobcardno)))
      WHERE is_deleted = false;
  `);

  // Denorm / unused — coil count from coils JSON; production remapped from item
  await dropColumnsIfExist(dbQuery, T.ISSUE_REQUEST_JOB_CARD, [ "production_id", "coil_count", "updated_by", "updated_at" ]);

  // Legacy coils JSON had coil_no_uid — collapse to MRN quotas (no specific coil).
  // Set false after live verify if you want boot to skip.
  const RUN_MRN_QUOTA_BACKFILL = true;
  if (RUN_MRN_QUOTA_BACKFILL) {
    await backfillJcCoilsToMrnQuotas();
  }
}