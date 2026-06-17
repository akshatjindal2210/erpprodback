import multer from "multer";
import path from "path";
import fs from "fs";
import config from "../../../../config/config.js";

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const allowedTypes = [
  "image/jpeg", "image/png", "image/jpg", "image/gif", "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Invalid file type"), false);
};

const clTaskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadPath, "task_cl_tasks", "attachments");
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

export const clTaskUpload = multer({
  storage: clTaskStorage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});
