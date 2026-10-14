import path from "path";
import config from "../../../../config/app/config.js";

/*
 * RM Store document uploads (MRN / Stock Adjustment TC+RMTC, QC, IPR) use the global
 * `docUpload(MODULE)` from `lib/documents` (see its README) — folders and file types live in `DOC_FILE_LINKS`.
 */

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
