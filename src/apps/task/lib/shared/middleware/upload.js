/**
 * Task create/update upload — folders + UUID names from shared DOC_FILE_LINKS.
 * Recurring create → `task_recurring_chat`; normal → `tasks`.
 * Fixed modules (chat send, self-note, CL, recurring update): use `docUpload(MODULE)`.
 */
import fs from "fs";
import multer from "multer";
import { DOC_FILE_LINKS, DEFAULT_MAX_MB, folderOf } from "../../../../../lib/documents/documents.config.js";
import { absUploadPath, lowerExt, multerUuidFilename } from "../../../../../lib/documents/documents.utils.js";

function isRecurringBody(body) {
  const v = body?.is_recurring;
  return v === true || v === 1 || v === "true" || v === "1";
}

function taskCreateModule(req) {
  return isRecurringBody(req.body) ? "task_recurring_chat" : "tasks";
}

export const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const mod = taskCreateModule(req);
      const folder = folderOf(mod, file.fieldname);
      if (!folder) return cb(new Error(`Invalid upload: unknown folder for ${mod}`));
      const dir = absUploadPath(folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: multerUuidFilename,
  }),
  fileFilter: (req, file, cb) => {
    const mod = taskCreateModule(req);
    const exts = DOC_FILE_LINKS[mod]?.exts || [];
    const ok = exts.includes(lowerExt(file.originalname).slice(1));
    cb(ok ? null : new Error(`Invalid file type: ${file.originalname}. Allowed: ${exts.join(", ").toUpperCase()}.`), ok);
  },
  limits: { fileSize: DEFAULT_MAX_MB * 1024 * 1024 },
});

// CSV / Excel (holidays etc.) — not part of documents module
const excelFilter = (_req, file, cb) => {
  const allowed = [
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
  ];
  if (
    allowed.includes(file.mimetype) ||
    file.originalname.endsWith(".csv") ||
    file.originalname.endsWith(".xlsx") ||
    file.originalname.endsWith(".xls")
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV or Excel files are allowed"), false);
  }
};

export const csvUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: excelFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});
