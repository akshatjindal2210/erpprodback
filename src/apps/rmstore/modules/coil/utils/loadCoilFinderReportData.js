/**
 * Load Coil Finder print payload on the server (FN-style: id in → HTML out).
 */

import path from "path";
import fs from "fs";
import config from "../../../../../config/app/config.js";
import { findCoilByUid } from "../models/coil.model.js";
import { findQcChecks, findQcCheck, findQcCheckItems } from "../../qc-check/models/qcCheck.model.js";
import { findMrnByUid } from "../../mrn/models/mrn.model.js";
import { findAdjustmentById } from "../../stock-adjustment/models/stockAdjustment.model.js";
import { findInProcessRequest, IPR_REQUEST_TYPE, normalizeRequestType } from "../../in-process-request/models/inProcessRequest.model.js";
import { buildCoilDetailRows, formatHumanDateTime } from "./coilFinderReportSchema.js";

export { formatHumanDateTime };

function fileNameFromPath(p) {
  const parts = String(p || "").split(/[/\\]/);
  return parts[parts.length - 1] || "";
}

/** DB path `uploads/rmstore/...` → absolute disk path under config.uploadPath */
export function resolveUploadDiskPath(publicPath) {
  let rel = String(publicPath || "").trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!rel) return null;
  if (rel.startsWith("uploads/")) rel = rel.slice("uploads/".length);
  const abs = path.resolve(config.uploadPath, rel);
  const root = path.resolve(config.uploadPath);
  if (!abs.startsWith(root)) return null;
  return abs;
}

function normalizePublicPath(raw, { kind } = {}) {
  let p = String(raw || "").trim().replace(/\\/g, "/");
  if (!p) return "";
  if (/^https?:\/\//i.test(p) || p.startsWith("blob:")) return p;
  p = p.replace(/^\/+/, "");
  if (p.startsWith("uploads/")) return p;
  if (p.startsWith("rmstore/")) return `uploads/${p}`;
  // Older QC / IPR rows sometimes stored only the upload file name (no folder).
  if (kind === "qc" && /^[\w.\-]+\.(pdf|png|jpe?g|webp|gif)$/i.test(p)) {
    return `uploads/rmstore/qc/${p}`;
  }
  if (kind === "ipr" && /^[\w.\-]+\.(pdf|png|jpe?g|webp|gif)$/i.test(p)) {
    return `uploads/rmstore/ipr/${p}`;
  }
  return "";
}

function sniffFileType(diskPath, fileName) {
  let isImage = /\.(png|jpe?g|webp|gif)$/i.test(fileName);
  let isPdf = /\.pdf$/i.test(fileName);
  if ((isImage || isPdf) && diskPath) return { isImage, isPdf };
  if (!diskPath || !fs.existsSync(diskPath)) return { isImage, isPdf };
  try {
    const fd = fs.openSync(diskPath, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (buf.slice(0, 5).toString("ascii") === "%PDF-") isPdf = true;
    else if (buf[0] === 0xff && buf[1] === 0xd8) isImage = true;
    else if (buf[0] === 0x89 && buf[1] === 0x50) isImage = true;
    else if (buf.slice(0, 4).toString("ascii") === "RIFF") isImage = true; // webp
  } catch {
    /* keep extension-based flags */
  }
  return { isImage, isPdf };
}

function docFromPath({ id, label, sub, path: filePath, name, kind }) {
  const raw = String(filePath || "").trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw) || raw.startsWith("blob:")) {
    const fileName = name || fileNameFromPath(raw) || "Document";
    return {
      id,
      label,
      sub,
      kind,
      path: raw,
      fileName,
      diskPath: null,
      isImage: /\.(png|jpe?g|webp|gif)$/i.test(fileName),
      isPdf: /\.pdf$/i.test(fileName),
    };
  }

  const publicPath = normalizePublicPath(raw, { kind });
  if (!publicPath) return null;

  const diskPath = resolveUploadDiskPath(publicPath);
  const fileName = name || fileNameFromPath(publicPath) || "Document";
  const exists = diskPath ? fs.existsSync(diskPath) : false;
  const resolvedDisk = exists ? diskPath : null;
  const { isImage, isPdf } = sniffFileType(resolvedDisk, fileName);
  return {
    id,
    label,
    sub,
    kind,
    path: publicPath,
    fileName,
    diskPath: resolvedDisk,
    isImage,
    isPdf,
  };
}

