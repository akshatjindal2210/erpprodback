/**
 * Coil Finder Report HTML — FN-identical header; body paginates cleanly.
 * Canonical RM Coil / QC report — same HTML from QC Check, Coil Finder, Rejection.
 * Field lists / columns come from coilFinderReportSchema.js (edit there).
 */

import fs from "fs";
import path from "path";
import { numberedSectionTitle, hasValue, buildQcSummaryRows, QC_SPEC_COLUMNS, resolveRowCells, qcLineResult, formatHumanDateTime } from "./coilFinderReportSchema.js";
import { rasterizePdfPages } from "./rasterizePdfPages.js";
import { getPrintLogoBlock, buildPrintLogoCss } from "../../../../core/lib/utils/print/printLogo.js";

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mimeFromName(fileName) {
  const n = String(fileName || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function fileToDataUrl(diskPath, fileName) {
  try {
    if (!diskPath || !fs.existsSync(diskPath)) return null;
    const buf = fs.readFileSync(diskPath);
    return `data:${mimeFromName(fileName)};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function isPdfFile(diskPath) {
  try {
    if (!diskPath || !fs.existsSync(diskPath)) return false;
    if (/\.pdf$/i.test(diskPath)) return true;
    const fd = fs.openSync(diskPath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString("latin1").includes("%PDF");
  } catch {
    return false;
  }
}

async function pdfToImageItems(doc) {
  try {
    if (!doc?.diskPath || !fs.existsSync(doc.diskPath)) return [];
    if (!isPdfFile(doc.diskPath) && !doc.isPdf) return [];
    if (fs.statSync(doc.diskPath).size > MAX_ATTACH_BYTES) return [];
    const pages = await rasterizePdfPages(doc.diskPath);
    const title = attachTitle(doc);
    const fileName = doc.fileName || "";
    return pages.map((src, i) => ({
      title: pages.length > 1 ? `${title} · page ${i + 1} of ${pages.length}` : title,
      src,
      fileName,
    }));
  } catch (err) {
    console.error("[coil finder-report] PDF embed failed:", doc?.fileName || doc?.diskPath, err?.message || err);
    return [];
  }
}

function sortDocs(documents = []) {
  const rank = { ipr: 0, tc: 1, rmtc: 2, qc: 3 };
  return [...(documents || [])].sort((a, b) => {
    const ra = rank[a.kind] ?? 9;
    const rb = rank[b.kind] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
}

function isIprDoc(doc) {
  return String(doc?.kind || "").toLowerCase() === "ipr";
}

function iprImageDocs(documents = []) {
  return sortDocs(documents).filter((doc) => isIprDoc(doc) && doc.isImage && doc.diskPath);
}

function renderDetails(details = []) {
  const rows = (details || []).filter((row) => hasValue(row?.value));
  if (!rows.length) return `<p class="cfr-muted">No coil details.</p>`;
  return `
    <div class="cfr-detail-grid">
      ${rows
        .map(
          (row) => `
        <div class="cfr-detail-item">
          <div class="cfr-label">${escapeHtml(row.label)}</div>
          <div class="cfr-value">${escapeHtml(row.value)}</div>
        </div>`,
        )
        .join("")}
    </div>`;
}

function renderResultBadge(result) {
  const r = String(result || "").toLowerCase();
  if (r === "pass") return `<span class="cfr-badge-pass">Pass</span>`;
  if (r === "fail") return `<span class="cfr-badge-fail">Fail</span>`;
  return `<span class="cfr-badge-na">—</span>`;
}

function renderStatusBadge(statusValue) {
  const label = escapeHtml(statusValue || "—");
  const s = String(statusValue || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (s === "passed" || s === "pass") return `<span class="cfr-status-pass">${label}</span>`;
  if (s === "failed" || s === "fail") return `<span class="cfr-status-fail">${label}</span>`;
  if (s === "awaiting_approval") return `<span class="cfr-status-await">${label}</span>`;
  if (s === "draft") return `<span class="cfr-status-draft">${label}</span>`;
  if (s === "pending") return `<span class="cfr-status-pending">${label}</span>`;
  return `<span class="cfr-status-pending">${label}</span>`;
}

function renderQcBlocks(qcChecks = []) {
  if (!qcChecks.length) return `<p class="cfr-muted">No QC check linked to this coil.</p>`;
  return qcChecks
    .map((check) => {
      const summary = buildQcSummaryRows(check)
        .map((row) => {
          const valueHtml = row.key === "status" ? renderStatusBadge(row.value) : escapeHtml(row.value);
          return `<div><span class="k">${escapeHtml(row.label)}:</span> ${valueHtml}</div>`;
        })
        .join("");

      const ths = QC_SPEC_COLUMNS.map((c) => `<th>${escapeHtml(c.title)}</th>`).join("");
      const specRows = (check.items || [])
        .map((spec) => {
          const cells = resolveRowCells(QC_SPEC_COLUMNS, spec);
          const tds = cells
            .map((val, i) => {
              const col = QC_SPEC_COLUMNS[i];
              if (col?.key === "result") {
                return `<td>${renderResultBadge(qcLineResult(spec))}</td>`;
              }
              const cls = [col?.mono ? "cfr-mono" : "", col?.bold ? "cfr-strong" : ""]
                .filter(Boolean)
                .join(" ");
              const inner = col?.bold ? `<strong>${escapeHtml(val)}</strong>` : escapeHtml(val);
              return `<td${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");

      const table = (check.items || []).length
        ? `
          <table class="cfr-spec-table">
            <thead><tr>${ths}</tr></thead>
            <tbody>${specRows}</tbody>
          </table>`
        : `<p class="cfr-muted" style="padding:2mm 2.5mm;">No spec lines.</p>`;

      return `
        <div class="cfr-qc-block">
          <div class="cfr-qc-head">QC Check #${escapeHtml(check.qc_check_uid)}</div>
          <div class="cfr-qc-summary">${summary || ""}</div>
          ${table}
        </div>`;
    })
    .join("");
}

const DOC_KIND_LABEL = {
  tc: "Test Certificate (TC)",
  rmtc: "Raw Material TC (RMTC)",
  qc: "QC Inspection Document",
  ipr: "IPR Rejection Photo",
};

function docKindLabel(kind) {
  const k = String(kind || "").trim().toLowerCase();
  return DOC_KIND_LABEL[k] || "Supporting Document";
}

/** Short page heading like "QC · UTS" / "TC" / "RMTC" (no file names). */
function attachPageHeading(docOrItem) {
  const kind = String(docOrItem?.kind || "").trim().toLowerCase();
  const label = String(docOrItem?.label || docOrItem?.detailLabel || "").trim();
  const spec =
    label &&
    !/^QC-\d+$/i.test(label) &&
    !/^test certificate$/i.test(label) &&
    !/^raw material/i.test(label) &&
    !/^qc uploaded/i.test(label) &&
    !/^rejection photo/i.test(label)
      ? label
      : "";

  if (kind === "qc") return spec ? `QC · ${spec}` : "QC";
  if (kind === "tc") return "TC";
  if (kind === "rmtc") return "RMTC";
  if (kind === "ipr") return spec ? `IPR · ${spec}` : "IPR";
  return docKindLabel(kind);
}

function docDisplayName(doc) {
  const kind = String(doc?.kind || "").trim().toLowerCase();
  const label = String(doc?.label || "").trim();
  const file = String(doc?.fileName || "").trim();
  const sub = String(doc?.sub || "").trim();

  if (kind === "tc") return "Test Certificate";
  if (kind === "rmtc") return "Raw Material Test Certificate";
  if (kind === "ipr") {
    return label || "Rejection photo";
  }
  if (kind === "qc") {
    // Prefer spec name; never show a raw UUID-looking file alone as the title.
    if (label && !/^QC-\d+$/i.test(label)) return label;
    return "QC uploaded document";
  }
  return label || file || "Document";
}

function docSourceLine(doc) {
  const sub = String(doc?.sub || "").trim();
  if (sub) return sub;
  const kind = String(doc?.kind || "").trim().toLowerCase();
  if (kind === "tc" || kind === "rmtc") return "Uploaded with MRN / Stock Adjustment sticker";
  if (kind === "qc") return "Uploaded with QC check";
  if (kind === "ipr") return "Uploaded with in-process rejection";
  return "";
}

function renderAttachmentsList(documents = [], { embeddedIds = null } = {}) {
  const shown = new Set(iprImageDocs(documents).map((d) => d.id));
  const ordered = sortDocs(documents).filter((doc) => !shown.has(doc.id));
  if (!ordered.length) return `<p class="cfr-muted">No Test Certificate / RMTC / QC documents found.</p>`;
  const embedded = embeddedIds instanceof Set ? embeddedIds : null;
  return `
    <ol class="cfr-attach-list">${ordered
      .map((doc) => {
        const typeName = docKindLabel(doc.kind);
        const onDisk = Boolean(doc.diskPath);
        const willEmbed = embedded ? embedded.has(doc.id) : onDisk;
        const status = !onDisk
          ? `<span class="cfr-attach-miss"> · missing</span>`
          : willEmbed
            ? ""
            : `<span class="cfr-attach-miss"> · could not embed</span>`;
        return `<li><strong>${escapeHtml(typeName)}</strong>${status}</li>`;
      })
      .join("")}</ol>`;
}

function renderIprPhotosSection(documents = []) {
  const images = iprImageDocs(documents);
  if (!images.length) return "";
  const n = images.length;
  const countClass = n <= 1 ? "cfr-ipr-photos--1" : "cfr-ipr-photos--n";
  const figures = images
    .map((doc) => {
      const src = fileToDataUrl(doc.diskPath, doc.fileName);
      if (!src) return "";
      return `
        <figure class="cfr-ipr-photo">
          <figcaption class="cfr-ipr-cap">${escapeHtml(docDisplayName(doc))}${
            doc.sub ? ` · ${escapeHtml(doc.sub)}` : ""
          }</figcaption>
          <img src="${src}" alt="${escapeHtml(docDisplayName(doc))}" />
        </figure>`;
    })
    .filter(Boolean)
    .join("");
  if (!figures) return "";
  return `
    <div class="cfr-section cfr-section--photos">
      <h2 class="cfr-section-title">${escapeHtml(numberedSectionTitle("ipr_photos", { hasIprPhotos: true }))}</h2>
      <div class="cfr-ipr-photos ${countClass}">${figures}</div>
    </div>`;
}

/** Clear human title for attachment page — type first, then what it is. */
function attachTitle(doc, { page = null, pages = null } = {}) {
  const typeName = docKindLabel(doc.kind);
  const name = docDisplayName(doc);
  const source = docSourceLine(doc);
  const pageBit =
    page != null && pages != null && pages > 1 ? ` · Page ${page} of ${pages}` : "";
  const nameBit =
    name && name.toLowerCase() !== typeName.toLowerCase() && !typeName.toLowerCase().includes(name.toLowerCase())
      ? ` — ${name}`
      : "";
  const sourceBit = source ? ` (${source})` : "";
  return `${typeName}${nameBit}${sourceBit}${pageBit}`;
}

function renderReportChrome({
  logoHtml,
  companyName,
  companyAddr,
  gstLine,
  phone,
  email,
  reportSubtitle,
  coilUid,
  generatedAt,
  customer,
  mrn_uid,
}) {
  return `
      <div class="fn-head-row">
        <div class="fn-logo-cell">${logoHtml}</div>
        <div class="fn-head-main">
          <div class="fn-co-name">${escapeHtml(companyName)}</div>
          <div class="fn-fn-title">${escapeHtml(reportSubtitle)}</div>
          <div class="fn-co-sub">${escapeHtml(companyAddr)}</div>
          ${gstLine}
          <div class="fn-co-sub">Customer Care: ${escapeHtml(email)}</div>
          ${phone ? `<div class="fn-co-sub">Phone : ${escapeHtml(phone)}</div>` : ""}
        </div>
        <div class="fn-logo-cell" aria-hidden="true"></div>
      </div>
      <div class="fn-meta-bar">
        <div class="fn-meta-row">
          <div><span class="k">MRN UID</span> ${escapeHtml(mrn_uid)}</div>
          <div class="fn-meta-date"><span class="k">Date</span> ${escapeHtml(generatedAt)}</div>
        </div>
      </div>`;
}

/** One A4 page per attachment — short type heading, no company header / border. */
function renderAttachmentReportPage(item) {
  const typeLine = item.pageHeading || attachPageHeading(item);
  return `
    <div class="cfr-attach-sheet">
      <div class="cfr-attach-type">${escapeHtml(typeLine)}</div>
      <div class="cfr-attach-frame">
        <img class="cfr-attach-img" src="${item.src}" alt="${escapeHtml(typeLine)}" />
      </div>
    </div>`;
}

function buildAttachPageMeta(doc, { page = null, pages = null } = {}) {
  const typeLabel = docKindLabel(doc.kind);
  const pageHeading = attachPageHeading(doc);
  const pageLabel =
    page != null && pages != null && pages > 1 ? `Page ${page} of ${pages}` : "";
  return {
    typeLabel,
    pageHeading,
    label: doc.label || "",
    pageLabel,
    title: pageHeading,
  };
}

function toImageItem(doc, pageMeta = {}) {
  const src = fileToDataUrl(doc.diskPath, doc.fileName);
  if (!src) return null;
  const meta = buildAttachPageMeta(doc, pageMeta);
  return {
    id: doc.id,
    kind: doc.kind,
    src,
    fileName: doc.fileName || "",
    ...meta,
  };
}

/**
 * Build A4 attachment pages (report type) + set of successfully embedded doc ids.
 * @returns {Promise<{ html: string, embeddedIds: Set<string> }>}
 */
async function renderAttachmentPages(documents = []) {
  const shownOnFirstPage = new Set(iprImageDocs(documents).map((d) => d.id));
  const ordered = sortDocs(documents).filter((doc) => doc?.diskPath && !shownOnFirstPage.has(doc.id));
  const embeddedIds = new Set();

  const pdfPageMap = new Map();
  await Promise.all(
    ordered
      .filter((doc) => isPdfFile(doc.diskPath) || doc.isPdf)
      .map(async (doc) => {
        pdfPageMap.set(doc.id, await pdfToImageItems(doc));
      })
  );

  const items = [];
  for (const doc of ordered) {
    if (isPdfFile(doc.diskPath) || doc.isPdf) {
      const pages = pdfPageMap.get(doc.id) || [];
      if (!pages.length) continue;
      embeddedIds.add(doc.id);
      pages.forEach((p, i) => {
        const meta = buildAttachPageMeta(doc, { page: i + 1, pages: pages.length });
        items.push({
          src: typeof p === "string" ? p : p.src,
          id: doc.id,
          kind: doc.kind,
          fileName: doc.fileName || (typeof p === "object" ? p.fileName : "") || "",
          ...meta,
        });
      });
      continue;
    }
    const item = toImageItem(doc);
    if (!item) continue;
    embeddedIds.add(doc.id);
    items.push(item);
  }

  const html = items.map((item) => renderAttachmentReportPage(item)).join("");
  return { html, embeddedIds };
}

/**
 * @param {{ coil?: object, details?: array, qcChecks?: array, documents?: array, companyInfo?: object, generatedAt?: string }} payload
 */
export async function buildCoilFinderReportDocument(payload = {}) {
  const coil = payload.coil || {};
  const companyInfo = payload.companyInfo || {};
  const companyName = companyInfo.name || "H. P. FASTENERS PVT. LTD.";
  const companyAddr = companyInfo.address || "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005";
  const phone = companyInfo.phone || "";
  const email = String(companyInfo.email || "info@jflindia.com").replace(/^Customer Care:\s*/i, "").trim() || "info@jflindia.com";
  const gstin = companyInfo.gstin || "";
  const gstLine = gstin ? `<div class="fn-co-sub">GSTIN : ${escapeHtml(gstin)}</div>` : "";

  const coilUid = String(coil.coil_no_uid || "—");
  const mrn_uid = String(coil.mrn_uid || "—");
  const customer = String(coil.acc_name || "—");
  const generatedAt =
    payload.generatedAt || formatHumanDateTime(new Date()) || new Date().toISOString();
  const docs = payload.documents || [];
  const hasIprPhotos = iprImageDocs(docs).length > 0;
  const iprPhotosHtml = renderIprPhotosSection(docs);

  const chromeCtx = {
    companyName,
    companyAddr,
    gstLine,
    phone,
    email,
    coilUid,
    generatedAt,
    customer,
    mrn_uid,
  };
  const { html: attachmentPages, embeddedIds } = await renderAttachmentPages(docs);
  const logoHtml = getPrintLogoBlock();
  const mainChrome = renderReportChrome({
    ...chromeCtx,
    logoHtml,
    reportSubtitle: "RM Quality Check Report",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=210mm, initial-scale=1" />
  <title>RM Quality Check Report ${escapeHtml(coilUid)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 8mm 5mm 14mm 5mm;
      @bottom-right {
        content: "Page " counter(page) " of " counter(pages);
        font-family: "Times New Roman", Times, Georgia, serif;
        font-size: 9pt;
        color: #000;
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      max-width: 210mm;
      font-family: "Times New Roman", Times, Georgia, serif;
      font-size: 11pt;
      line-height: 1.3;
      color: #000;
      background: #fff;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      color-adjust: exact;
    }
    .fn-sheet { width: 200mm; max-width: 200mm; margin: 0 auto; }

    .fn-border {
      border: 0.7mm double #000;
      padding: 3.5mm 3.5mm 3mm;
      background: #fff;
      break-inside: auto;
      page-break-inside: auto;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .fn-head-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 2mm;
      width: 100%;
    }
    ${buildPrintLogoCss()}
    .fn-head-main { flex: 1; min-width: 0; text-align: center; }
    .fn-co-name {
      text-align: center;
      font-size: 14pt;
      font-weight: 800;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      line-height: 1.15;
    }
    .fn-fn-title {
      text-align: center;
      font-size: 11.5pt;
      font-weight: 800;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      margin-top: 1.5mm;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .fn-co-sub { text-align: center; font-size: 8pt; margin-top: 1mm; line-height: 1.3; }
    .fn-meta-bar {
      margin-top: 3mm;
      margin-bottom: 0;
      padding: 2.5mm 0;
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
    }
    .fn-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8mm;
      font-size: 10pt;
    }
    .fn-meta-row .k { font-weight: 700; margin-right: 2mm; }
    .fn-meta-date { text-align: right; flex-shrink: 0; }
    .fn-meta-cust { margin-top: 1.5mm; font-size: 10pt; word-break: break-word; }
    .fn-meta-cust .k { font-weight: 700; margin-right: 2mm; }
    .fn-cust-name { font-weight: 600; }

    .cfr-body { margin-top: 6mm; }
    .cfr-section {
      margin-top: 4mm;
      break-inside: auto;
      page-break-inside: auto;
    }
    .cfr-section--photos { margin-top: 2mm; }
    .cfr-section--photos + .cfr-section { margin-top: 7mm; }
    .cfr-section-title {
      font-size: 12pt;
      font-weight: 800;
      margin: 0 0 2mm;
      padding-bottom: 1mm;
      border-bottom: 1px solid #ccc;
      break-after: avoid;
      page-break-after: avoid;
    }
    .cfr-ipr-photos {
      display: grid;
      gap: 3.5mm;
      grid-template-columns: 1fr;
    }
    .cfr-ipr-photos--1 { grid-template-columns: 1fr; }
    .cfr-ipr-photos--n { grid-template-columns: 1fr 1fr; }
    .cfr-ipr-photo {
      margin: 0;
      border: 1px solid #cbd5e1;
      background: #fff;
      overflow: hidden;
    }
    .cfr-ipr-cap {
      font-size: 8pt;
      font-weight: 700;
      padding: 1mm 1.5mm;
      border-bottom: 1px solid #e2e8f0;
      background: #f8fafc;
    }
    .cfr-ipr-photo img {
      display: block;
      width: 100%;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cfr-ipr-photos--1 img { max-height: 52mm; object-fit: contain; }
    .cfr-ipr-photos--n img { height: 44mm; object-fit: cover; }
    .cfr-detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3.5mm 10mm;
    }
    .cfr-label {
      font-size: 8pt;
      font-weight: 700;
      text-transform: uppercase;
      color: #555;
      letter-spacing: 0.3px;
    }
    .cfr-value {
      font-size: 10.5pt;
      font-weight: 600;
      word-break: break-word;
      margin-top: 1mm;
    }
    .cfr-qc-block {
      margin-top: 3mm;
      border: 1px solid #94a3b8;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .cfr-qc-head {
      background: #e2e8f0;
      padding: 1.5mm 2.5mm;
      font-size: 11pt;
      font-weight: 800;
    }
    .cfr-qc-summary {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5mm 5mm;
      padding: 2mm 2.5mm;
      font-size: 9.5pt;
    }
    .cfr-qc-summary .k { font-weight: 700; color: #475569; }
    .cfr-spec-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 9pt;
    }
    .cfr-spec-table th {
      background: #f8fafc;
      border-top: 1px solid #cbd5e1;
      border-bottom: 1px solid #cbd5e1;
      text-align: left;
      padding: 1.5mm 2mm;
      font-size: 8pt;
      text-transform: uppercase;
      color: #64748b;
      text-decoration: none;
    }
    .cfr-spec-table td {
      border-bottom: 1px solid #e2e8f0;
      padding: 1.5mm 2mm;
      vertical-align: middle;
      text-decoration: none;
    }
    .cfr-spec-table thead { display: table-header-group; }
    .cfr-spec-table tr { break-inside: avoid; page-break-inside: avoid; }
    .cfr-mono { font-family: Consolas, "Courier New", monospace; }
    .cfr-badge-pass {
      display: inline-block;
      padding: 0.5mm 1.5mm;
      border-radius: 999px;
      background: #d1fae5;
      color: #065f46;
      font-weight: 800;
      font-size: 8pt;
      text-transform: uppercase;
    }
    .cfr-badge-fail {
      display: inline-block;
      padding: 0.5mm 1.5mm;
      border-radius: 999px;
      background: #fee2e2;
      color: #991b1b;
      font-weight: 800;
      font-size: 8pt;
      text-transform: uppercase;
    }
    .cfr-badge-na { color: #94a3b8; font-size: 8pt; }
    .cfr-status-pass,
    .cfr-status-fail,
    .cfr-status-await,
    .cfr-status-draft,
    .cfr-status-pending {
      display: inline-block;
      padding: 0.4mm 1.8mm;
      border: 1px solid;
      font-weight: 800;
      font-size: 8.5pt;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cfr-status-pass { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
    .cfr-status-fail { background: #fff1f2; color: #be123c; border-color: #fecdd3; }
    .cfr-status-await { background: #eef2ff; color: #4338ca; border-color: #c7d2fe; }
    .cfr-status-draft { background: #f0f9ff; color: #0369a1; border-color: #bae6fd; }
    .cfr-status-pending { background: #fffbeb; color: #b45309; border-color: #fde68a; }
    .cfr-attach-lead { margin: 0 0 2mm; font-size: 9.5pt; color: #334155; }
    .cfr-attach-list { margin: 0; padding-left: 5mm; font-size: 9.5pt; }
    .cfr-attach-ok { color: #047857; font-style: normal; font-size: 8.5pt; }
    .cfr-attach-miss { color: #b45309; font-style: normal; font-size: 8.5pt; }
    .cfr-muted { color: #64748b; font-size: 9pt; font-style: italic; }

    /* Attachment pages — type heading + image, no border / company header */
    .cfr-attach-sheet {
      break-before: page;
      page-break-before: always;
      width: 100%;
      max-width: 200mm;
      margin: 0 auto;
    }
    .cfr-attach-type {
      font-size: 11pt;
      font-weight: 800;
      letter-spacing: 0.3px;
      margin: 0 0 2.5mm;
      padding: 0 0 1.5mm;
      border-bottom: 1px solid #000;
      text-align: left;
    }
    .cfr-attach-frame {
      min-height: 250mm;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      background: #fff;
    }
    .cfr-attach-img {
      display: block;
      width: auto;
      max-width: 100%;
      height: auto;
      max-height: 250mm;
      object-fit: contain;
      object-position: center center;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    @media print {
      .cfr-attach-sheet, .cfr-attach-frame, .cfr-attach-img {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      html, body {
        width: 210mm !important;
        min-width: 210mm !important;
        max-width: 210mm !important;
        margin: 0 !important;
        background: #fff !important;
      }
      .fn-sheet, .cfr-attach-sheet {
        max-width: 200mm !important;
        width: 200mm !important;
        margin: 0 auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="fn-sheet">
    <div class="fn-border">
      ${mainChrome}

      <div class="cfr-body">
        ${iprPhotosHtml}
        <div class="cfr-section">
          <h2 class="cfr-section-title">${escapeHtml(numberedSectionTitle("coil_details", { hasIprPhotos }))}</h2>
          ${renderDetails(payload.details || [])}
        </div>

        <div class="cfr-section">
          <h2 class="cfr-section-title">${escapeHtml(numberedSectionTitle("qc_checks", { hasIprPhotos }))}</h2>
          ${renderQcBlocks(payload.qcChecks || [])}
        </div>

        <div class="cfr-section">
          <h2 class="cfr-section-title">${escapeHtml(numberedSectionTitle("attachments", { hasIprPhotos }))}</h2>
          ${renderAttachmentsList(docs, { embeddedIds })}
        </div>
      </div>
    </div>
  </div>

  ${attachmentPages}
</body>
</html>`;
}

export { sortDocs as sortCoilFinderReportDocs };
