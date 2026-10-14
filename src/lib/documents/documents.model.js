/**
 * All SQL of the documents module.
 *   `documents` table      — PK = `uuid` (`<uuid>.<ext>`)
 *   module file column(s)  — `doc_files` / `tc_file` … on the module table (from DOC_FILE_LINKS)
 */
import dbQuery from "../../config/db/db.js";
import { DOC_FILE_LINKS, hasFileColumn } from "./documents.config.js";

/** `q(sql, params)` → rows, on a transaction client. */
export const clientQ = (client) => (sql, params) => client.query(sql, params).then((r) => r.rows);

const normUuid = (u) => String(u ?? "").trim().toLowerCase();

// ── documents table ─────────────────────────────────────────────────────────

export async function isUuidUsed(q, fileName) {
  const name = normUuid(fileName);
  if (!name) return false;
  const [row] = await q(`SELECT 1 FROM documents WHERE lower(uuid) = $1 LIMIT 1`, [name]);
  return Boolean(row);
}

export async function insertDocument(q, d) {
  const uuid = normUuid(d.uuid);
  const [row] = await q(
    `INSERT INTO documents (uuid, doc_path, doc_type, doc_size, remark, mod_type, mod_ref, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [uuid, d.doc_path, d.doc_type, d.doc_size, d.remark, d.mod_type, d.mod_ref, d.created_by, d.created_by_name]
  );
  return row;
}

/** status = false (row kept as history) → row snapshot, or null if not active. */
export async function deactivateDocument(q, fileUuid) {
  const key = normUuid(fileUuid);
  if (!key) return null;
  const [row] = await q(
    `UPDATE documents SET status = false WHERE lower(uuid) = $1 AND status = true
     RETURNING mod_type, mod_ref, uuid, doc_type`,
    [key]
  );
  return row ?? null;
}

export function updateRemark(fileUuid, remark) {
  const key = normUuid(fileUuid);
  if (!key) return Promise.resolve(null);
  return dbQuery(`UPDATE documents SET remark = $1 WHERE lower(uuid) = $2 AND status = true`, [remark, key]);
}

export async function findActiveByUuid(fileUuid) {
  const key = normUuid(fileUuid);
  if (!key) return null;
  const [row] = await dbQuery(`SELECT * FROM documents WHERE lower(uuid) = $1 AND status = true`, [key]);
  return row ?? null;
}

/** @deprecated use findActiveByUuid — arg is `<uuid>.<ext>`. */
export async function findActiveById(fileUuid) {
  return findActiveByUuid(fileUuid);
}

/** Metadata by stored file name (`documents.uuid` = `<uuid>.<ext>`) — batch, no JOIN to module tables. */
export function findByFileNames(names) {
  const list = [...new Set(names.map((n) => normUuid(n)).filter(Boolean))];
  if (!list.length) return [];
  return dbQuery(`SELECT * FROM documents WHERE status = true AND lower(uuid) = ANY($1::text[])`, [list]);
}

/** @deprecated use findByFileNames — arg is `uuid.ext`, not bare uuid. */
export function findByUuids(names) {
  return findByFileNames(names);
}

export function findActiveByRefs(modType, refs) {
  if (!refs.length) return [];
  return dbQuery(
    `SELECT * FROM documents WHERE mod_type = $1 AND status = true AND mod_ref = ANY($2::text[]) ORDER BY created_at ASC, uuid ASC`,
    [modType, refs]
  );
}

// ── module file column(s) ───────────────────────────────────────────────────

/** Module rows → Map("ref" → [{ name, folder }]) in stored order. */
export async function readModuleFiles(modType, refs) {
  const cfg = DOC_FILE_LINKS[modType];
  if (!hasFileColumn(cfg) || !refs?.length) return new Map();
  const cols = cfg.multi ? [cfg.multi] : Object.values(cfg.slots).map((s) => s.col);
  // Compare as text so int keys (cl_task_id, id, …) work with string mod_ref lists from toModRef.
  const rows = await dbQuery(`SELECT ${cfg.key}::text AS ref, ${cols.join(", ")} FROM ${cfg.table} WHERE ${cfg.key}::text = ANY($1::text[])`, [refs]);
  const filesOf = (r) =>
    cfg.multi
      ? (r[cfg.multi] || []).map((name) => ({ name, folder: cfg.folder }))
      : Object.values(cfg.slots).filter((s) => r[s.col]).map((s) => ({ name: r[s.col], folder: s.folder }));
  return new Map(rows.map((r) => [r.ref, filesOf(r)]));
}

/** Add a name: multi → appended · slots → set on the slot's column. */
export async function addModuleFile(q, modType, ref, name, slot) {
  const cfg = DOC_FILE_LINKS[modType];
  if (!hasFileColumn(cfg)) return; // unknown or `register` module: documents row only
  if (cfg.multi) {
    await q(`UPDATE ${cfg.table} SET ${cfg.multi} = COALESCE(${cfg.multi}, '[]'::jsonb) || jsonb_build_array($1::text) WHERE ${cfg.key} = $2`, [name, ref]);
  } else if (cfg.slots[slot]) {
    await q(`UPDATE ${cfg.table} SET ${cfg.slots[slot].col} = $1 WHERE ${cfg.key} = $2`, [name, ref]);
  }
}

/** Remove a name: multi → taken out (empty → NULL) · slots → column set to NULL where it holds this name. */
export async function removeModuleFile(q, modType, ref, name) {
  const cfg = DOC_FILE_LINKS[modType];
  if (!hasFileColumn(cfg)) return; // unknown or `register` module: documents row only
  if (cfg.multi) {
    await q(`UPDATE ${cfg.table} SET ${cfg.multi} = NULLIF(COALESCE(${cfg.multi}, '[]'::jsonb) - $1::text, '[]'::jsonb) WHERE ${cfg.key} = $2`, [name, ref]);
  } else {
    const sets = Object.values(cfg.slots).map((s) => `${s.col} = CASE WHEN ${s.col} = $1 THEN NULL ELSE ${s.col} END`);
    await q(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE ${cfg.key} = $2`, [name, ref]);
  }
}

/** `register` module: write its JSON attachment list back (file paths changed to `<folder>/<uuid>.<ext>`). */
export async function updateRegisterJson(modType, ref, list) {
  const cfg = DOC_FILE_LINKS[modType];
  if (!cfg?.register || !cfg.jsonCol) return;
  await dbQuery(`UPDATE ${cfg.table} SET ${cfg.jsonCol} = $1::jsonb WHERE ${cfg.key}::text = $2`, [list.length ? JSON.stringify(list) : null, String(ref)]);
}
