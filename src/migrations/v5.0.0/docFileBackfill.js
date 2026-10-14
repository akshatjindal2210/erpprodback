/**
 * v5.0.0 AUTO migration — runs on every boot while the app version is 5.0.0 (`runVersionMigrations()`).
 * Safe to re-run: a legacy file always maps to the same `<uuid>.<ext>` name, so nothing is added twice.
 * Also callable manually: `backfillDocFiles()` (backfills/index.js, initDB section 5).
 *
 *  0. Old `documents` table (live DB before v5.0.0): add `uuid`, make `doc_name` / `created_by` optional.
 *     Rows added by a backfill are marked `created_by = NULL`, `created_by_name = 'system'`.
 *  A. Old `documents` rows without uuid → UUIDv7, file COPIED to `<module folder>/<uuid>.<ext>` (old file stays).
 *  D. Names on module records without an active documents row are removed (per module).
 *  E. Active rows → `doc_path` = `<module folder>/`; file copied there if needed; `doc_type` from the name.
 *  F. Module `doc_files` / slot columns rebuilt from active documents (`<uuid>.<ext>` names).
 *  B. Every record's old path column(s) (tc_file_path, attachments, receiving_file, QC items, self-note / recurring chat /
 *     CL task JSON …) → `documents` rows, for EVERY file not in `documents` yet (not only records that were empty).
 *     Slot modules (TC / RMTC) only fill a slot that is still empty. A file used by two records is copied per record.
 *     Missing files on disk are skipped and counted. Each file is its own savepoint: one bad row never undoes the rest.
 *     `register` modules (own JSON list): JSON paths are rewritten to the new `<folder>/<uuid>.<ext>` path.
 *  G. Old path columns (MRN / SA tc+rmtc, task_chat / IPR / machine attachments, CL master attachment, gate receiving_file) are dropped once every file in them that still exists
 *     on disk is in `documents`. Only a failed file (DB / copy error — fix and restart) keeps them. A file that is gone
 *     from disk can never be migrated: its record + path are written to the log (combined.log) and the column is dropped.
 *     More than half of a module's old files missing = wrong UPLOAD_PATH → columns kept.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dbQuery, { withTransaction } from "../../config/db/db.js";
// One-time data fix — uses the documents module internals directly (apps use lib/documents/index.js).
import { DOC_FILE_LINKS, folderOf, fileDocPath, docFileName, slotOf, hasFileColumn } from "../../lib/documents/documents.config.js";
import { RMSTORE_TABLES as R, TASK_TABLES as TaskT, IMS_TABLES as I, ENGINEERING_TABLES as E } from "../../config/db/dbTables.js";
import { clientQ, insertDocument, addModuleFile } from "../../lib/documents/documents.model.js";
import { createDocumentsTable } from "../../lib/documents/documents.table.js";
import { copyUploadFile, absUploadPath, normDocPath, normFolderPath, lowerExt, uuidFileName, uuidFromFileName, sizeKb, isUuidExtFile, fullDocPublicPath } from "../../lib/documents/documents.utils.js";
import { parseReceivingFilePaths } from "../../apps/ims/modules/invoice-receiving/utils/buildInvReceivingUploadFilter.js";
import logger from "../../apps/core/lib/utils/logging/logger.js";

const list = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  } catch {
    return [];
  }
};

const json = (raw) => {
  if (raw == null || typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Every `{ file_path }` object anywhere inside a JSON value (CL form responses). */
function collectFileObjects(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => collectFileObjects(v, out));
  else if (value && typeof value === "object") {
    if (typeof value.file_path === "string") out.push(value);
    else Object.values(value).forEach((v) => collectFileObjects(v, out));
  }
  return out;
}

const filePathOf = (a) => (typeof a === "string" ? a : a?.file_path || a?.path || a?.url);

/**
 * Old path column(s) per module → `[{ p, slot?, remark?, item? }]` for one record.
 * `rewrite(row, moved)` (register modules) → `{ col, value }` with the JSON paths changed to the new paths.
 */
