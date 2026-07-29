import { sanitizeSearch } from "../../../core/lib/utils/helper/helper.js";

/** True when list should ignore date range and load full DB match for packing / box sticker / item code. */
export function hasJourneyFilter(filters = {}) {
  const j = sanitizeSearch(filters.journey);
  return Boolean(j);
}

function pushJourneyParams(journey, values) {
  const j = sanitizeSearch(journey);
  if (!j) return null;
  values.push(j, `${j}%`);
  return { exactIdx: values.length - 1, prefixIdx: values.length };
}

const JOURNEY_BOXES_CTE = `
journey_boxes AS (
  SELECT b.box_uid, TRIM(b.packing_number::text) AS packing_number, b.box_no_uid
  FROM ims_box_table b
  WHERE COALESCE(b.is_deleted, false) = false
    AND (
      b.box_no_uid = $1
      OR b.box_no_uid ILIKE $2
      OR b.box_uid::text = $1
      OR TRIM(b.packing_number::text) = $1
      OR b.packing_number ILIKE $2
    )
  LIMIT 300
)`;

/** Box transaction log — item code journey only (non-numeric search). */
const JOURNEY_ITEM_CODE_CTES = `
journey_item_packings AS (
  SELECT TRIM(dp.doc_no::text) AS packing_number
  FROM ims_dailyprod dp
  WHERE dp.item_code ILIKE $1
),
journey_item_adjustments AS (
  SELECT sa.adjustment_id, NULLIF(TRIM(sa.packing_number::text), '') AS packing_number
  FROM ims_stock_adjustment sa
  WHERE sa.is_deleted = false
    AND sa.item_code ILIKE $1
),
journey_boxes AS (
  SELECT b.box_uid, TRIM(b.packing_number::text) AS packing_number, b.box_no_uid
  FROM ims_box_table b
  WHERE COALESCE(b.is_deleted, false) = false
    AND (
      b.box_no_uid = $1
      OR b.box_no_uid ILIKE $2
      OR b.box_uid::text = $1
      OR TRIM(b.packing_number::text) = $1
      OR b.packing_number ILIKE $2
      OR TRIM(b.packing_number::text) IN (SELECT packing_number FROM journey_item_packings)
      OR b.sa_id IN (SELECT adjustment_id FROM journey_item_adjustments)
      OR TRIM(b.packing_number::text) IN (
        SELECT packing_number FROM journey_item_adjustments WHERE packing_number IS NOT NULL
      )
    )
  LIMIT 300
),
journey_packings AS (
  SELECT packing_number FROM journey_item_packings
  UNION
  SELECT packing_number FROM journey_boxes WHERE packing_number IS NOT NULL AND packing_number <> ''
  UNION
  SELECT packing_number FROM journey_item_adjustments WHERE packing_number IS NOT NULL
)`;

function isNumericJourney(journey) {
  const j = sanitizeSearch(journey);
  return Boolean(j && /^\d+$/.test(j));
}

/**
 * Fast journey filter — resolve boxes once (indexed), then match logs.
 * @returns {{ cte: string, condition: string } | null}
 */
export function buildJourneyFilter({ alias, journey, values }) {
  const params = pushJourneyParams(journey, values);
  if (!params) return null;

  const { exactIdx, prefixIdx } = params;

  if (alias === "tb") {
    const itemCodeMode = !isNumericJourney(journey);
    const cte = itemCodeMode ? JOURNEY_ITEM_CODE_CTES : JOURNEY_BOXES_CTE;
    const packingMatch = itemCodeMode
      ? `OR tb.packing_number IN (SELECT packing_number FROM journey_packings)
        OR (
          tb.source_module = 'stock_adjustment'
          AND tb.source_id IN (SELECT adjustment_id::text FROM journey_item_adjustments)
        )`
      : `OR tb.packing_number IN (
          SELECT packing_number FROM journey_boxes
          WHERE packing_number IS NOT NULL AND packing_number <> ''
        )`;

    return {
      cte,
      condition: `(
        TRIM(tb.packing_number::text) = $${exactIdx}
        OR tb.packing_number ILIKE $${prefixIdx}
        OR tb.source_id::text = $${exactIdx}
        ${packingMatch}
        OR EXISTS (
          SELECT 1 FROM journey_boxes jb
          WHERE tb.details @> jsonb_build_object('box_uids', jsonb_build_array(jb.box_uid))
        )
        OR EXISTS (
          SELECT 1 FROM journey_boxes jb
          WHERE tb.details @> jsonb_build_object('box_no_uids', jsonb_build_array(jb.box_no_uid))
        )
        OR EXISTS (
          SELECT 1
          FROM journey_boxes jb,
               LATERAL jsonb_array_elements(COALESCE(tb.details->'box_sticker_entries', '[]'::jsonb)) e
          WHERE e->>'box_no_uid' = jb.box_no_uid
        )
      )`,
    };
  }

  if (alias === "l") {
    return {
      cte: JOURNEY_BOXES_CTE,
      condition: `(
        TRIM(l.packing_number::text) = $${exactIdx}
        OR l.packing_number ILIKE $${prefixIdx}
        OR l.box_uid::text = $${exactIdx}
        OR l.box_uid IN (SELECT box_uid FROM journey_boxes)
        OR l.packing_number IN (SELECT packing_number FROM journey_boxes WHERE packing_number IS NOT NULL AND packing_number <> '')
      )`,
    };
  }

  return null;
}

/** @deprecated use buildJourneyFilter */
export function appendJourneySql(opts) {
  const built = buildJourneyFilter(opts);
  if (!built) return false;
  opts.conditions.push(built.condition);
  return true;
}

/**
 * Box list journey — match packing no / box sticker no / item code across full DB (no date window).
 * Packing/box use prefix; item_code is exact only (so HN006 does not match HN006TW / HN006Y).
 * Item code is resolved via joined dailyprod / stock_adjustment (same joins as findBoxes).
 * @returns next param index after pushing journey bind values
 */
export function appendBoxJourneyCondition(conditions, values, journey, startIndex) {
  const j = sanitizeSearch(journey);
  if (!j) return startIndex;
  const exactIdx = startIndex;
  const prefixIdx = startIndex + 1;
  values.push(j, `${j}%`);
  conditions.push(`(
    b.box_no_uid = $${exactIdx}
    OR b.box_no_uid ILIKE $${prefixIdx}
    OR b.box_uid::text = $${exactIdx}
    OR TRIM(b.packing_number::text) = $${exactIdx}
    OR b.packing_number ILIKE $${prefixIdx}
    OR TRIM(dp.item_code::text) ILIKE $${exactIdx}
    OR TRIM(sa.item_code::text) ILIKE $${exactIdx}
  )`);
  return startIndex + 2;
}
