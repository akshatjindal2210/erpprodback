/**
 * Helpers controllers / models call — built on the core service.
 *   moduleDocuments(MODULE)      bound API for one module
 *   path lists                   IPR (syncPathsFromList), Invoice Receiving (syncDocumentPaths)
 *   TC / RMTC slots              MRN, Stock Adjustment
 *   QC spec docs                 QC Check
 *   attachments                  Machine Master, Task chat
 *   register modules             Task self-note, recurring chat, CL form-fill (own JSON list + documents rows)
 */
import path from "path";
import { saveDocuments, replaceDocument, removeDocument, updateDocumentRemark, listActiveDocuments } from "./documents.service.js";
import { findActiveByUuid, findActiveByRefs, updateRegisterJson } from "./documents.model.js";
import { slotOf } from "./documents.config.js";
import { normDocPath, uploadDocName, uuidFromFileName, toModRef, fullDocPublicPath, isUuidExtFile } from "./documents.utils.js";
import { docFileName } from "./documents.config.js";
import { serializeReceivingFile } from "../../apps/ims/modules/invoice-receiving/utils/buildInvReceivingUploadFilter.js";

const cleanRemark = (v) => (v == null ? null : String(v).trim() || null);

/**
 * Soft-deactivate every active document for one module record (`documents.status = false`
 * + clear module file columns). Call **before** soft/hard deleting the parent row.
 * Also picks up orphan `documents` rows still active when the module column is already empty.
 * @returns {Promise<number>} rows deactivated
 */
export async function deactivateModuleDocuments(MODULE, ref) {
  const key = toModRef(ref);
  if (!MODULE || !key) {
    if (ref != null && String(ref).trim() !== "") {
      console.warn(`[documents] ${MODULE}: skip deactivate — empty mod_ref`);
    }
    return 0;
  }

  const fromModule = (await listActiveDocuments(MODULE, [key])).get(key) ?? [];
  const seen = new Set(fromModule.map((d) => String(d.uuid).toLowerCase()));
  const orphans = (await findActiveByRefs(MODULE, [key])).filter(
    (d) => !seen.has(String(d.uuid).toLowerCase())
  );
  const all = [...fromModule, ...orphans];
  let n = 0;
  for (const d of all) {
    try {
      const ok = await removeDocument(d.uuid);
      if (ok) n += 1;
      else console.warn(`[documents] ${MODULE}:${key} deactivate skipped (already inactive) — ${d.uuid}`);
    } catch (err) {
      console.error(`[documents] ${MODULE}:${key} deactivate failed — ${d.uuid}: ${err?.message || err}`);
      throw err;
    }
  }
  return n;
}

/** Bound API for one module (`MODULE` = documents.mod_type). */
export function moduleDocuments(MODULE) {
  const listActive = async (ref, opts) => (await listActiveDocuments(MODULE, [ref], opts)).get(toModRef(ref)) ?? [];
  return {
    mod_type: MODULE,
    saveFiles: (ref, entries, req) => saveDocuments(MODULE, ref, entries, req),
    replaceFile: (fileUuid, ref, entry, req) => replaceDocument(MODULE, ref, fileUuid, entry, req),
    removeFile: removeDocument,
    listActive,
    listActiveMany: (refs, opts) => listActiveDocuments(MODULE, refs, opts),
    removeAllActive: (ref) => deactivateModuleDocuments(MODULE, ref),
  };
}

function docApiPath(r) {
  const full = r.doc_path?.includes("/") && isUuidExtFile(r.doc_path) ? r.doc_path : fullDocPublicPath(r);
  return normDocPath(full);
}

/** Path list modules (IPR, etc.) — display path only; remark when present in `documents`. */
const publicRow = (r) => {
  const out = { path: docApiPath(r) };
  if (r.remark != null && String(r.remark).trim() !== "") out.remark = String(r.remark).trim();
  return out;
};

/** Invoice Receiving drawer — path + per-file remark (only module that shows file remarks). */
export function receivingDocRow(r) {
  return { path: docApiPath(r), remark: r.remark ?? null };
}

// ── Path lists (IPR, Invoice Receiving) ─────────────────────────────────────

/**
 * Make the record's files equal `paths` (in order): missing ones removed, new ones saved.
 * `remarks[i]` belongs to `paths[i]`; `undefined` keeps the saved remark (Invoice Receiving only).
 */
