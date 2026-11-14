/**
 * ims_tray_manage → light register:
 * columns: type, packing_number, link_count, data{links only}
 * Item codes are NOT stored — list joins stickers → dailyprod.
 * Idempotent — safe to re-run on boot.
 */
import dbQuery, { withTransaction } from "../../config/db/db.js";
import { IMS_TABLES as T } from "../../config/db/dbTables.js";
import {
  columnExists,
  dropColumnIfExists,
  patchCol,
  patchTableSchema,
  renameColumnIfExists,
} from "../../config/db/ensureDbColumns.js";
import { snapshotMetadataFromBoxUids } from "../../apps/ims/lib/utils/erp-api/list/entryListMetadata.js";

const TABLE = T.TRAY_MANAGE;
const STAGING = "ims_tray_manage_colorder_tmp";
const DROP_COLS = [
  "item_codes",
  "qtys",
  "total_qty",
  "entry_type",
  "need",
  "box_no_uids",
  "tray_codes",
  "link_qtys",
  "from_tray_codes",
  "tray_code",
];

/** Keep only links[] in data JSON (drop cached item/qty/type/packing keys). */
const SLIM_DATA_SQL = `jsonb_strip_nulls(jsonb_build_object(
  'links', COALESCE(data->'links', '[]'::jsonb)
))`;