const OLD_PATHS = {
  rm_mrn_portal: { cols: ["tc_file_path", "rmtc_file_path"], files: (r) => [{ p: r.tc_file_path, slot: "tc" }, { p: r.rmtc_file_path, slot: "rmtc" }] },
  rm_stock_adjustment: { cols: ["tc_file_path", "rmtc_file_path"], files: (r) => [{ p: r.tc_file_path, slot: "tc" }, { p: r.rmtc_file_path, slot: "rmtc" }] },
  rm_qc_check: { cols: ["items"], files: (r) => list(r.items).map((it, item) => ({ p: it?.document_id ? null : it?.document_note, remark: it?.document_remark, item })) },
  rm_in_process_request: { cols: ["attachments"], files: (r) => list(r.attachments).map((a) => ({ p: filePathOf(a), remark: a?.remark })) },
  invoice_receiving: { cols: ["receiving_file"], files: (r) => parseReceivingFilePaths(r.receiving_file).map((p) => ({ p })) },
  eng_machine_master: { cols: ["attachments"], files: (r) => list(r.attachments).map((a) => ({ p: filePathOf(a), remark: a?.remark })) },
  tasks: { cols: ["attachments"], files: (r) => list(r.attachments).map((a) => ({ p: filePathOf(a), remark: a?.remark })) },
  task_self_note: jsonListPaths("attachments"),
  task_recurring_chat: jsonListPaths("attachments"),
  cl_task_master: { cols: ["attachment"], files: (r) => list(r.attachment).map((a) => ({ p: filePathOf(a), remark: a?.remark })) },
  cl_task_fill: {
    cols: ["form_responses"],
    files: (r) => collectFileObjects(json(r.form_responses)).map((a) => ({ p: a.file_path, remark: a.remark })),
    rewrite: (r, moved) => {
      const value = json(r.form_responses);
      collectFileObjects(value).forEach((a) => {
        const to = moved.get(cleanLegacyPath(a.file_path));
        if (to) a.file_path = to;
      });
      return { col: "form_responses", value };
    },
  },
};

function jsonListPaths(col) {
  return {
    cols: [col],
    files: (r) => list(r[col]).map((a) => ({ p: filePathOf(a), remark: a?.remark })),
    rewrite: (r, moved) => ({
      col,
      value: list(r[col]).map((a) => {
        const to = moved.get(cleanLegacyPath(filePathOf(a)));
        return to && a && typeof a === "object" ? { ...a, file_path: to } : a;
      }),
    }),
  };
}

/** Legacy columns that stored full paths or JSON paths — dropped once every file in them is in `documents`. */
const LEGACY_PATH_COLUMNS = [
  { modType: "rm_mrn_portal", table: R.MRN, cols: ["tc_file_path", "rmtc_file_path", "tc_file_name", "rmtc_file_name"] },
  { modType: "rm_stock_adjustment", table: R.STOCK_ADJUSTMENT, cols: ["tc_file_path", "rmtc_file_path", "tc_file_name", "rmtc_file_name"] },
  { modType: "tasks", table: TaskT.CHAT, cols: ["attachments"] },
  { modType: "rm_in_process_request", table: R.IN_PROCESS_REQUEST, cols: ["attachments"] },
  { modType: "invoice_receiving", table: I.GATE_ENTRY, cols: ["receiving_file"] },
  { modType: "eng_machine_master", table: E.MACHINE_MASTER, cols: ["attachments"] },
  { modType: "cl_task_master", table: TaskT.CL_TASKS_MASTER, cols: ["attachment"] },
];

async function hasColumns(q, table, cols) {
  const rows = await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, cols]
  );
  return rows.length === cols.length;
}