export async function syncPathsFromList(MODULE, ref, paths = [], req, remarks = []) {
  const doc = moduleDocuments(MODULE);
  const want = paths.map(normDocPath).filter(Boolean);
  const active = await doc.listActive(ref);
  for (const d of active) if (!want.includes(normDocPath(d.doc_path))) await doc.removeFile(d.uuid);

  const byPath = new Map(active.map((d) => [normDocPath(d.doc_path), d]));
  const toAdd = [];
  for (const [i, docPath] of want.entries()) {
    const remark = remarks[i] === undefined ? undefined : cleanRemark(remarks[i]);
    const existing = byPath.get(docPath);
    if (!existing) toAdd.push({ docPath, remark: remark ?? null });
    else if (remark !== undefined && (existing.remark ?? null) !== remark) await updateDocumentRemark(existing.uuid, remark);
  }
  if (toAdd.length) await doc.saveFiles(ref, toAdd, req);
}

/** Invoice Receiving: keep `keepPaths` (saved remarks kept) + add `newFiles` (`{ docPath, remark }`). */
export function syncDocumentPaths(doc, { modRef, userOrId, keepPaths = [], newFiles = [] }) {
  const kept = keepPaths.map(normDocPath).filter(Boolean);
  const added = newFiles.filter((f) => f?.docPath);
  return syncPathsFromList(
    doc.mod_type,
    modRef,
    [...kept, ...added.map((f) => f.docPath)],
    userOrId,
    [...kept.map(() => undefined), ...added.map((f) => cleanRemark(f.remark))]
  );
}

/** Adds `attachments` (paths) + `attachment_documents` to an IPR row. */
export async function attachPathListRow(MODULE, row, ref) {
  if (!row || ref == null) return row;
  const rows = await moduleDocuments(MODULE).listActive(ref, { metadata: true });
  if (!rows.length) return row;
  return { ...row, attachments: rows.map((r) => r.doc_path), attachment_documents: rows.map(publicRow) };
}

/** Batch version — one module read + one uuid metadata query for the whole list (no per-row fetch). */
export async function attachPathListRows(MODULE, rows = [], key) {
  if (!rows?.length) return rows;
  const byRef = await moduleDocuments(MODULE).listActiveMany(rows.map((r) => r[key]), { metadata: true });
  return rows.map((r) => {
    const ref = toModRef(r[key]);
    const docs = byRef.get(ref) ?? [];
    if (!docs.length) return r;
    return {
      ...r,
      attachments: docs.map((d) => d.doc_path),
      attachment_documents: docs.map(publicRow),
    };
  });
}

export const receivingFileFromRows = (rows, fallback = null) => (rows?.length ? serializeReceivingFile(rows.map((r) => r.doc_path)) : fallback);
export const receivingDocumentsFromRows = (rows) => (rows || []).map(receivingDocRow);

// ── TC / RMTC slots (MRN, Stock Adjustment) ─────────────────────────────────

/** Adds API paths + optional metadata. Paths from `tc_file`/`rmtc_file` + folder; default loads remark/id from `documents`. */
export async function attachTcRmtcRow(MODULE, row, ref, opts = { metadata: true }) {
  if (!row || ref == null || ref === "") return row;
  const docs = await moduleDocuments(MODULE).listActive(ref, opts);
  return withTcRmtc(row, docs);
}

/** Batch attach TC/RMTC. `key` = row id field. Set `metadata: false` when remark/uploader not needed. */
export async function attachTcRmtcRows(MODULE, rows = [], key, opts = { metadata: true }) {
  if (!rows.length) return rows;
  const byRef = await moduleDocuments(MODULE).listActiveMany(
    rows.map((r) => r[key]),
    opts
  );
  return rows.map((r) => withTcRmtc(r, byRef.get(toModRef(r[key])) ?? []));
}

