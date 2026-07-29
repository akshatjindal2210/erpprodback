import { sanitizeSearch } from "../../../core/lib/utils/helper/helper.js";
import { RMSTORE_TABLES as T } from "../../../../config/db/dbTables.js";

/** True when coil list should ignore date range and match across full DB. */
export function hasCoilJourneyFilter(filters = {}) {
  return Boolean(sanitizeSearch(filters.journey));
}

/**
 * Coil list journey — match MRN / coil sticker no / item code across full DB (no date window).
 * @returns next param index after pushing journey bind values
 */
export function appendCoilJourneyCondition(conditions, values, journey, startIndex) {
  const j = sanitizeSearch(journey);
  if (!j) return startIndex;
  const exactIdx = startIndex;
  const prefixIdx = startIndex + 1;
  values.push(j, `${j}%`);
  conditions.push(`(
    c.coil_no_uid = $${exactIdx}
    OR c.coil_no_uid ILIKE $${prefixIdx}
    OR c.coil_uid::text = $${exactIdx}
    OR TRIM(COALESCE(c.mrn_uid, '')) = $${exactIdx}
    OR COALESCE(c.mrn_uid, '') ILIKE $${prefixIdx}
    OR c.mrn_no::text = $${exactIdx}
    OR TRIM(COALESCE(c.heat_no, '')) ILIKE $${exactIdx}
    OR TRIM(COALESCE(c.item_code, '')) ILIKE $${exactIdx}
  )`);
  return startIndex + 2;
}

function pushJourneyParams(journey, values) {
  const j = sanitizeSearch(journey);
  if (!j) return null;
  values.push(j, `${j}%`);
  return { exactIdx: values.length - 1, prefixIdx: values.length };
}

const JOURNEY_COILS_CTE = (exactIdx, prefixIdx) => `
journey_coils AS (
  SELECT c.coil_no_uid, TRIM(c.mrn_no::text) AS mrn_no
  FROM ${T.COIL_TABLE} c
  WHERE COALESCE(c.is_deleted, false) = false
    AND (
      c.coil_no_uid = $${exactIdx}
      OR c.coil_no_uid ILIKE $${prefixIdx}
      OR c.coil_uid::text = $${exactIdx}
      OR TRIM(c.mrn_no::text) = $${exactIdx}
      OR c.mrn_no::text ILIKE $${prefixIdx}
      OR TRIM(COALESCE(c.mrn_uid, '')) = $${exactIdx}
      OR COALESCE(c.mrn_uid, '') ILIKE $${prefixIdx}
    )
  LIMIT 300
)`;

/** Coil transaction journey filter (MRN / coil sticker; ignores date range). */
export function buildCoilTxJourneyFilter({ alias = "tb", journey, values }) {
  const params = pushJourneyParams(journey, values);
  if (!params) return null;
  const { exactIdx, prefixIdx } = params;

  if (alias !== "tb") return null;

  return {
    cte: JOURNEY_COILS_CTE(exactIdx, prefixIdx),
    condition: `(
      TRIM(tb.mrn_no::text) = $${exactIdx}
      OR tb.mrn_no ILIKE $${prefixIdx}
      OR tb.source_id::text = $${exactIdx}
      OR tb.mrn_no IN (SELECT mrn_no FROM journey_coils WHERE mrn_no IS NOT NULL AND mrn_no <> '')
      OR EXISTS (
        SELECT 1 FROM journey_coils jc
        WHERE tb.details @> jsonb_build_object('coil_no_uids', jsonb_build_array(jc.coil_no_uid))
      )
      OR EXISTS (
        SELECT 1 FROM journey_coils jc
        WHERE tb.details->>'coil_no_uid' = jc.coil_no_uid
      )
      OR EXISTS (
        SELECT 1
        FROM journey_coils jc,
             LATERAL jsonb_array_elements(COALESCE(tb.details->'coil_sticker_entries', '[]'::jsonb)) e
        WHERE e->>'coil_no_uid' = jc.coil_no_uid
      )
    )`,
  };
}