/** Stored path / URL → public `uploads/…` path ("" when it is not a local upload). */
function cleanLegacyPath(p) {
  let s = normDocPath(typeof p === "string" ? p : "");
  if (!s || /^(blob:|data:)/i.test(s)) return "";
  if (/^(https?:)?\/\//i.test(s)) {
    const i = s.indexOf("/uploads/");
    if (i < 0) return "";
    s = s.slice(i + 1).split(/[?#]/)[0];
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as-is */
  }
  return s.replace(/^\/+/, "");
}

/** Same legacy file of the same record → always the same uuid (re-runs never add it twice). */
function stableUuid(key) {
  const h = crypto.createHash("md5").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Legacy path on disk: as stored, else the same name in the module folder. */
function findOnDisk(modType, cur, slot) {
  if (fs.existsSync(absUploadPath(cur))) return cur;
  const folder = folderOf(modType, slot ?? slotOf(cur));
  if (!folder) return null;
  const alt = normDocPath(fileDocPath(folder, path.basename(cur)));
  return fs.existsSync(absUploadPath(alt)) ? alt : null;
}

/** `ext:bytes` of a file on disk (null when missing). */
function fileSig(p) {
  try {
    return `${lowerExt(p)}:${fs.statSync(absUploadPath(p)).size}`;
  } catch {
    return null;
  }
}

/** Files already in `documents` for one record (any status) → Map(sig → public path). Catches files an older backfill saved under a random name. */
async function recordFileSigs(q, modType, ref) {
  const rows = await q(`SELECT uuid, doc_path FROM documents WHERE mod_type = $1 AND mod_ref = $2`, [modType, ref]);
  const sigs = new Map();
  for (const d of rows) {
    const full = normDocPath(fullDocPublicPath(d));
    const sig = fileSig(full);
    if (sig) sigs.set(sig, full);
  }
  return sigs;
}

/** DB: `uuid` = `<uuid>.<ext>`, `doc_path` = `uploads/…/`; disk file = folder + uuid. */
function resolveStoredFile(modType, row) {
  let name = String(row.uuid ?? "").trim().toLowerCase();
  const rawPath = normDocPath(row.doc_path);
  if (!isUuidExtFile(name)) {
    if (isUuidExtFile(path.basename(rawPath))) name = path.basename(rawPath).toLowerCase();
    else if (name && row.doc_type && !name.includes("."))
      name = `${name}.${String(row.doc_type).replace(/^\./, "").toLowerCase()}`;
    else return null;
  }
  const fullHint = isUuidExtFile(path.basename(rawPath)) ? rawPath : null;
  const folderBase =
    folderOf(modType, slotOf(fullHint ?? rawPath)) ??
    (fullHint ? path.posix.dirname(fullHint) : rawPath.replace(/\/?[^/]*$/, "") || rawPath);
  const folder = normFolderPath(folderBase);
  const full = normDocPath(fileDocPath(folderBase, name));
  return {
    uuid: name,
    doc_path: folder,
    doc_type: lowerExt(name).slice(1, 11),
    name,
    full,
    slot: slotOf(full),
  };
}

function legacyToUuidPath(modType, cur, slot, name = null) {
  const folderBase = folderOf(modType, slot ?? slotOf(cur)) ?? path.posix.dirname(cur);
  const ext = lowerExt(cur);
  const uid = uuidFromFileName(cur);
  const fileName = (name ?? (uid ? `${uid}${ext}` : uuidFileName(ext))).toLowerCase();
  const full = normDocPath(fileDocPath(folderBase, fileName));
  return {
    uuid: fileName,
    doc_path: normFolderPath(folderBase),
    doc_type: lowerExt(fileName).slice(1, 11),
    name: fileName,
    full,
    slot: slot ?? slotOf(full),
  };
}

/**
 * Old files that were copied to their new `<uuid>.<ext>` name → removed after the transaction commits (= rename).
 * `keep` = sources of a record that failed: never removed. Filled during one run.
 */
let oldFiles = { retire: new Set(), keep: new Set() };

/** After commit: delete each copied old file, unless a failed record still needs it or it is itself a documents file. */
async function removeOldFiles() {
  let removed = 0;
  for (const p of oldFiles.retire) {
    if (oldFiles.keep.has(p)) continue;
    const name = path.basename(p).toLowerCase();
    const [isDoc] = await dbQuery(`SELECT 1 FROM documents WHERE lower(uuid) = $1 AND doc_path = $2 LIMIT 1`, [name, normFolderPath(path.posix.dirname(p))]);
    if (isDoc) continue;
    try {
      fs.unlinkSync(absUploadPath(p));
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/** Set module file column(s) from active documents for each mod_ref. */
async function rebuildModuleFileColumns(q, modType, cfg, stat) {
  const rows = await q(
    `SELECT mod_ref, uuid, doc_path, doc_type
       FROM documents
      WHERE mod_type = $1 AND status = true
      ORDER BY mod_ref, created_at ASC, uuid ASC`,
    [modType]
  );
  const byRef = new Map();
  for (const d of rows) {
    const layout = resolveStoredFile(modType, d);
    if (!layout) continue;
    const curFull = isUuidExtFile(path.basename(normDocPath(d.doc_path)))
      ? normDocPath(d.doc_path)
      : normDocPath(fileDocPath(d.doc_path.replace(/\/$/, ""), d.uuid));
    if (fs.existsSync(absUploadPath(curFull))) {
      if (layout.full !== curFull && copyUploadFile(curFull, layout.full)) oldFiles.retire.add(curFull);
    } else if (!fs.existsSync(absUploadPath(layout.full))) {
      stat(modType).missing++;
      continue;
    }
    if (
      layout.doc_path !== normFolderPath(d.doc_path) ||
      layout.uuid !== String(d.uuid).toLowerCase() ||
      d.doc_type !== layout.doc_type
    ) {
      await q(`UPDATE documents SET doc_path = $1, doc_type = $2 WHERE lower(uuid) = lower($3)`, [
        layout.doc_path,
        layout.doc_type,
        d.uuid,
      ]);
      stat(modType).renamed++;
    }
    if (!hasFileColumn(cfg)) continue;
    const ref = String(d.mod_ref);
    if (!byRef.has(ref)) byRef.set(ref, cfg.multi ? [] : {});
    if (cfg.multi) byRef.get(ref).push(layout.name);
    else {
      const slot = layout.slot === "rmtc" ? "rmtc" : "tc";
      byRef.get(ref)[slot] = layout.name;
    }
  }

  // Write only when the value differs (no rewrite of every record on every boot).
  for (const [ref, files] of byRef) {
    let changed = 0;
    if (cfg.multi) {
      changed += (
        await q(
          `UPDATE ${cfg.table} SET ${cfg.multi} = $1::jsonb WHERE ${cfg.key}::text = $2 AND ${cfg.multi} IS DISTINCT FROM $1::jsonb RETURNING 1`,
          [JSON.stringify(files), ref]
        )
      ).length;
    } else {
      for (const slotKey of Object.keys(cfg.slots)) {
        const col = cfg.slots[slotKey].col;
        changed += (
          await q(`UPDATE ${cfg.table} SET ${col} = $1 WHERE ${cfg.key}::text = $2 AND ${col} IS DISTINCT FROM $1 RETURNING 1`, [
            files[slotKey] ?? null,
            ref,
          ])
        ).length;
      }
    }
    if (changed) stat(modType).filled++;
  }
}

/** D. drop names on module records that have no active documents row. */
async function cleanModuleFileColumns(q, modType, cfg, stat) {
  const hasDoc = (x) => `EXISTS (SELECT 1 FROM documents d WHERE lower(d.uuid) = lower(trim(${x})) AND d.status = true)`;
  const dropped = [];
  if (cfg.multi) {
    dropped.push(
      ...(await q(
        `UPDATE ${cfg.table} m SET ${cfg.multi} = (
           SELECT jsonb_agg(f.name ORDER BY f.i) FROM jsonb_array_elements_text(m.${cfg.multi}) WITH ORDINALITY AS f(name, i) WHERE ${hasDoc("f.name")}
         )
         WHERE m.${cfg.multi} IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.${cfg.multi}) AS f(name) WHERE NOT ${hasDoc("f.name")})
         RETURNING 1`
      ))
    );
  } else {
    for (const s of Object.values(cfg.slots)) {
      dropped.push(...(await q(`UPDATE ${cfg.table} m SET ${s.col} = NULL WHERE m.${s.col} IS NOT NULL AND NOT ${hasDoc(`m.${s.col}`)} RETURNING 1`)));
    }
  }
  stat(modType).cleaned += dropped.length;
}

/** Run `fn` inside a savepoint: an error undoes only this step and is counted. */
async function step(q, stat, modType, label, fn) {
  await q("SAVEPOINT doc_backfill");
  try {
    const out = await fn();
    await q("RELEASE SAVEPOINT doc_backfill");
    return out;
  } catch (err) {
    await q("ROLLBACK TO SAVEPOINT doc_backfill");
    stat(modType).failed++;
    if (stat(modType).failed <= 5) console.warn(`[v5.0.0 documents] ${modType} ${label}: ${err?.message || err}`);
    return undefined;
  }
}

/** B. old path column(s) of every record → documents rows (files not in documents yet). */
async function backfillOldPaths(q, modType, cfg, stat) {
  const old = OLD_PATHS[modType];
  if (!old || !(await hasColumns(q, cfg.table, old.cols))) return;
  const slotCols = cfg.slots ? Object.values(cfg.slots).map((s) => s.col) : [];
  const records = await q(
    `SELECT m.${cfg.key}::text AS ref, ${[...old.cols, ...slotCols].map((c) => `m.${c}`).join(", ")} FROM ${cfg.table} m
      WHERE ${old.cols.map((c) => `m.${c} IS NOT NULL`).join(" OR ")}`
  );

  for (const r of records) {
    const seen = new Set();
    const moved = new Map(); // legacy path → new public path (register JSON rewrite)
    let items = null;
    let sigs = null;
    let added = false;
    for (const f of old.files(r)) {
      const cur = cleanLegacyPath(f.p);
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      const slot = cfg.slots ? f.slot ?? slotOf(cur) : null;
      if (cfg.slots && (!cfg.slots[slot] || r[cfg.slots[slot].col])) continue; // slot already holds a newer file
      stat(modType).oldSeen++;

      // Same legacy file of the same record → same name every run.
      const ownUuid = uuidFromFileName(cur);
      const stable = `${stableUuid(`${modType}|${r.ref}|${cur}`)}${lowerExt(cur)}`;
      let name = stable;
      if (ownUuid) {
        const [own] = await q(`SELECT mod_type, mod_ref FROM documents WHERE lower(uuid) = $1`, [`${ownUuid}${lowerExt(cur)}`]);
        if (!own || (own.mod_type === modType && String(own.mod_ref) === r.ref)) name = `${ownUuid}${lowerExt(cur)}`;
      }
      const laid = legacyToUuidPath(modType, cur, slot, name);

      const src = findOnDisk(modType, cur, slot);

      const [already] = await q(`SELECT 1 FROM documents WHERE lower(uuid) = $1`, [laid.uuid]);
      if (already) {
        if (laid.full !== cur) moved.set(cur, laid.full);
        // copied on an earlier run but the old file was left behind → remove it now
        if (src && src !== laid.full && fs.existsSync(absUploadPath(laid.full))) oldFiles.retire.add(src);
        continue; // done on an earlier run (or removed by a user since — not brought back)
      }

      if (!src && !fs.existsSync(absUploadPath(laid.full))) {
        stat(modType).missing++;
        stat(modType).lost.push({ ref: r.ref, path: cur, item: f.item }); // gone from disk — cannot be migrated
        continue;
      }

      sigs ??= await recordFileSigs(q, modType, r.ref);
      const sig = fileSig(src ?? laid.full);
      const dup = sig && sigs.get(sig);
      if (dup) {
        if (dup !== cur) moved.set(cur, dup);
        if (src && src !== dup) oldFiles.retire.add(src); // same file already saved under another name
        continue; // same file already saved for this record (e.g. by an older backfill under another name)
      }

      const ok = await step(q, stat, modType, `${r.ref} ${cur}`, async () => {
        if (src && src !== laid.full) copyUploadFile(src, laid.full);
        const doc = await insertDocument(q, {
          uuid: laid.uuid,
          doc_path: laid.doc_path,
          doc_type: laid.doc_type,
          doc_size: sizeKb(laid.full),
          remark: f.remark == null ? null : String(f.remark).trim() || null,
          mod_type: modType,
          mod_ref: r.ref,
          created_by: null,
          created_by_name: "system",
        });
        // NOW() is the same for the whole transaction → own time per file, so the rebuild (ORDER BY created_at) keeps the old order
        await q(`UPDATE documents SET created_at = clock_timestamp() WHERE uuid = $1`, [doc.uuid]);
        await addModuleFile(q, modType, r.ref, laid.name, laid.slot);
        if (f.item != null) {
          items ??= list(r.items);
          items[f.item] = { ...items[f.item], document_id: doc.uuid, document_note: null };
        }
        return true;
      });
      if (!ok) {
        if (src) oldFiles.keep.add(src); // record not migrated → its old file stays
        stat(modType).oldFailed++;
        continue;
      }
      if (src && src !== laid.full) oldFiles.retire.add(src);
      if (sig) sigs.set(sig, laid.full);
      if (laid.full !== cur) moved.set(cur, laid.full);
      stat(modType).shifted++;
      added = true;
    }

    if (added) stat(modType).filled++;
    if (items) {
      const ok = await step(q, stat, modType, `${r.ref} items`, () => q(`UPDATE ${cfg.table} SET items = $1::jsonb WHERE ${cfg.key}::text = $2`, [JSON.stringify(items), r.ref]));
      if (!ok) stat(modType).oldFailed++;
    }
    if (old.rewrite && moved.size) {
      const { col, value } = old.rewrite(r, moved);
      const ok = await step(q, stat, modType, `${r.ref} ${col}`, () => q(`UPDATE ${cfg.table} SET ${col} = $1::jsonb WHERE ${cfg.key}::text = $2`, [JSON.stringify(value), r.ref]));
      if (!ok) stat(modType).oldFailed++;
    }
  }
}

/**
 * G. drop old path columns of a module once all its old files are migrated.
 * Only a failed file keeps them (retry on next boot). Files gone from disk are logged, then the column is dropped —
 * unless more than half of the module's old files are missing (wrong UPLOAD_PATH / files not copied yet): kept.
 */
/** Old paths of a module may be removed: no failed file and not "most files missing" (= wrong UPLOAD_PATH). Logs why not. */
function canRetireOldPaths(s, table) {
  if (s?.oldFailed) {
    console.warn(`[v5.0.0 documents] ${table}: old paths kept (${s.oldFailed} file(s) failed) — fix and restart to retry`);
    return false;
  }
  if (s && s.lost.length * 2 > s.oldSeen) {
    console.warn(
      `[v5.0.0 documents] ${table}: old paths kept — ${s.lost.length} of ${s.oldSeen} old file(s) not on disk. Check UPLOAD_PATH (${absUploadPath("uploads")}) and restart`
    );
    return false;
  }
  return true;
}

/** Files gone from disk (never migrated) → log with record + path before their old path is removed. */
function logLost(s, table) {
  if (!s?.lost.length) return;
  const msg = `[v5.0.0 documents] ${table}: ${s.lost.length} old file(s) not on disk, not migrated (record path): ${s.lost.map((l) => `${l.ref} ${l.path}`).join(" | ")}`;
  console.warn(msg);
  logger.warn(msg);
}

/** QC keeps `items` (checklist values): only clear `document_note` of items whose file is gone from disk. */
async function clearLostQcNotes(q, stats) {
  const s = stats.rm_qc_check;
  const lost = (s?.lost ?? []).filter((l) => l.item != null);
  if (!lost.length || !canRetireOldPaths(s, R.QC_CHECK)) return;
  logLost(s, R.QC_CHECK);
  const byRef = new Map();
  for (const l of lost) byRef.set(l.ref, [...(byRef.get(l.ref) ?? []), l.item]);
  const key = DOC_FILE_LINKS.rm_qc_check.key;
  for (const [ref, idx] of byRef) {
    const [row] = await q(`SELECT items FROM ${R.QC_CHECK} WHERE ${key}::text = $1`, [ref]);
    const items = list(row?.items);
    for (const i of idx) if (items[i]) items[i] = { ...items[i], document_note: null };
    await q(`UPDATE ${R.QC_CHECK} SET items = $1::jsonb WHERE ${key}::text = $2`, [JSON.stringify(items), ref]);
  }
}

async function dropLegacyPathColumns(q, stats) {
  await clearLostQcNotes(q, stats);
  for (const { modType, table, cols } of LEGACY_PATH_COLUMNS) {
    const s = stats[modType];
    const present = [];
    for (const col of cols) if (await hasColumns(q, table, [col])) present.push(col);
    if (!present.length || !canRetireOldPaths(s, table)) continue;
    logLost(s, table);
    // savepoint: a drop that fails (e.g. a view uses the column) must not undo the whole backfill
    await q("SAVEPOINT doc_drop");
    try {
      await q(`ALTER TABLE ${table} ${present.map((c) => `DROP COLUMN ${c}`).join(", ")}`);
      await q("RELEASE SAVEPOINT doc_drop");
      console.log(`✅ [v5.0.0] documents → ${table}: old column(s) dropped (${present.join(", ")})`);
    } catch (err) {
      await q("ROLLBACK TO SAVEPOINT doc_drop");
      console.warn(`[v5.0.0 documents] ${table}: old path columns kept — drop failed: ${err?.message || err}`);
    }
  }
}

export default async function backfillDocFiles() {
  await createDocumentsTable(); // table + file columns must exist (also when called manually)

  const stats = {};
  // oldFailed / lost = old path columns only (B) — decide whether those columns can be dropped (G)
  const stat = (m) => (stats[m] ??= { renamed: 0, shifted: 0, missing: 0, filled: 0, cleaned: 0, failed: 0, oldFailed: 0, oldSeen: 0, lost: [] });
  oldFiles = { retire: new Set(), keep: new Set() };

  await withTransaction(async (client) => {
    const q = clientQ(client);

    const docsLegacyId = await hasColumns(q, "documents", ["id"]);

    // 0. legacy `documents` table (BIGSERIAL id + uuid column) → uuid PK only
    if (docsLegacyId) {
      await q(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS uuid UUID`);
      if (await hasColumns(q, "documents", ["doc_name"])) await q(`ALTER TABLE documents ALTER COLUMN doc_name DROP NOT NULL`);
      await q(`ALTER TABLE documents ALTER COLUMN created_by DROP NOT NULL, ALTER COLUMN created_by DROP DEFAULT`);
      await q(`UPDATE documents SET created_by = NULL, created_by_name = 'system' WHERE created_by = 0 AND created_by_name IS NULL`);

      await q("SAVEPOINT uuid_type");
      try {
        await q(`ALTER TABLE documents ALTER COLUMN uuid TYPE VARCHAR(80) USING (
          CASE
            WHEN uuid::text ~ '\\.[a-z0-9]+$' THEN lower(uuid::text)
            WHEN doc_path ~ '/[0-9a-f-]{36}\\.[a-z0-9]+$' THEN lower(regexp_replace(doc_path, '^.+/', ''))
            ELSE lower(uuid::text || CASE WHEN COALESCE(NULLIF(trim(doc_type), ''), '') <> '' THEN '.' || trim(doc_type) ELSE '' END)
          END
        )`);
        await q("RELEASE SAVEPOINT uuid_type");
      } catch {
        await q("ROLLBACK TO SAVEPOINT uuid_type"); // already varchar
      }
      await q(`UPDATE documents SET doc_path = regexp_replace(doc_path, '([^/]+)$', '')
        WHERE doc_path ~ '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[a-z0-9]+$'`);
      await q(`UPDATE documents SET doc_path = doc_path || '/' WHERE doc_path LIKE 'uploads/%' AND doc_path NOT LIKE '%/'`);

      for (const d of await q(`SELECT id, doc_path, mod_type FROM documents WHERE uuid IS NULL ORDER BY id ASC`)) {
        const cur = normDocPath(d.doc_path);
        const laid = legacyToUuidPath(d.mod_type, cur, slotOf(cur));
        const copied = copyUploadFile(cur, laid.full);
        if (copied && cur !== laid.full) oldFiles.retire.add(cur);
        await q(`UPDATE documents SET uuid = $1, doc_type = $2, doc_path = $3 WHERE id = $4`, [
          laid.uuid,
          laid.doc_type,
          copied ? laid.doc_path : normFolderPath(path.posix.dirname(cur)),
          d.id,
        ]);
        stat(d.mod_type)[copied ? "renamed" : "missing"]++;
      }
      await q(`ALTER TABLE documents ALTER COLUMN uuid SET NOT NULL`);
    } else {
      await q(`UPDATE documents SET doc_path = doc_path || '/' WHERE doc_path LIKE 'uploads/%' AND doc_path NOT LIKE '%/'`);
    }

    // E + F. active rows → `<folder>/<uuid>.<ext>`; module columns = basename list
    for (const [modType, cfg] of Object.entries(DOC_FILE_LINKS)) {
      await rebuildModuleFileColumns(q, modType, cfg, stat);
    }

    for (const [modType, cfg] of Object.entries(DOC_FILE_LINKS)) {
      if (hasFileColumn(cfg)) await cleanModuleFileColumns(q, modType, cfg, stat); // D
      await backfillOldPaths(q, modType, cfg, stat); // B
    }

    await dropLegacyPathColumns(q, stats); // G
  });

  // Committed → old copies are no longer needed (copy + delete = rename). On rollback nothing is deleted.
  const removedOld = await removeOldFiles();
  if (removedOld) console.log(`✅ [v5.0.0] documents → ${removedOld} old file(s) removed (renamed to <uuid>.<ext>)`);

  // One line, only when something changed: "documents → 297 file(s) moved … (module moved/records: …)"
  const cleaned = Object.values(stats).reduce((n, s) => n + s.cleaned, 0);
  if (cleaned) console.log(`✅ [v5.0.0] documents → ${cleaned} record(s) cleaned (file names without a documents row removed)`);
  const failed = Object.entries(stats).filter(([, s]) => s.failed);
  if (failed.length) console.warn(`[v5.0.0] documents → failed files: ${failed.map(([m, s]) => `${m} ${s.failed}`).join(", ")} (see warnings above)`);
  const done = Object.entries(stats).filter(([, s]) => s.shifted + s.renamed + s.filled > 0);
  if (!done.length) return stats;
  const moved = done.reduce((n, [, s]) => n + s.shifted + s.renamed, 0);
  const records = done.reduce((n, [, s]) => n + s.filled, 0);
  const missing = Object.values(stats).reduce((n, s) => n + s.missing, 0);
  const perModule = done.map(([m, s]) => `${m} ${s.shifted + s.renamed}/${s.filled}`).join(", ");
  console.log(
    `✅ [v5.0.0] documents → ${moved} file(s) moved, ${records} record(s) updated (module files/records: ${perModule})${missing ? `, ${missing} missing on disk` : ""}`
  );
  return stats;
}