function withTcRmtc(row, docs) {
  const tc = docs.findLast((d) => slotOf(d.doc_path) === "tc");
  const rmtc = docs.findLast((d) => slotOf(d.doc_path) === "rmtc");
  return {
    ...row,
    tc_file: tc?.uuid ?? row.tc_file ?? null,
    rmtc_file: rmtc?.uuid ?? row.rmtc_file ?? null,
    tc_file_path: tc?.doc_path ?? null,
    rmtc_file_path: rmtc?.doc_path ?? null,
    tc_remark: tc?.remark ?? null,
    rmtc_remark: rmtc?.remark ?? null,
    tc_document_id: tc?.uuid ?? null,
    rmtc_document_id: rmtc?.uuid ?? null,
    tc_uploaded_by: tc?.created_by ?? null,
    tc_uploaded_by_name: tc?.created_by_name ?? null,
    rmtc_uploaded_by: rmtc?.created_by ?? null,
    rmtc_uploaded_by_name: rmtc?.created_by_name ?? null,
  };
}

/** Save / replace the slot's file, or only update its remark when no file is sent (`remark` undefined = keep). */
export async function upsertTcRmtcSlot(MODULE, { modRef, slot, file, docPath, remark, userOrId }) {
  const doc = moduleDocuments(MODULE);
  const existing = (await doc.listActive(modRef)).findLast((d) => slotOf(d.doc_path) === slot);
  if (!file && !docPath) {
    const want = cleanRemark(remark);
    if (existing && remark !== undefined && (existing.remark ?? null) !== want) await updateDocumentRemark(existing.uuid, want);
    return existing ?? null;
  }
  const entry = { file, docPath, remark };
  if (existing) return doc.replaceFile(existing.uuid, modRef, entry, userOrId);
  const [row] = await doc.saveFiles(modRef, [entry], userOrId);
  return row;
}

// ── QC spec documents ───────────────────────────────────────────────────────

/** Fills `document_id` (`<uuid>.<ext>`), path and remark on QC items from their documents. */
export async function enrichQcItemsWithDocuments(MODULE, qcCheckUid, items = []) {
  const rows = await moduleDocuments(MODULE).listActive(qcCheckUid, { metadata: true });
  if (!rows.length) return items;
  const byUuid = new Map(rows.map((r) => [String(r.uuid).toLowerCase(), r]));
  const byPath = new Map(rows.map((r) => [normDocPath(r.doc_path), r]));
  const used = new Set();
  const fill = (it, d) => ({
    ...it,
    document_id: d.uuid,
    document_note: d.doc_path,
    document_remark: d.remark ?? null,
  });

  const enriched = (items || []).map((it) => {
    const key = it.document_id != null ? String(it.document_id).trim().toLowerCase() : "";
    const d = (key && byUuid.get(key)) ?? (it.document_note ? byPath.get(normDocPath(it.document_note)) : null);
    if (!d) return { ...it, document_note: it.document_note ?? "", document_remark: null };
    used.add(String(d.uuid).toLowerCase());
    return fill(it, d);
  });
  const spare = rows.filter((r) => !used.has(String(r.uuid).toLowerCase()));
  return enriched.map((it) => (!it.document_id && it.document_required && spare.length ? fill(it, spare.shift()) : it));
}

/** Save the spec's document → returns `uuid.ext`. Same file again → remark update only. */
export async function persistQcSpecDocument(MODULE, { modRef, docPath, remark, userOrId, priorDocumentId }) {
  if (!docPath) return priorDocumentId ?? null;
  const priorUuid = priorDocumentId != null ? String(priorDocumentId).trim().toLowerCase() : "";
  const doc = moduleDocuments(MODULE);
  if (priorUuid) {
    const prior = await findActiveByUuid(priorUuid);
    if (prior && String(prior.uuid).toLowerCase() === path.basename(normDocPath(docPath)).toLowerCase()) {
      const want = cleanRemark(remark);
      if ((prior.remark ?? null) !== want) await updateDocumentRemark(prior.uuid, want);
      return prior.uuid;
    }
    const row = await doc.replaceFile(priorUuid, modRef, { docPath, remark }, userOrId);
    return row?.uuid ?? priorUuid;
  }
  const [row] = await doc.saveFiles(modRef, [{ docPath, remark }], userOrId);
  return row?.uuid ?? null;
}

// ── Attachments (Machine Master, Task chat) ─────────────────────────────────

