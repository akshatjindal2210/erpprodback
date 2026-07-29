import multer from "multer";
import path from "path";
import fs from "fs";
import config from "../../../../config/app/config.js";

/** Same base as Task uploads — `UPLOAD_PATH` from .env via `config.uploadPath`. */
const RM_UPLOAD_ROOT = path.join(config.uploadPath, "rmstore");

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const fileFilter = (_req, file, cb) => {
  const ok = /\.(pdf|png|jpe?g|webp)$/i.test(file.originalname || "");
  cb(ok ? null : new Error("Only PDF or image files allowed"), ok);
};

function makeFilename(fallbackName) {
  return (_req, file, cb) => {
    const safe = String(file.originalname || fallbackName).replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  };
}

/** Public URL path stored in DB, e.g. `uploads/rmstore/tc/…`. */
export function toRmPublicUploadPath(file, fallbackSubdir = "") {
  if (!file) return null;
  if (file.path) {
    const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
    if (relativePath && !relativePath.startsWith("..")) {
      return path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/");
    }
  }
  if (file.filename && fallbackSubdir) {
    return path
      .join(config.uploadPublicPath, "rmstore", fallbackSubdir, file.filename)
      .replace(/\\/g, "/");
  }
  return null;
}

/** MRN TC + RMTC — folders: `{UPLOAD_PATH}/uploads/rmstore/tc` and `…/rmtc`. */
const mrnDocsStorage = multer.diskStorage({
  destination: (_req, file, cb) => {
    const sub = String(file.fieldname || "").toLowerCase() === "rmtc" ? "rmtc" : "tc";
    const dir = path.join(RM_UPLOAD_ROOT, sub);
    ensureDir(dir);
    cb(null, dir);
  },
  filename: makeFilename("doc"),
});

export const rmTcUpload = multer({
  storage: mrnDocsStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter,
});

/** Per-spec QC docs — `{UPLOAD_PATH}/uploads/rmstore/qc`. */
const qcDocStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(RM_UPLOAD_ROOT, "qc");
    ensureDir(dir);
    cb(null, dir);
  },
  filename: makeFilename("qc"),
});

export const rmQcDocUpload = multer({
  storage: qcDocStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter,
});
