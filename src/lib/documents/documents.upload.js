/**
 * Multer for document modules — folder, allowed types, size and `<uuidv7>.<ext>` name come from DOC_FILE_LINKS.
 *   router.post("/create", ..., docUpload(MODULE).array("attachments", 20), create);
 *   router.post("/upload-docs", ..., docUpload(MODULE).fields([{ name: "tc" }, { name: "rmtc" }]), upload);
 * Errors ("Invalid file type …", "File is too large …") are shown by the global error handler in `src/index.js`.
 */
import fs from "fs";
import multer from "multer";
import { DOC_FILE_LINKS, DEFAULT_MAX_MB, folderOf } from "./documents.config.js";
import { absUploadPath, lowerExt, multerUuidFilename } from "./documents.utils.js";

const uploaders = new Map();

export function docUpload(MODULE) {
  if (uploaders.has(MODULE)) return uploaders.get(MODULE);
  const cfg = DOC_FILE_LINKS[MODULE];
  if (!cfg) throw new Error(`docUpload: "${MODULE}" is not in DOC_FILE_LINKS`);
  const maxMb = cfg.maxMb || DEFAULT_MAX_MB;

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, file, cb) => {
        const folder = folderOf(MODULE, file.fieldname);
        if (!folder) return cb(new Error(`Invalid file type: unknown upload field "${file.fieldname}".`));
        const dir = absUploadPath(folder);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: multerUuidFilename,
    }),
    fileFilter: (_req, file, cb) => {
      const ok = cfg.exts.includes(lowerExt(file.originalname).slice(1));
      cb(ok ? null : new Error(`Invalid file type: ${file.originalname}. Allowed: ${cfg.exts.join(", ").toUpperCase()}.`), ok);
    },
    limits: { fileSize: maxMb * 1024 * 1024 },
  });

  // Size errors carry this module's limit, so the message shows the right MB.
  const withSizeMessage = (mw) => (req, res, next) =>
    mw(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") {
        err.limitMb = maxMb;
        err.message = `File is too large. Each file must be ${maxMb} MB or less — please choose a smaller file.`;
      }
      next(err);
    });

  const uploader = {
    single: (...a) => withSizeMessage(upload.single(...a)),
    array: (...a) => withSizeMessage(upload.array(...a)),
    fields: (...a) => withSizeMessage(upload.fields(...a)),
    any: () => withSizeMessage(upload.any()),
  };
  uploaders.set(MODULE, uploader);
  return uploader;
}