async function tableExists() {
  const rows = await dbQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'ims_tray_manage' LIMIT 1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function tableExistsLink() {
  const rows = await dbQuery(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'ims_tray_manage_link' LIMIT 1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function mergeEntryTypeIntoType() {
  const hasType = await columnExists(dbQuery, TABLE, "type");
  const hasEntryType = await columnExists(dbQuery, TABLE, "entry_type");
  if (!hasEntryType) return;
  if (!hasType) {
    await renameColumnIfExists(dbQuery, TABLE, "entry_type", "type");
    return;
  }
  await dbQuery(`
    UPDATE ${TABLE}
    SET type = LOWER(COALESCE(
      NULLIF(TRIM(type), ''),
      NULLIF(TRIM(entry_type), ''),
      NULLIF(TRIM(data->>'type'), ''),
      NULLIF(TRIM(data->>'entry_type'), ''),
      'assign'
    ))
    WHERE COALESCE(is_deleted, false) = false
  `);
}

async function normalizeTypeAndPacking() {
  if (!(await columnExists(dbQuery, TABLE, "data"))) return;
  await dbQuery(`
    UPDATE ${TABLE} m
    SET
      type = LOWER(COALESCE(
        NULLIF(TRIM(m.type), ''),
        NULLIF(TRIM(m.data->>'type'), ''),
        NULLIF(TRIM(m.data->>'entry_type'), ''),
        'assign'
      )),
      packing_number = COALESCE(
        NULLIF(TRIM(m.packing_number), ''),
        NULLIF(TRIM(m.data->>'packings'), ''),
        NULLIF(TRIM(m.data->>'packing_numbers'), ''),
        NULLIF(TRIM(m.data->>'packing_number'), '')
      ),
      remark = COALESCE(
        NULLIF(TRIM(m.remark), ''),
        NULLIF(TRIM(m.data->>'remark'), '')
      )
    WHERE COALESCE(m.is_deleted, false) = false
  `);
  await dbQuery(`
    UPDATE ${TABLE}
    SET type = 'assign'
    WHERE COALESCE(is_deleted, false) = false
      AND LOWER(COALESCE(NULLIF(TRIM(type), ''), 'link')) IN ('link', 'submit')
  `);
}

function splitPipe(v) {
  if (v == null || !String(v).trim()) return [];
  return String(v)
    .split(" | ")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pipesToCompactLinks(row) {
  const stickers = splitPipe(row.box_no_uids);
  const trays = splitPipe(row.tray_codes);
  const qtys = splitPipe(row.link_qtys);
  const froms = splitPipe(row.from_tray_codes);
  const n = Math.max(stickers.length, trays.length, 0);
  const links = [];
  for (let i = 0; i < n; i++) {
    const sticker = stickers[i];
    const tray = trays[i];
    if (!sticker || !tray) continue;
    const link = { sticker, tray };
    if (qtys[i] !== undefined && qtys[i] !== "") {
      const q = Number(qtys[i]);
      if (Number.isFinite(q)) link.qty = q;
    }
    if (froms[i]) link.from = froms[i];
    links.push(link);
  }
  return links;
}

function linkStickers(data = {}) {
  const links = Array.isArray(data?.links) ? data.links : [];
  return links
    .map((l) => String(l?.sticker ?? l?.s ?? l?.box_no_uid ?? "").trim())
    .filter(Boolean);
}

/** Build data.links from legacy link-table / pipe columns. */
async function consolidateLinksIntoData() {
  let touched = 0;

  if (await tableExistsLink()) {
    const rows = await dbQuery(`
      SELECT manage_id AS id,
        jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'sticker', box_no_uid,
            'tray', tray_code,
            'pn', packing_number,
            'qty', qty,
            'from', from_tray_code
          )) ORDER BY line_no
        ) AS links
      FROM ims_tray_manage_link
      GROUP BY manage_id
    `);
    for (const row of rows) {
      const links = row.links ?? [];
      const n = links.length;
      const { affectedRows } = await dbQuery(
        `UPDATE ${TABLE}
         SET data = jsonb_build_object('links', $2::jsonb),
             link_count = GREATEST(COALESCE(link_count, 0), $3)
         WHERE id = $1
           AND (
             data IS NULL
             OR jsonb_array_length(COALESCE(data->'links', '[]'::jsonb)) = 0
             OR jsonb_array_length(COALESCE(data->'links', '[]'::jsonb)) < $3
           )`,
        [row.id, JSON.stringify(links), n],
      );
      if (affectedRows) touched += 1;
    }
    await dbQuery(`DROP TABLE IF EXISTS ims_tray_manage_link`);
  }

  if (await columnExists(dbQuery, TABLE, "box_no_uids")) {
    const pipeRows = await dbQuery(`
      SELECT id, box_no_uids, tray_codes, link_qtys, from_tray_codes, data
      FROM ${TABLE}
      WHERE NULLIF(TRIM(box_no_uids), '') IS NOT NULL
    `);
    for (const row of pipeRows) {
      const links = pipesToCompactLinks(row);
      if (!links.length) continue;
      const prev = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
      const existing = Array.isArray(prev.links) ? prev.links : [];
      if (existing.length >= links.length) continue;
      await dbQuery(
        `UPDATE ${TABLE}
         SET data = jsonb_build_object('links', $2::jsonb),
             link_count = GREATEST(COALESCE(link_count, 0), $3)
         WHERE id = $1`,
        [row.id, JSON.stringify(links), links.length],
      );
      touched += 1;
    }
  }

  return touched;
}

/** Fill empty packing from stickers; never write item/qty into data. */
async function fillPackingFromLinks() {
  if (!(await columnExists(dbQuery, TABLE, "data"))) return 0;

  const rows = await dbQuery(`
    SELECT id, data, packing_number
    FROM ${TABLE}
    WHERE COALESCE(is_deleted, false) = false
      AND NULLIF(TRIM(COALESCE(packing_number, '')), '') IS NULL
      AND jsonb_array_length(COALESCE(data->'links', '[]'::jsonb)) > 0
  `);

  let updated = 0;
  for (const row of rows) {
    const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
    const stickers = linkStickers(data);
    if (!stickers.length) continue;
    const meta = await snapshotMetadataFromBoxUids(stickers, { includePackingNumbers: true });
    if (!meta?.packing_numbers) continue;
    await dbQuery(`UPDATE ${TABLE} SET packing_number = $2 WHERE id = $1`, [
      row.id,
      meta.packing_numbers,
    ]);
    updated += 1;
  }
  return updated;
}

/** Strip cached item/qty/type/packing from data — keep links only.
 *  Avoid jsonb `?` — our db layer turns `?` into `$1` placeholders. */
async function stripHeavyDataKeys() {
  if (!(await columnExists(dbQuery, TABLE, "data"))) return 0;
  const { affectedRows } = await dbQuery(`
    UPDATE ${TABLE}
    SET data = ${SLIM_DATA_SQL},
        link_count = GREATEST(
          COALESCE(link_count, 0),
          jsonb_array_length(COALESCE(data->'links', '[]'::jsonb))
        )
    WHERE data IS NOT NULL
      AND (
        jsonb_typeof(data) IS DISTINCT FROM 'object'
        OR NOT jsonb_exists(data, 'links')
        OR (COALESCE(data, '{}'::jsonb) - 'links') <> '{}'::jsonb
      )
  `);
  return affectedRows || 0;
}

async function dropLegacyColumns() {
  for (const col of DROP_COLS) {
    await dropColumnIfExists(dbQuery, TABLE, col);
  }
}

async function needsSlimReorder() {
  const rows = await dbQuery(`
    SELECT column_name, ordinal_position::int AS pos
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ims_tray_manage'
  `);
  const by = Object.fromEntries(rows.map((r) => [r.column_name, r.pos]));
  if (by.item_codes || by.qtys || by.total_qty || by.tray_code) return true;
  return by.type !== 2 || by.packing_number !== 3 || by.link_count !== 4;
}

async function rebuildSlimTable() {
  if (!(await needsSlimReorder())) return false;

  await withTransaction(async (client) => {
    await client.query(`DROP TABLE IF EXISTS ${STAGING}`);
    await client.query(`
      CREATE TABLE ${STAGING} (
        id               SERIAL PRIMARY KEY,
        type             TEXT NOT NULL DEFAULT 'assign',
        packing_number   TEXT,
        link_count       INTEGER NOT NULL DEFAULT 0,
        data             JSONB NOT NULL DEFAULT '{"links":[]}'::jsonb,
        remark           TEXT,
        approved         BOOLEAN NOT NULL DEFAULT true,
        approved_by      TEXT,
        approved_at      TIMESTAMP,
        created_by       TEXT,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_by       TEXT,
        updated_at       TIMESTAMP,
        is_deleted       BOOLEAN NOT NULL DEFAULT false,
        deleted_by       TEXT,
        deleted_at       TIMESTAMP
      )
    `);

    await client.query(`
      INSERT INTO ${STAGING} (
        id, type, packing_number, link_count, data, remark,
        approved, approved_by, approved_at, created_by, created_at, updated_by, updated_at,
        is_deleted, deleted_by, deleted_at
      )
      SELECT
        m.id,
        CASE
          WHEN LOWER(COALESCE(NULLIF(TRIM(m.type), ''), 'assign')) IN ('link', 'submit') THEN 'assign'
          ELSE LOWER(COALESCE(NULLIF(TRIM(m.type), ''), 'assign'))
        END,
        m.packing_number,
        GREATEST(
          COALESCE(m.link_count, 0),
          jsonb_array_length(COALESCE(m.data->'links', '[]'::jsonb))
        ),
        jsonb_strip_nulls(jsonb_build_object(
          'links', COALESCE(m.data->'links', '[]'::jsonb)
        )),
        m.remark,
        COALESCE(m.approved, true),
        m.approved_by,
        m.approved_at,
        m.created_by,
        m.created_at,
        m.updated_by,
        m.updated_at,
        COALESCE(m.is_deleted, false),
        m.deleted_by,
        m.deleted_at
      FROM ${TABLE} m
      ORDER BY m.id
    `);

    const src = await client.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
    const dst = await client.query(`SELECT COUNT(*)::int AS n FROM ${STAGING}`);
    const srcN = Number(src.rows[0]?.n) || 0;
    const dstN = Number(dst.rows[0]?.n) || 0;
    if (dstN < srcN) {
      throw new Error(
        `[migration] trayManageBackfill: rebuild aborted (${dstN}/${srcN} rows)`,
      );
    }

    const maxRes = await client.query(
      `SELECT COALESCE(MAX(id), 0)::int AS max_id FROM ${STAGING}`,
    );
    const maxId = Number(maxRes.rows[0]?.max_id) || 0;
    const seq = `${STAGING}_id_seq`;
    if (maxId > 0) {
      await client.query(`SELECT setval('${seq}', $1, true)`, [maxId]);
    }

    await client.query(`DROP TABLE IF EXISTS ims_tray_manage_link`);
    await client.query(`DROP TABLE ${TABLE}`);
    await client.query(`ALTER TABLE ${STAGING} RENAME TO ims_tray_manage`);
    await client.query(`ALTER SEQUENCE ${seq} RENAME TO ims_tray_manage_id_seq`);
    await client.query(
      `ALTER TABLE ${TABLE} ALTER COLUMN id SET DEFAULT nextval('ims_tray_manage_id_seq'::regclass)`,
    );
  });

  return true;
}

async function refreshIndexes() {
  await dbQuery(`DROP INDEX IF EXISTS tray_manage_packing_uidx`);
  await dbQuery(`DROP INDEX IF EXISTS tray_manage_packings_idx`);
  await dbQuery(`DROP INDEX IF EXISTS tray_manage_entry_type_idx`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS tray_manage_packing_idx ON ${TABLE} (packing_number, id DESC) WHERE is_deleted = false`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS tray_manage_type_idx ON ${TABLE} (type) WHERE is_deleted = false`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS tray_manage_created_at_idx ON ${TABLE} (created_at DESC)`,
  );
}

export default async function up() {
  if (!(await tableExists())) {
    console.log("[migration] trayManageBackfill: table missing — skip");
    return;
  }

  await patchTableSchema(dbQuery, TABLE, {
    columns: [
      patchCol("type", "TEXT NOT NULL DEFAULT 'assign'"),
      patchCol("packing_number", "TEXT"),
      patchCol("link_count", "INTEGER NOT NULL DEFAULT 0"),
      patchCol("data", `JSONB NOT NULL DEFAULT '{"links":[]}'::jsonb`),
      patchCol("remark", "TEXT"),
    ],
    columnTypes: [{ name: "type", type: "text" }],
  });

  await mergeEntryTypeIntoType();
  await normalizeTypeAndPacking();
  const links = await consolidateLinksIntoData();
  const packed = await fillPackingFromLinks();
  const stripped = await stripHeavyDataKeys();
  const rebuilt = await rebuildSlimTable();
  await dropLegacyColumns();
  await refreshIndexes();
  // Rebuild already wrote links-only; strip again for DBs that skipped rebuild.
  const strippedAgain = rebuilt ? 0 : await stripHeavyDataKeys();

  await dbQuery(`ALTER TABLE ${TABLE} ALTER COLUMN type SET DEFAULT 'assign'`);

  console.log(
    `[migration] trayManageBackfill: links=${links}, packing=${packed}, stripped=${stripped + strippedAgain}, rebuilt=${rebuilt}`,
  );
}
