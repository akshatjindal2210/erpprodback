/**
 * Coil Finder Report HTML — FN-identical header; body paginates cleanly.
 * Field lists / columns come from coilFinderReportSchema.js (edit there).
 */

import fs from "fs";
import path from "path";
import { numberedSectionTitle, hasValue, buildQcSummaryRows, QC_SPEC_COLUMNS, resolveRowCells, qcLineResult, formatHumanDate } from "./coilFinderReportSchema.js";
import { rasterizePdfPages } from "./rasterizePdfPages.js";

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getLogoBlock() {
  try {
    const logoPath = path.join(process.cwd(), "logo.png");
    if (fs.existsSync(logoPath)) {
      const bitmap = fs.readFileSync(logoPath);
      const src = `data:image/png;base64,${bitmap.toString("base64")}`;
      return `<img class="fn-logo-img" src="${src}" alt="" />`;
    }
  } catch {
    /* ignore */
  }
  return `<div class="fn-logo-fallback" aria-hidden="true">JFL</div>`;
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

function renderQcBlocks(qcChecks = []) {
  if (!qcChecks.length) return `<p class="cfr-muted">No QC check linked to this coil.</p>`;
  return qcChecks
    .map((check) => {
      const summary = buildQcSummaryRows(check)
        .map(
          (row) => `
          <div><span class="k">${escapeHtml(row.label)}:</span> ${escapeHtml(row.value)}</div>`,
        )
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

function renderAttachmentsList(documents = []) {
  const shown = new Set(iprImageDocs(documents).map((d) => d.id));
  const ordered = sortDocs(documents).filter((doc) => !shown.has(doc.id));
  if (!ordered.length) return `<p class="cfr-muted">No TC / RMTC / QC documents found.</p>`;
  return `<ol class="cfr-attach-list">${ordered
    .map(
      (doc, idx) =>
        `<li><strong>${escapeHtml(String(doc.kind || "doc").toUpperCase())}</strong> — ${escapeHtml(doc.label || doc.fileName || `File ${idx + 1}`)} <span class="cfr-muted">(${escapeHtml(doc.fileName || "")})</span></li>`,
    )
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
          <img src="${src}" alt="${escapeHtml(doc.fileName || doc.label || "Rejection photo")}" />
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

function attachTitle(doc) {
  return `${String(doc.kind || "doc").toUpperCase()} · ${doc.label || doc.fileName || "Document"}`;
}

function renderAttachSlot({ title, innerHtml, frameClass = "" }) {
  return `
        <div class="cfr-attach-slot">
          <div class="cfr-attach-title">${escapeHtml(title)}</div>
          <div class="cfr-attach-frame${frameClass ? ` ${frameClass}` : ""}">
            ${innerHtml}
          </div>
        </div>`;
}

function renderImageSlot({ title, src, fileName }) {
  return renderAttachSlot({
    title,
    innerHtml: `<img class="cfr-attach-img" src="${src}" alt="${escapeHtml(fileName || title)}" />`,
  });
}

function renderAttachmentPage(item) {
  return `
      <div class="cfr-attach-page cfr-attach-page--full">
        ${renderImageSlot(item)}
      </div>`;
}

function renderAttachmentPairPage(left, right) {
  return `
      <div class="cfr-attach-page cfr-attach-page--pair">
        ${renderImageSlot(left)}
        ${renderImageSlot(right)}
      </div>`;
}

function toImageItem(doc) {
  const src = fileToDataUrl(doc.diskPath, doc.fileName);
  if (!src) return null;
  return { title: attachTitle(doc), src, fileName: doc.fileName || "" };
}

async function renderAttachmentPages(documents = []) {
  const parts = [];
  const shownOnFirstPage = new Set(iprImageDocs(documents).map((d) => d.id));
  let pendingImage = null;

  const flushPendingImage = () => {
    if (!pendingImage) return;
    parts.push(renderAttachmentPage(pendingImage));
    pendingImage = null;
  };

  for (const doc of sortDocs(documents)) {
    if (shownOnFirstPage.has(doc.id) || !doc?.diskPath) continue;

    if (isPdfFile(doc.diskPath) || doc.isPdf) {
      flushPendingImage();
      const pdfPages = await pdfToImageItems(doc);
      for (const item of pdfPages) parts.push(renderAttachmentPage(item));
      continue;
    }

    const item = toImageItem(doc);
    if (!item) continue;
    if (pendingImage) {
      parts.push(renderAttachmentPairPage(pendingImage, item));
      pendingImage = null;
    } else {
      pendingImage = item;
    }
  }

  flushPendingImage();
  return parts.join("");
}

/**
 * @param {{ coil?: object, details?: array, qcChecks?: array, documents?: array, companyInfo?: object, generatedAt?: string }} payload
 */
export async function buildCoilFinderReportDocument(payload = {}) {
  const coil = payload.coil || {};
  const companyInfo = payload.companyInfo || {};
  const companyName = companyInfo.name || "H. P. FASTENERS PVT. LTD.";
  const companyAddr = companyInfo.address || "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005";
  const phone = companyInfo.phone || "Customer Care: info@jflindia.com";
  const gstin = companyInfo.gstin || "";
  const gstLine = gstin ? `<div class="fn-co-sub">GSTIN : ${escapeHtml(gstin)}</div>` : "";

  const coilUid = String(coil.coil_no_uid || "—");
  const mrn_uid = String(coil.mrn_uid || "—");
  const mrnDate = formatHumanDate(coil.mrn_dt) || "—";
  const customer = String(coil.acc_name || "—");
  const generatedAt = payload.generatedAt || new Date().toLocaleString("en-IN");
  const docs = payload.documents || [];
  const hasIprPhotos = iprImageDocs(docs).length > 0;
  const iprPhotosHtml = renderIprPhotosSection(docs);
  const attachmentPages = await renderAttachmentPages(docs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Coil Finder Report ${escapeHtml(coilUid)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 10mm 12mm 12mm 12mm;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: "Times New Roman", Times, Georgia, serif;
      font-size: 11pt;
      line-height: 1.3;
      color: #000;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .fn-sheet { width: 100%; max-width: 190mm; margin: 0 auto; }

    .fn-border {
      border: 3px double #000;
      padding: 4mm 6mm 3.5mm;
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
    .fn-logo-cell {
      flex: 0 0 18mm;
      width: 18mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fn-logo-spacer {
      visibility: hidden;
      pointer-events: none;
    }
    .fn-logo-img {
      max-height: 16mm;
      max-width: 16mm;
      width: 100%;
      height: auto;
      object-fit: contain;
      display: block;
      filter: grayscale(1) brightness(0);
    }
    .fn-logo-fallback {
      width: 14mm; height: 14mm;
      border: 2px solid #000;
      clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 7.5pt;
    }
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
    .cfr-attach-list { margin: 0; padding-left: 5mm; font-size: 9.5pt; }
    .cfr-muted { color: #64748b; font-size: 9pt; font-style: italic; }

    .cfr-attach-page {
      break-before: page;
      page-break-before: always;
      margin: 0;
      padding: 4mm;
      border: 3px double #000;
      display: flex;
      flex-direction: column;
      gap: 3mm;
      overflow: visible;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .cfr-attach-page--pair {
      flex-direction: column;
      min-height: 265mm;
    }
    .cfr-attach-page--pair .cfr-attach-slot {
      flex: 1 1 50%;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .cfr-attach-page--pair .cfr-attach-frame {
      align-items: flex-start;
      justify-content: flex-start;
    }
    .cfr-attach-page--full .cfr-attach-slot {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .cfr-attach-title {
      flex: 0 0 auto;
      font-size: 10pt;
      font-weight: 800;
      margin: 0 0 1.5mm;
      padding-bottom: 1mm;
      border-bottom: 1px solid #000;
    }
    .cfr-attach-frame {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: visible;
      background: #fff;
    }
    .cfr-attach-img {
      display: block;
      width: 100%;
      max-width: 100%;
      height: auto;
      max-height: 265mm;
      min-height: 1mm;
      object-fit: contain;
      object-position: center center;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cfr-attach-page--pair .cfr-attach-img {
      width: 100%;
      height: auto;
      max-height: 120mm;
      object-position: top center;
    }
    @media print {
      .cfr-attach-page, .cfr-attach-frame, .cfr-attach-img {
        break-inside: avoid;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="fn-sheet">
    <div class="fn-border">
      <div class="fn-head-row">
        <div class="fn-logo-cell">${getLogoBlock()}</div>
        <div class="fn-head-main">
          <div class="fn-co-name">${escapeHtml(companyName)}</div>
          <div class="fn-fn-title">Coil Finder Report</div>
          <div class="fn-co-sub">${escapeHtml(companyAddr)}</div>
          ${gstLine}
          <div class="fn-co-sub">${escapeHtml(phone)}</div>
        </div>
        <div class="fn-logo-cell fn-logo-spacer" aria-hidden="true">${getLogoBlock()}</div>
      </div>
      <div class="fn-meta-bar">
        <div class="fn-meta-row">
          <div><span class="k">Coil UID</span> ${escapeHtml(coilUid)}</div>
          <div class="fn-meta-date"><span class="k">Date</span> ${escapeHtml(generatedAt)}</div>
        </div>
        <div class="fn-meta-cust"><span class="k">Vendor</span> <span class="fn-cust-name">${escapeHtml(customer)}</span></div>
        <div class="fn-meta-cust"><span class="k">MRN UID</span> ${escapeHtml(mrn_uid)}</div>
      </div>

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
          ${renderAttachmentsList(docs)}
        </div>
      </div>
    </div>

    ${attachmentPages}
  </div>
</body>
</html>`;
}

export { sortDocs as sortCoilFinderReportDocs };
