import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import { buildJourneyFilter, hasJourneyFilter } from "../utils/logJourneyFilter.js";

const TBL = "ims_box_download_log";

const SORT_BY = {
  last_downloaded_at: "l.downloaded_at",
  last_download_type: "l.download_type",
  packing_number: "l.packing_number",
  box_uid: "l.box_uid",
  created_at: "l.downloaded_at",
  acc_name: "l.acc_name",
  download_source: "l.download_source",
};

/** Snapshot fields saved on each download (keeps inserts short in controllers). */
export function pickStickerLogFields(enriched = {}, fallback = {}) {
  return {
    packing_number: enriched.packing_number || fallback.packing_number || null,
    item_dcode: enriched.item_dcode || enriched.itemdcode || null,
    acc_name: enriched.acc_name || enriched.override_cust || fallback.override_cust || null,
  };
}

function textOrNull(val, max = 0) {
  if (val == null || String(val).trim() === "") return null;
  const s = String(val).trim();
  return max > 0 ? s.slice(0, max) : s;
}

export async function insertDownloadLog({
  box_uid,
  packing_number = null,
  item_dcode = null,
  acc_name = null,
  downloaded_by,
  download_type = "single",
  sticker_count = 1,
  download_source = null,
}) {
  const isBulk = String(download_type).toLowerCase() === "bulk_pack";
  const uid = isBulk ? null : Number(box_uid);
  const packing = textOrNull(packing_number);

  if (!isBulk && (!Number.isFinite(uid) || uid <= 0)) {
    throw new Error("insertDownloadLog: box_uid required for single download");
  }
  if (isBulk && !packing) {
    throw new Error("insertDownloadLog: packing_number required for bulk_pack");
  }

  const count = Math.max(1, Number(sticker_count) || 1);

  const [row] = await dbQuery(
    `INSERT INTO ${TBL}
       (box_uid, packing_number, item_dcode, acc_name, downloaded_by, download_type, sticker_count, download_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      uid,
      packing,
      textOrNull(item_dcode),
      textOrNull(acc_name, 255),
      downloaded_by,
      download_type,
      isBulk ? count : 1,
      textOrNull(download_source, 48),
    ]
  );
  return row;
}

function buildListQuery(filters = {}, values) {
  const journeyMode = hasJourneyFilter(filters);

  if (journeyMode) {
    const built = buildJourneyFilter({ alias: "l", journey: filters.journey, values });
    if (!built) return { cte: "", where: "" };
    return {
      cte: `WITH ${built.cte}`,
      where: `WHERE ${built.condition}`,
    };
  }

  const parts = [];
  if (filters.from_date) {
    values.push(filters.from_date);
    parts.push(`l.downloaded_at >= $${values.length}::timestamp`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    parts.push(`l.downloaded_at <= $${values.length}::timestamp`);
  }
  return {
    cte: "",
    where: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
  };
}

const LIST_SELECT = `
  l.log_id,
  l.box_uid,
  l.packing_number,
  l.acc_name,
  l.item_dcode AS itemdcode,
  l.sticker_count AS event_sticker_count,
  l.downloaded_at AS last_downloaded_at,
  u.name AS last_downloaded_by_name,
  l.download_type AS last_download_type,
  l.sticker_count AS last_bulk_sticker_count,
  l.download_source,
  CASE
    WHEN l.download_type = 'bulk_pack' THEN 'ALL'
    ELSE COALESCE(l.box_uid::text, 'log-' || l.log_id::text)
  END AS primary_label`;

export async function listStickerDownloadLogs(options = {}) {
  const { filters = {}, page = 1, limit = 10, sort = {} } = options;

  const values = [];
  const { cte, where } = buildListQuery(filters, values);

  const sortCol = SORT_BY[sort.by] || SORT_BY.last_downloaded_at;
  const sortDir = String(sort.order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const listFrom = `FROM ${TBL} l LEFT JOIN ${M.USERS} u ON u.id = l.downloaded_by`;

  const listValues = [...values, safeLimit, offset];
  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;

  const [countRows, rows] = await Promise.all([
    dbQuery(`${cte ? `${cte} ` : ""}SELECT COUNT(*)::int AS count FROM ${TBL} l ${where}`, values),
    dbQuery(
      `${cte ? `${cte} ` : ""}SELECT ${LIST_SELECT}
       ${listFrom}
       ${where}
       ORDER BY ${sortCol} ${sortDir} NULLS LAST, l.log_id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      listValues
    ),
  ]);

  const total = countRows[0]?.count || 0;

  return {
    data: rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
}
