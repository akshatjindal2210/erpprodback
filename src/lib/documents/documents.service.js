/**
 * Core flow — save / replace / remove / list.
 * Every write is ONE transaction: `documents` row + the module record's file column.
 * Rows and physical files are never deleted (old row → status = false).
 */
import fs from "fs";
import path from "path";
import { withTransaction } from "../../config/db/db.js";
import { DOC_FILE_LINKS, slotOf, folderOf, docFileName, fileDocPath } from "./documents.config.js";
import * as Model from "./documents.model.js";
import { withDocumentsTable } from "./documents.table.js";
import {
  lowerExt,
  uuidFileName,
  uuidFromFileName,
  normDocPath,
  normFolderPath,
  fullDocPublicPath,
  absUploadPath,
  copyUploadFile,
  publicPathOf,
  sizeKb,
  toModRef,
  uploaderOf,
  isUuidExtFile,
} from "./documents.utils.js";

const { clientQ } = Model;

/**
 * Store: `uuid` = `<uuid>.<ext>`, `doc_path` = module folder (`uploads/…/`).
 * File on disk: `<folder><uuid>.<ext>`.
 */
async function placeFile(q, docPath, modType) {
  const cur = normDocPath(docPath);
  if (!cur || !fs.existsSync(absUploadPath(cur))) return null;
  const folderBase = folderOf(modType, slotOf(cur)) ?? path.posix.dirname(cur);
  const ext = lowerExt(cur);
  let uid = uuidFromFileName(cur);
  let name = uid ? `${uid}${ext}`.toLowerCase() : uuidFileName(ext).toLowerCase();
  if (await Model.isUuidUsed(q, name)) name = uuidFileName(ext).toLowerCase();
  const full = normDocPath(fileDocPath(folderBase, name));
  if (full !== cur) copyUploadFile(cur, full);
  return { uuid: name, doc_path: normFolderPath(folderBase) };
}

/**
 * Insert one file (`{ docPath, file?, remark? }`) and add its name to the module record.
 * A path whose file is not on disk (old record) is skipped → null, so the rest of the save still works.
 */
async function insertFile(q, modType, modRef, entry, uploader) {
  const src = entry.docPath ?? publicPathOf(entry.file);
  const placed = await placeFile(q, src, modType);
  if (!placed) {
    console.warn(`[documents] ${modType}:${modRef} file not on disk, skipped — ${src}`);
    return null;
  }
  const { uuid, doc_path } = placed;
  const full = fullDocPublicPath({ uuid, doc_path });
  const doc = await Model.insertDocument(q, {
    uuid,
    doc_path,
    doc_type: lowerExt(uuid).slice(1, 11),
    doc_size: sizeKb(full, entry.file?.size),
    remark: entry.remark == null ? null : String(entry.remark).trim() || null,
    mod_type: modType,
    mod_ref: modRef,
    created_by: uploader.userId,
    created_by_name: uploader.userName,
  });
  await Model.addModuleFile(q, modType, modRef, docFileName(doc), slotOf(full));
  return { ...doc, doc_path: full };
}

/** Save files for a record → inserted rows. */
export async function saveDocuments(modType, modRef, entries = [], req = null) {
  const list = entries.filter((e) => e?.docPath || e?.file);
  if (!list.length) return [];
  const ref = toModRef(modRef);
  const uploader = uploaderOf(req);
  return withDocumentsTable(() => withTransaction(async (client) => {
    const q = clientQ(client);
    const out = [];
    for (const entry of list) {
      const doc = await insertFile(q, modType, ref, entry, uploader);
      if (doc) out.push(doc);
    }
    return out;
  }));
}

