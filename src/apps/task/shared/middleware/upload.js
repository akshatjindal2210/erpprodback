import multer from "multer";
import path from "path";
import fs from "fs";
import config from "../../../../config/config.js";

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

// ── Chat upload ── (dynamic folder for recurring task_tasks)
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Check if task is recurring
    const isRecurring = req.body.is_recurring === true || req.body.is_recurring === "true" || req.body.is_recurring === 1;
    const dir = isRecurring 
      ? path.join(config.uploadPath, "task_recurring_tasks/chat") 
      : path.join(config.uploadPath, "task_tasks/chat");
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
    const dir = path.join(config.uploadPath, "task_tasks/self");
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

// ── CSV / Excel upload ──
const excelFilter = (req, file, cb) => {
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