/** Small helpers: uuid file names, upload paths on disk, request (uploader / remarks). */
import path from "path";
import fs from "fs";
import { v7 as uuidv7 } from "uuid";
import config from "../../config/app/config.js";

// ── File names: `<uuidv7>.<ext>` ─────────────────────────────────────────────

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]+)?$/i;

/** Lowercase `.ext` (with dot, `""` when none). */
export const lowerExt = (name) => path.extname(String(name ?? "")).toLowerCase();

/** New `<uuidv7><ext>` — `ext` with dot. */
export const uuidFileName = (ext = "") => `${uuidv7()}${String(ext).toLowerCase()}`;

/** Multer `filename` callback → `<uuidv7>.<ext of original name>`. */
export function multerUuidFilename(_req, file, cb) {
  cb(null, uuidFileName(lowerExt(file?.originalname)));
}

/** `…/<uuid>.<ext>` → uuid, else null. */
export function uuidFromFileName(name) {
  const m = path.basename(String(name ?? "").replace(/\\/g, "/")).match(UUID_FILE_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Module / documents `uuid` value: lowercase `<uuid>.<ext>`. */
export function isUuidExtFile(name) {
  return UUID_FILE_RE.test(path.basename(String(name ?? "").replace(/\\/g, "/")));
}

export const normDocPath = (p) => String(p ?? "").trim().replace(/\\/g, "/");

/** Folder only in DB — trailing `/` (e.g. `uploads/rmstore/tc/`). */
export function normFolderPath(p) {
  let s = normDocPath(p);
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

/** Full public path for disk/API from stored `{ doc_path: folder/, uuid: file.ext }`. */
export function fullDocPublicPath(row) {
  const u = String(row?.uuid ?? "").trim().replace(/\\/g, "/").toLowerCase();
  const dp = normDocPath(row?.doc_path ?? "");
  if (u.startsWith("uploads/")) return u;
  if (isUuidExtFile(u)) {
    const folder = normFolderPath(dp);
    if (folder) return normDocPath(`${folder}${path.basename(u)}`);
  }
  if (isUuidExtFile(path.basename(dp))) return dp;
  return dp;
}

// ── Paths: public `uploads/…` ↔ disk ─────────────────────────────────────────

/** Display name = last part of the path. */
export function uploadDocName(p) {
  let s = String(p ?? "").trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as-is */
  }
  return path.basename(s.replace(/\\/g, "/")) || "file";
}

/** Public `uploads/…` path → absolute path on disk. */
export function absUploadPath(docPath) {
  const rel = normDocPath(docPath).replace(/^\/+/, "").replace(/^uploads\//, "");
  return path.join(config.uploadPath, rel);
}

/** Multer file → public `uploads/…` path. */
export function publicPathOf(file) {
  if (!file?.path) return null;
  const rel = path.relative(path.resolve(config.uploadPath), file.path);
  return rel && !rel.startsWith("..") ? path.posix.join(config.uploadPublicPath, normDocPath(rel)) : null;
}

/** Copy a stored file (old file stays). false if the source is missing. */
export function copyUploadFile(fromPath, toPath) {
  const src = absUploadPath(fromPath);
  if (!fs.existsSync(src)) return false;
  const dest = absUploadPath(toPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/** File size in KB (rounded up), from the multer size or the file on disk. */
export function sizeKb(docPath, bytes = null) {
  let b = Number(bytes);
  if (!Number.isFinite(b) || bytes == null) {
    try {
      b = fs.statSync(absUploadPath(docPath)).size;
    } catch {
      b = 0;
    }
  }
  return b > 0 ? Math.ceil(b / 1024) : 0;
}

// ── Request: uploader, record id, per-file remarks ───────────────────────────

/** Record id as stored text (`documents.mod_ref`). */
export const toModRef = (ref) => (ref == null ? null : String(ref).trim() || null);

const clean = (v) => (v == null ? null : String(v).trim() || null);

/** Uploader from `req` (or `{ userId, userName }`). */
export const uploaderOf = (req) => ({
  userId: Number(req?.user?.id ?? req?.userId) || null,
  userName: clean(req?.user?.name ?? req?.user?.username ?? req?.userName),
});

/** Remark for file `index` from `file_remarks` / `doc_remarks` (JSON array / object / single string). */
export function parseFileRemarks(body, index = 0) {
  let raw = body?.file_remarks ?? body?.fileRemarks ?? body?.doc_remarks ?? body?.docRemarks;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [raw];
    }
  }
  if (Array.isArray(raw)) return clean(raw[index]);
  if (raw && typeof raw === "object") return clean(raw[String(index)] ?? raw[index]);
  return null;
}

/** TC/RMTC remark field (`tc_remark` / `rmtc_remark`), else from `file_remarks`. `undefined` = not sent. */
export function slotRemarkFromBody(body, field, fileIndex = 0) {
  if (body?.[field] != null) return clean(body[field]);
  return parseFileRemarks(body, fileIndex) ?? undefined;
}

/** Multer files → `[{ file, docPath, remark }]` for `saveFiles`. Per-file `remark` is used on Invoice Receiving only. */
export function mapMulterFilesWithRemarks(req, toPublicPath = publicPathOf) {
  const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
  return files
    .map((file, i) => ({ file, docPath: toPublicPath(file, i), remark: parseFileRemarks(req.body, i) }))
    .filter((f) => f.docPath);
}