/** Replace file `priorUuid` with a new file → new row (old row deactivated if the new file is on disk). */
export async function replaceDocument(modType, modRef, priorUuid, entry, req = null) {
  const ref = toModRef(modRef);
  return withDocumentsTable(() => withTransaction(async (client) => {
    const q = clientQ(client);
    const doc = await insertFile(q, modType, ref, entry, uploaderOf(req));
    if (!doc) return null;
    const old = await Model.deactivateDocument(q, priorUuid);
    if (old) await Model.removeModuleFile(q, modType, ref, docFileName(old));
    return doc;
  }));
}

/** Remove file by `uuid.ext` (status = false) and take its name off the module record. */
export async function removeDocument(fileUuid) {
  return withDocumentsTable(() => withTransaction(async (client) => {
    const q = clientQ(client);
    const old = await Model.deactivateDocument(q, fileUuid);
    if (old) await Model.removeModuleFile(q, old.mod_type, old.mod_ref, docFileName(old));
    return Boolean(old);
  }));
}

export function updateDocumentRemark(fileUuid, remark) {
  return withDocumentsTable(() => Model.updateRemark(fileUuid, remark == null ? null : String(remark).trim() || null));
}

/**
 * Active files of many records → Map("ref" → rows with public `doc_path`).
 * Module table holds `<uuid>.<ext>` only; path = config folder + name (no SQL JOIN).
 * @param {{ metadata?: boolean }} opts — pass `metadata: true` to batch-load `documents` (remark, size, uploader).
 */
export function listActiveDocuments(modType, modRefs = [], opts = {}) {
  return withDocumentsTable(() => listActiveDocumentsNow(modType, modRefs, opts));
}

async function listActiveDocumentsNow(modType, modRefs, opts) {
  const metadata = opts.metadata === true;
  const refs = [...new Set(modRefs.map(toModRef).filter(Boolean))];
  const out = new Map(refs.map((r) => [r, []]));
  if (!refs.length) return out;

  if (DOC_FILE_LINKS[modType]) {
    const byRef = await Model.readModuleFiles(modType, refs);
    const fileNames = [...byRef.values()]
      .flat()
      .map((f) => String(f.name).trim().toLowerCase())
      .filter(isUuidExtFile);
    const byFile = metadata
      ? new Map((await Model.findByFileNames(fileNames)).map((d) => [String(d.uuid).toLowerCase(), d]))
      : new Map();
    for (const [ref, files] of byRef) {
      for (const { name, folder } of files) {
        const file = String(name).trim().toLowerCase();
        if (!isUuidExtFile(file)) continue;
        const full = normDocPath(fileDocPath(folder, file));
        const meta = byFile.get(file);
        if (meta) out.get(ref)?.push({ ...meta, doc_path: full });
        else if (!metadata)
          out.get(ref)?.push({
            uuid: file,
            doc_path: full,
            doc_type: lowerExt(file).slice(1, 11),
            remark: null,
            status: true,
          });
      }
    }
  }

  const empty = refs.filter((r) => !out.get(r).length);
  for (const d of await Model.findActiveByRefs(modType, empty)) {
    out.get(toModRef(d.mod_ref))?.push({ ...d, doc_path: fullDocPublicPath(d) });
  }
  return out;
}

/**
 * Public paths only — reads module `doc_files` / slot columns + folder; no `documents` table.
 * Use `listActiveDocuments(..., { metadata: true })` when you need remark, size, or uploader.
 */
export function listPathsFromModuleFiles(modType, modRefs = []) {
  return withDocumentsTable(() => listPathsNow(modType, modRefs));
}

async function listPathsNow(modType, modRefs) {
  const refs = [...new Set(modRefs.map(toModRef).filter(Boolean))];
  const out = new Map(refs.map((r) => [r, []]));
  if (!refs.length || !DOC_FILE_LINKS[modType]) return out;

  const byRef = await Model.readModuleFiles(modType, refs);
  for (const [ref, files] of byRef) {
    for (const { name, folder } of files) {
      const file = String(name).trim().toLowerCase();
      if (!isUuidExtFile(file)) continue;
      out.get(ref)?.push(normDocPath(fileDocPath(folder, file)));
    }
  }
  return out;
}
