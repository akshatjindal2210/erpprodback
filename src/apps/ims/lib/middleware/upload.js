import multer from "multer";
import path from "path";
import fs from "fs";
import config from "../../../../config/app/config.js";

// Helper to create folder if it doesn't exist
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Allowed file types
const allowedTypes = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// File filter
const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Invalid file type"), false);
};

// ── Chat upload ──
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadPath, "tasks/chat");
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

export const chatUpload = multer({
  storage: chatStorage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ── Self-note upload ──
const selfStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadPath, "tasks/self");
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

export const selfUpload = multer({
  storage: selfStorage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const excelFilter = (req, file, cb) => {
  // Allow CSV and Excel mimetypes
  const allowedTypes = [
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel" // .xls
  ];

  if (allowedTypes.includes(file.mimetype) || 
      file.originalname.endsWith(".csv") || 
      file.originalname.endsWith(".xlsx") || 
      file.originalname.endsWith(".xls")) {
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

/** Public path under `uploads/…` (same idea as RM `toRmPublicUploadPath`). */
export function toPublicUploadPath(file, fallbackParts = []) {
  if (!file) return null;
  if (file.path) {
    const relativePath = path.relative(path.resolve(config.uploadPath), file.path);
    if (relativePath && !relativePath.startsWith("..")) {
      return path.join(config.uploadPublicPath, relativePath).replace(/\\/g, "/");
    }
  }
  if (file.filename && fallbackParts.length) {
    return path.join(config.uploadPublicPath, ...fallbackParts, file.filename).replace(/\\/g, "/");
  }
  return null;
}

/** Invoice Receiving — `uploads/ims/invoice-receiving` */
const IMS_IR_ROOT = path.join(config.uploadPath, "ims", "invoice-receiving");
export const invoiceReceivingUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(IMS_IR_ROOT);
      cb(null, IMS_IR_ROOT);
    },
    filename: (_req, file, cb) => {
      const orig = String(file.originalname || "attachment");
      let ext = path.extname(orig).toLowerCase();
      if (!/^\.(pdf|png|jpe?g|webp|gif)$/.test(ext)) ext = ".bin";
      const hint = path.basename(orig, path.extname(orig)).replace(/[^\w]/g, "").slice(0, 8).toLowerCase();
      const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
      cb(null, hint ? `${uniq}_${hint}${ext}` : `${uniq}${ext}`);
    },
  }),
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

export const toImsIrPublicUploadPath = (file) => toPublicUploadPath(file, ["ims", "invoice-receiving"]);
