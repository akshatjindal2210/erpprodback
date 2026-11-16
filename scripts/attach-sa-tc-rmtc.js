/**
 * RM Stock Adjustment — attach TC / RMTC from Excel (+ optional Google Drive).
 * Same document flow as POST /api/rmstore/stock-adjustment/upload-docs.
 *
 * Excel (row 1 = headers). Supported column names (case-insensitive):
 *   adjustment_id | stock_adjustment_id | id | sa_id
 *   tc | tc_name | tc_file
 *   rm | rmtc | rm_name | rmtc_file
 *   tc_url | tc_drive | tc_link
 *   rm_url | rmtc_url | rm_drive | rmtc_link
 *   drive_url | google_drive | url | link   (used when only one file slot has a name)
 *
 * Env / CLI (override defaults):
 *   SA_ATTACH_EXCEL   path to .xlsx
 *   SA_ATTACH_TEMP    download + local file folder (default: scripts/sa-docs-temp)
 *   --step=all|download|upload   (default: all)
 *
 * Usage (from backend/):
 *   node scripts/attach-sa-tc-rmtc.js
 *   node scripts/attach-sa-tc-rmtc.js --step=download
 *   node scripts/attach-sa-tc-rmtc.js --step=upload
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { readSheet } from "read-excel-file/node";
import { folderOf } from "../src/lib/documents/documents.config.js";
import { absUploadPath, lowerExt, uuidFileName } from "../src/lib/documents/documents.utils.js";
import { upsertTcRmtcSlot } from "../src/lib/documents/index.js";
import { toRmPublicUploadPath } from "../src/apps/rmstore/lib/middleware/upload.js";
import { updateAdjustment } from "../src/apps/rmstore/modules/stock-adjustment/models/stockAdjustment.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = "rm_stock_adjustment";

const EXCEL = process.env.SA_ATTACH_EXCEL || "D:/sa-docs/map.xlsx";
const TEMP_DIR = process.env.SA_ATTACH_TEMP || path.join(__dirname, "sa-docs-temp");

const STEP = (() => {
  const arg = process.argv.find((a) => a.startsWith("--step="));
  const v = arg ? arg.slice("--step=".length).toLowerCase() : "all";
  return ["download", "upload", "all"].includes(v) ? v : "all";
})();

let ok = 0;
let fail = 0;
let skip = 0;

function cell(row, index) {
  if (index == null || index < 0) return "";
  return String(row[index] ?? "").trim();
}

function normalizeHeader(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function indexHeaders(headerRow) {
  const idx = {};
  (headerRow || []).forEach((cell, i) => {
    const k = normalizeHeader(cell);
    if (k) idx[k] = i;
  });
  const pick = (...names) => {
    for (const n of names) {
      if (idx[n] != null) return idx[n];
    }
    return -1;
  };
  return {
    id: pick("adjustment_id", "stock_adjustment_id", "stock_adjustment", "id", "sa_id"),
    tc: pick("tc", "tc_name", "tc_file", "tc_filename"),
    rm: pick("rm", "rmtc", "rm_name", "rmtc_name", "rm_file", "rmtc_file", "rmtc_filename"),
    tcUrl: pick("tc_url", "tc_drive", "tc_google_drive", "tc_link", "tc_drive_url"),
    rmUrl: pick("rm_url", "rmtc_url", "rm_drive", "rm_google_drive", "rm_link", "rmtc_link"),
    url: pick("drive_url", "google_drive", "google_drive_url", "url", "link"),
  };
}

function looksLikeHeader(row) {
  const a = normalizeHeader(row?.[0]);
  return /adjustment|stock|^id$|sa_id/.test(a);
}

function sanitizeFileName(name) {
  const base = path.basename(String(name ?? "").trim());
  if (!base || base === "." || base === "..") return "";
  return base.replace(/[<>:"|?*\u0000-\u001f]/g, "_");
}

function extractGoogleDriveFileId(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  let m = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  m = /[?&]id=([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) throw new Error("Google Drive folder links are not supported — use a direct file link");
  return null;
}

async function downloadGoogleDrive(url, destPath) {
  const fileId = extractGoogleDriveFileId(url);
  if (!fileId) throw new Error(`Not a Google Drive file URL: ${url}`);
  const base = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let res = await fetch(base, { redirect: "follow" });
  let body = Buffer.from(await res.arrayBuffer());
  const probe = body.toString("utf8", 0, Math.min(body.length, 8000));
  if (probe.includes("download_warning") || probe.includes("Google Drive - Virus scan")) {
    const token = /confirm=([0-9A-Za-z_]+)/.exec(probe)?.[1];
    if (token) {
      res = await fetch(`${base}&confirm=${token}`, { redirect: "follow" });
      body = Buffer.from(await res.arrayBuffer());
    }
  }
  const tail = body.toString("utf8", 0, Math.min(body.length, 500));
  if (body.length < 800 && (tail.includes("<!DOCTYPE") || tail.includes("<html"))) {
    throw new Error("Drive download failed — share the file as “Anyone with the link” or use a direct file URL");
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, body);
  return destPath;
}

async function ensureLocalFile(name, url, slotLabel) {
  const fileName = sanitizeFileName(name);
  if (!fileName) return null;
  const dest = path.join(TEMP_DIR, fileName);
  if (url) {
    await downloadGoogleDrive(url, dest);
    console.log(`DOWNLOAD  ${slotLabel}  →  ${dest}`);
    return dest;
  }
  if (fs.existsSync(dest)) return dest;
  throw new Error(`Missing file in temp folder: ${dest} (run --step=download or place the file manually)`);
}

async function attachSlot(adjustmentId, slot, fileName) {
  if (!fileName) return false;
  const localPath = await ensureLocalFile(fileName, null, `${slot} SA ${adjustmentId}`);
  const originalname = sanitizeFileName(fileName) || path.basename(localPath);
  const filename = uuidFileName(lowerExt(localPath));
  const dest = path.join(absUploadPath(folderOf(MODULE, slot)), filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(localPath, dest);
  const file = {
    fieldname: slot,
    originalname,
    filename,
    path: dest,
    size: fs.statSync(dest).size,
  };
  await upsertTcRmtcSlot(MODULE, {
    modRef: adjustmentId,
    slot,
    file,
    docPath: toRmPublicUploadPath(file, slot),
    remark: null,
    userOrId: { userName: "system" },
  });
  console.log(`SUCCESS  SA ${adjustmentId}  ${slot}  ${originalname}`);
  return true;
}

function resolveUrls(row, cols) {
  const tcName = cell(row, cols.tc);
  const rmName = cell(row, cols.rm);
  let tcUrl = cell(row, cols.tcUrl);
  let rmUrl = cell(row, cols.rmUrl);
  const shared = cell(row, cols.url);
  if (!tcUrl && !rmUrl && shared) {
    if (tcName && !rmName) tcUrl = shared;
    else if (rmName && !tcName) rmUrl = shared;
    else if (tcName && rmName) {
      tcUrl = shared;
      rmUrl = shared;
    } else {
      tcUrl = shared;
    }
  }
  return { tcName, rmName, tcUrl, rmUrl };
}

async function processRow(row, cols, { downloadOnly, uploadOnly }) {
  const idCol = cols.id >= 0 ? cols.id : 0;
  const id = Number(cell(row, idCol));
  if (!Number.isFinite(id) || id <= 0) return;

  const { tcName, rmName, tcUrl, rmUrl } = resolveUrls(row, cols);
  if (!tcName && !rmName && !tcUrl && !rmUrl) {
    skip++;
    return;
  }

  try {
    const needDownload = downloadOnly || STEP === "all";
    const needUpload = uploadOnly || STEP === "all";
    // URL-only rows: download and upload must agree on the same temp file name.
    const tcFile = tcName || (tcUrl ? `sa_${id}_tc_${extractGoogleDriveFileId(tcUrl) || "file"}.pdf` : "");
    const rmFile = rmName || (rmUrl ? `sa_${id}_rmtc_${extractGoogleDriveFileId(rmUrl) || "file"}.pdf` : "");

    if (needDownload) {
      if (tcUrl) await ensureLocalFile(tcFile, tcUrl, `tc SA ${id}`);
      if (rmUrl) await ensureLocalFile(rmFile, rmUrl, `rmtc SA ${id}`);
      if (downloadOnly) {
        ok++;
        return;
      }
    }

    if (needUpload) {
      let touched = false;
      if (tcFile && (await attachSlot(id, "tc", tcFile))) touched = true;
      if (rmFile && (await attachSlot(id, "rmtc", rmFile))) touched = true;
      if (touched) {
        await updateAdjustment({ updated_by: "system", updated_at: new Date() }, { adjustment_id: id });
        ok++;
      } else {
        skip++;
      }
    }
  } catch (e) {
    console.error(`FAIL     SA ${id}  →  ${e.message}`);
    fail++;
  }
}

async function main() {
  if (!fs.existsSync(EXCEL)) {
    console.error(`Excel not found: ${EXCEL}`);
    console.error("Set SA_ATTACH_EXCEL or edit the default path in this script.");
    process.exit(1);
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const sheet = await readSheet(EXCEL);
  if (!sheet.length) {
    console.error("Excel sheet is empty.");
    process.exit(1);
  }

  const hasHeader = looksLikeHeader(sheet[0]);
  const cols = hasHeader
    ? indexHeaders(sheet[0])
    : { id: 0, tc: 1, rm: 2, tcUrl: -1, rmUrl: -1, url: 3 };
  const dataRows = hasHeader ? sheet.slice(1) : sheet;

  const downloadOnly = STEP === "download";
  const uploadOnly = STEP === "upload";

  console.log(`Excel: ${EXCEL}`);
  console.log(`Temp:  ${TEMP_DIR}`);
  console.log(`Step:  ${STEP}  (rows=${dataRows.length})\n`);

  for (const row of dataRows) {
    await processRow(row, cols, { downloadOnly, uploadOnly });
  }

  console.log(`\nDone  success=${ok}  fail=${fail}  skip=${skip}`);
  if (fail > 0) process.exit(1);
}

await main();