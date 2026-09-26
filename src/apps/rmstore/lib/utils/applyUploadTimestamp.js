import fs from "fs";
import path from "path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export const UPLOAD_TIMESTAMP_TYPES = Object.freeze({
  IMAGE: "image",
  PDF: "pdf",
});

function isImageUpload(file) {
  const name = String(file?.originalname || file?.path || "").toLowerCase();
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function formatUploadTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("day")}-${pick("month")}-${pick("year")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function buildStampLabel(uploadedByName, date = new Date()) {
  const ts = formatUploadTimestamp(date);
  const name = String(uploadedByName || "").trim();
  return name ? `${name} · ${ts}` : ts;
}

export async function applyTimestamp(file, type = UPLOAD_TIMESTAMP_TYPES.IMAGE, uploadedByName = "") {
  if (!file?.path || !fs.existsSync(file.path)) return file;
  if (type !== UPLOAD_TIMESTAMP_TYPES.IMAGE) return file;
  if (!isImageUpload(file)) return file;

  const label = buildStampLabel(uploadedByName);
  const img = await loadImage(file.path);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  
  // 1. Image draw karein
  ctx.drawImage(img, 0, 0);

  // 2. Font & Text size settings (Fallback font ke sath)
  const fontSize = Math.max(14, Math.floor(Math.min(img.width, img.height) / 32));
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;

  const textWidth = ctx.measureText(label).width;
  const padX = Math.max(6, Math.floor(fontSize * 0.35));
  const padY = Math.max(4, Math.floor(fontSize * 0.25));
  
  const barH = fontSize + padY * 2;
  const barW = Math.min(img.width, textWidth + padX * 2);

  // 3. Right align positions
  const rectX = img.width - barW;
  const textX = rectX + padX;

  // Bottom-Left align positions
  /*
  const rectX = 0;
  const textX = padX;
  */

  // 4. Background Box (Bottom-Right)
  ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
  ctx.fillRect(rectX, img.height - barH, barW, barH);

  // 5. White Text (Bottom-Right)
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, textX, img.height - padY);

  // 6. Overwrite File on Disk
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  let buffer;
  if (ext === ".png") buffer = canvas.encodeSync("png");
  else if (ext === ".webp") buffer = canvas.encodeSync("webp");
  else buffer = canvas.encodeSync("jpeg", 92);

  fs.writeFileSync(file.path, buffer);
  return file;
}

export async function applyTimestampToMulterFiles(files = {}) {
  const list = [files?.tc?.[0], files?.rmtc?.[0]].filter(Boolean);
  for (const file of list) {
    await applyTimestamp(file, UPLOAD_TIMESTAMP_TYPES.IMAGE);
  }
}