/** Make the record's files equal `attachments` (`[{ path, remark?, size? }]`). */
export async function syncAttachmentList(MODULE, ref, attachments = [], req) {
  const doc = moduleDocuments(MODULE);
  const list = attachments.filter((a) => a?.path);
  const want = new Set(list.map((a) => normDocPath(a.path)));
  const active = await doc.listActive(ref);
  for (const d of active) if (!want.has(normDocPath(d.doc_path))) await doc.removeFile(d.uuid);
  const have = new Set(active.map((d) => normDocPath(d.doc_path)));
  const toAdd = list.filter((a) => !have.has(normDocPath(a.path)));
  return doc.saveFiles(ref, toAdd.map((a) => ({ docPath: a.path, remark: a.remark ?? null, file: { size: a.size ?? null } })), req);
}

/** Record's files in the shape the screen expects (`machine` or `task`); `fallback` when there are none. */
export async function attachmentsFromDocuments(MODULE, ref, fallback = [], shape = "machine", opts = { metadata: true }) {
  const rows = await moduleDocuments(MODULE).listActive(ref, opts);
  if (!rows.length) return fallback;
  return rows.map((r) => {
    const base = { file_name: uploadDocName(r.doc_path), remark: r.remark ?? null, by: r.created_by_name ?? null };
    const bytes = (Number(r.doc_size) || 0) * 1024;
    return shape === "task"
      ? { ...base, file_path: r.doc_path, file_size: bytes, document_id: r.uuid }
      : { id: String(r.uuid), uuid: r.uuid, ...base, path: r.doc_path, size: bytes };
  });
}

// ── Register modules (Task self-note, recurring chat, CL task) ──────────────

/**
 * Make the record's documents equal its JSON list (`[{ file_path, remark?, file_size? }]`): removed → status = false,
 * new → documents row. A file saved under a new `<uuid>.<ext>` name (old name / name already used) gets its new
 * path written back to the module JSON. Never throws — the module JSON stays the source for the screen.
 * @returns the list with final paths
 */
export async function syncRegisteredFiles(MODULE, ref, files = [], req = null) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f?.file_path);
  if (ref == null || ref === "") return list;
  try {
    const doc = moduleDocuments(MODULE);
    const active = await doc.listActive(ref);
    const want = new Set(list.map((f) => normDocPath(f.file_path)));
    for (const d of active) if (!want.has(normDocPath(d.doc_path))) await doc.removeFile(d.uuid);

    const byPath = new Map(active.map((d) => [normDocPath(d.doc_path), d]));
    let moved = false;
    const out = [];
    for (const f of list) {
      const p = normDocPath(f.file_path);
      const existing = byPath.get(p);
      if (existing) {
        if (f.remark !== undefined && (existing.remark ?? null) !== cleanRemark(f.remark)) await updateDocumentRemark(existing.uuid, cleanRemark(f.remark));
        out.push(f);
        continue;
      }
      const size = f.file_size ?? f.size ?? null;
      const [row] = await doc.saveFiles(ref, [{ docPath: p, remark: cleanRemark(f.remark), file: { size } }], req);
      if (row && normDocPath(row.doc_path) !== p) {
        moved = true;
        out.push({ ...f, file_path: row.doc_path });
      } else out.push(f);
    }
    if (moved) await updateRegisterJson(MODULE, ref, out);
    return out;
  } catch (err) {
    console.warn(`[documents] ${MODULE}:${ref} sync failed — ${err?.message || err}`);
    return list;
  }
}

/**
 * Add new uploads of a `register` record (no removal tracking, e.g. CL form fills). Never throws.
 * @returns {Promise<Array<{ from: string, to: string, uuid: string|null }>>} path map for rewriting form JSON
 */
export async function registerUploadedFiles(MODULE, ref, files = [], req = null) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f?.file_path);
  if (ref == null || ref === "" || !list.length) return [];
  try {
    const mapped = [];
    for (const f of list) {
      const rows = await saveDocuments(
        MODULE,
        ref,
        [{ docPath: f.file_path, remark: cleanRemark(f.remark), file: { size: f.file_size ?? f.size ?? null } }],
        req
      );
      const row = rows[0] ?? null;
      mapped.push({
        from: f.file_path,
        to: row?.doc_path || f.file_path,
        uuid: row?.uuid ?? null,
      });
      if (!row) {
        console.warn(`[documents] ${MODULE}:${ref} register skipped (file not on disk) — ${f.file_path}`);
      }
    }
    return mapped;
  } catch (err) {
    console.warn(`[documents] ${MODULE}:${ref} register failed — ${err?.message || err}`);
    return [];
  }
}