function normalizeQcCheck(row, items) {
  if (!row) return null;
  return {
    ...row,
    items: Array.isArray(items) ? items : [],
    // Keep raw timestamps; format only when rendering report/PDF
    inspected_at: row.inspected_at ?? null,
    approved_at: row.approved_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function loadQcChecks(coil) {
  const uid = String(coil.coil_no_uid || "").trim();
  const map = new Map();

  const { data } = await findQcChecks({
    filters: { coil_no_uid: uid },
    page: 1,
    limit: 50,
  });

  for (const row of data || []) {
    if (row?.qc_check_uid == null) continue;
    const id = Number(row.qc_check_uid);
    // findQcChecks already returns items + inspection methods — no N+1 re-fetch.
    const items = (Array.isArray(row.items) ? row.items : []).map((it, idx) => ({
      ...it,
      qc_check_uid: id,
      sno: it?.sno ?? idx + 1,
    })).sort((a, b) => Number(a.sno || 0) - Number(b.sno || 0));
    map.set(id, normalizeQcCheck(row, items));
  }

  // Always load linked QC if missing from the list (edge: orphaned link).
  const linked = coil.qc_uid != null ? Number(coil.qc_uid) : null;
  if (linked && Number.isFinite(linked) && !map.has(linked)) {
    const [row, items] = await Promise.all([findQcCheck(linked), findQcCheckItems(linked)]);
    if (row) map.set(linked, normalizeQcCheck(row, items));
  }

  return [...map.values()].sort((a, b) => Number(a.qc_check_uid) - Number(b.qc_check_uid));
}

async function loadStickerDocs(coil) {
  const docs = [];
  const seen = new Set();
  const pushDoc = (d) => {
    if (!d) return;
    const key = `${d.kind}:${d.path || d.diskPath || d.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    docs.push(d);
  };

  const mrnUid = coil.mrn_uid != null ? String(coil.mrn_uid).trim() : "";
  const saId = coil.sa_id != null ? Number(coil.sa_id) : null;
  const isSa = saId && String(coil.sa_entry_type || "").toLowerCase() === "stock_in";

  const tasks = [];
  if (mrnUid) {
    tasks.push(
      findMrnByUid(mrnUid).then((m) => {
        if (!m) return;
        pushDoc(
          docFromPath({
            id: `tc-mrn-${mrnUid}`,
            label: "Test Certificate",
            sub: "From MRN entry",
            path: m.tc_file_path,
            name: m.tc_file_name,
            kind: "tc",
          })
        );
        pushDoc(
          docFromPath({
            id: `rmtc-mrn-${mrnUid}`,
            label: "Raw Material Test Certificate",
            sub: "From MRN entry",
            path: m.rmtc_file_path,
            name: m.rmtc_file_name,
            kind: "rmtc",
          })
        );
      })
    );
  }
  if (isSa) {
    tasks.push(
      findAdjustmentById(saId).then((sa) => {
        if (!sa) return;
        pushDoc(
          docFromPath({
            id: `tc-sa-${saId}`,
            label: "Test Certificate",
            sub: "From Stock Adjustment",
            path: sa.tc_file_path,
            name: sa.tc_file_name,
            kind: "tc",
          })
        );
        pushDoc(
          docFromPath({
            id: `rmtc-sa-${saId}`,
            label: "Raw Material Test Certificate",
            sub: "From Stock Adjustment",
            path: sa.rmtc_file_path,
            name: sa.rmtc_file_name,
            kind: "rmtc",
          })
        );
      })
    );
  }
  await Promise.all(tasks);
  return docs;
}

function collectQcDocuments(checks) {
  const docs = [];
  for (const check of checks || []) {
    const qcId = check?.qc_check_uid != null ? `QC-${check.qc_check_uid}` : "QC check";
    for (const spec of check.items || []) {
      const specName = String(spec.spec_name || "").trim() || `Spec ${spec.sno ?? ""}`.trim() || "QC spec";
      const d = docFromPath({
        id: `qc-${check.qc_check_uid}-${spec.spec_id ?? spec.sno}`,
        label: specName,
        sub: `${qcId} · inspection upload`,
        path: spec.document_note,
        name: null,
        kind: "qc",
      });
      if (d) docs.push(d);
    }
  }
  return docs;
}

async function loadIprRejectionDocs(coil) {
  const iprUid = coil?.ipr_uid != null ? Number(coil.ipr_uid) : null;
  if (!Number.isFinite(iprUid) || iprUid <= 0) return [];

  const ipr = await findInProcessRequest(iprUid);
  if (!ipr || normalizeRequestType(ipr.request_type) !== IPR_REQUEST_TYPE.REJECTION) return [];

  const docs = [];
  (ipr.attachments || []).forEach((raw, i) => {
    const d = docFromPath({
      id: `ipr-${iprUid}-${i}`,
      label: `Rejection photo ${i + 1}`,
      sub: `IPR #${iprUid}`,
      path: raw,
      name: null,
      kind: "ipr",
    });
    if (d) docs.push(d);
  });
  return docs;
}

/**
 * @param {string} coil_no_uid
 * @returns {Promise<{ coil, details, qcChecks, documents } | null>}
 */
/** @param {string} coil_no_uid
 *  @param {object} [existingCoil] — skip second DB read when caller already loaded the row */
export async function loadCoilFinderReportData(coil_no_uid, existingCoil = null) {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;

  const coil = existingCoil || (await findCoilByUid(uid));
  if (!coil) return null;

  const details = buildCoilDetailRows(coil);
  const [qcChecks, iprDocs, stickerDocs] = await Promise.all([
    loadQcChecks(coil),
    loadIprRejectionDocs(coil),
    loadStickerDocs(coil),
  ]);
  const documents = [...iprDocs, ...collectQcDocuments(qcChecks), ...stickerDocs];

  return { coil, details, qcChecks, documents };
}
