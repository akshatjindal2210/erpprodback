/**
 * Issue Request print HTML — same A4 / company header pattern as Forwarding Note
 * and Coil Finder report; body uses RM Store issue + job-card + coil fields.
 */

import fs from "fs";
import path from "path";

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

function fmtShortDate(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function fmtAt(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, "0");
  const min = String(dt.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function fmtQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 4 });
}

function fmtWeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 6 });
}

/** Limits client-supplied print header overrides. */
export function sanitizeIssueRequestPrintCompanyInfo(raw) {
  if (!raw || typeof raw !== "object") return {};
  const limits = { name: 200, address: 800, gstin: 32, phone: 160 };
  const out = {};
  for (const key of Object.keys(limits)) {
    if (typeof raw[key] !== "string") continue;
    const t = raw[key].trim();
    if (t) out[key] = t.slice(0, limits[key]);
  }
  return out;
}

/**
 * @param {object} data - issue request master + job_cards[] (coils nested)
 * @param {object} [companyInfo]
 */
export function buildIssueRequestPrintDocument(data = {}, companyInfo = {}) {
  const companyName = companyInfo.name || "H. P. FASTENERS PVT. LTD.";
  const companyAddr = companyInfo.address || "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005";
  const phone = companyInfo.phone || "Customer Care: info@jflindia.com";
  const gstin = companyInfo.gstin || "";
  const gstLine = gstin ? `<div class="fn-co-sub">GSTIN : ${escapeHtml(gstin)}</div>` : "";

  const issueUid = String(data.issue_uid ?? "");
  const shift = String(data.shift || "—").toUpperCase();
  const docDate = fmtShortDate(data.approved_at || data.created_at);
  const jobCards = Array.isArray(data.job_cards) ? data.job_cards : [];

  const fgCode = String(data.item_code || jobCards[0]?.item_code || "—");
  const fgDesc = String(data.item_desc || jobCards[0]?.item_desc || jobCards[0]?.itemdesc || "");
  const rmCode = String(data.rm_item_code || jobCards[0]?.rm_item_code || "—");
  const rmDesc = String(data.rm_item_desc || jobCards[0]?.rm_item_desc || "");
  const partWt = fmtWeight(data.part_weight ?? jobCards[0]?.part_weight);
  const rmWt = fmtWeight(data.rm_weight ?? jobCards[0]?.rm_weight);

  let grandIssueQty = 0;
  let grandCoilQty = 0;
  let coilLineCount = 0;
  const rowChunks = [];
  let jcSr = 0;

  for (const jc of jobCards) {
    const coils = Array.isArray(jc?.coils) && jc.coils.length ? jc.coils : [null];
    const issueQty = Number(jc?.issue_qty) || 0;
    if (Number.isFinite(issueQty)) grandIssueQty += issueQty;
    jcSr += 1;

    coils.forEach((coil, idx) => {
      const isFirst = idx === 0;
      const coilQty = coil ? Number(coil.qty) || 0 : 0;
      if (coil && Number.isFinite(coilQty)) {
        grandCoilQty += coilQty;
        coilLineCount += 1;
      }

      const snCell = isFirst ? String(jcSr) : "&#160;";
      const jcCell = isFirst ? escapeHtml(jc?.pjobcardno || "—") : "&#160;";
      const macCell = isFirst ? escapeHtml(jc?.macname || "—") : "&#160;";
      const issueQtyCell = isFirst
        ? `<td class="fn-td fn-r fn-bold">${fmtQty(issueQty)}</td>`
        : `<td class="fn-td fn-c">&#160;</td>`;

      const coilNo = coil ? escapeHtml(String(coil.coil_no_uid || "").trim() || "—") : "—";
      const heatNo = coil ? escapeHtml(String(coil.heat_no || "").trim() || "—") : "—";
      const mrnNo = coil
        ? escapeHtml(String(coil.mrn_no ?? coil.mrn_uid ?? "").trim() || "—")
        : "—";
      const coilQtyCell = coil ? fmtQty(coilQty) : "—";
      const rowClass = !isFirst ? ` class="fn-tr-pack"` : "";

      rowChunks.push(`
        <tr${rowClass}>
          <td class="fn-td fn-c">${snCell}</td>
          <td class="fn-td fn-l">${jcCell}</td>
          <td class="fn-td fn-l">${macCell}</td>
          ${issueQtyCell}
          <td class="fn-td fn-l fn-wrap">${coilNo}</td>
          <td class="fn-td fn-l fn-wrap">${heatNo}</td>
          <td class="fn-td fn-c fn-wrap">${mrnNo}</td>
          <td class="fn-td fn-r">${coilQtyCell}</td>
        </tr>`);
    });
  }

  if (!rowChunks.length) {
    rowChunks.push(`
      <tr><td colspan="8" class="fn-td fn-c" style="padding:10px;font-style:italic;">No job cards on this issue request.</td></tr>`);
  } else {
    rowChunks.push(`
      <tr class="fn-tr-total">
        <td colspan="3" class="fn-td fn-total-lbl">Total</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${fmtQty(grandIssueQty)}</td>
        <td class="fn-td fn-c fn-bold" colspan="2">${coilLineCount || Number(data.coil_count) || 0} coil(s)</td>
        <td class="fn-td fn-c">&#160;</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${fmtQty(grandCoilQty)}</td>
      </tr>`);
  }

  const remarks = data.remarks ? escapeHtml(String(data.remarks)) : "";
  const createdBy = escapeHtml(String(data.created_by_name || data.created_by || "").trim());
  const createdAt = escapeHtml(fmtAt(data.created_at));
  const approvedBy = escapeHtml(String(data.approved_by_name || data.approved_by || "").trim());
  const approvedAt = escapeHtml(fmtAt(data.approved_at));
  const logoBlock = getLogoBlock();

  const partyLine = [
    fgDesc ? `${fgCode} — ${fgDesc}` : fgCode,
  ].join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Issue Request ${escapeHtml(issueUid)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 8mm 10mm 14mm 10mm;
      @bottom-right {
        content: "Page " counter(page) " of " counter(pages);
        font-family: "Times New Roman", Times, Georgia, serif;
        font-size: 9pt;
        color: #000;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: "Times New Roman", Times, Georgia, serif;
      font-size: 11pt;
      line-height: 1.3;
      color: #000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .fn-sheet { width: 100%; max-width: 190mm; margin: 0 auto; }
    .fn-border {
      border: 3px double #000;
      padding: 5mm 7mm 4mm;
      background: #fff;
    }
    .fn-head-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 3mm;
      width: 100%;
    }
    .fn-logo-cell {
      flex: 0 0 20mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fn-head-main { flex: 1; min-width: 0; text-align: center; }
    .fn-logo-img {
      max-height: 18mm;
      max-width: 18mm;
      width: 100%;
      height: auto;
      object-fit: contain;
      display: block;
      filter: grayscale(1) brightness(0);
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .fn-logo-fallback {
      width: 15mm; height: 15mm;
      border: 2px solid #000;
      clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 8pt;
    }
    .fn-co-name {
      text-align: center;
      font-size: 15pt;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      line-height: 1.1;
    }
    .fn-fn-title {
      text-align: center;
      font-size: 12pt;
      font-weight: 800;
      letter-spacing: 3px;
      text-transform: uppercase;
      margin-top: 2mm;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .fn-co-sub { text-align: center; font-size: 8.5pt; margin-top: 1.5mm; line-height: 1.35; }
    .fn-meta-bar {
      margin-top: 2mm;
      margin-bottom: 1.5mm;
      padding: 1.5mm 0 2mm;
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
    }
    .fn-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8mm;
      font-size: 10.5pt;
      line-height: 1.45;
    }
    .fn-meta-row .k { font-weight: 700; margin-right: 2mm; }
    .fn-meta-date { text-align: right; flex-shrink: 0; }
    .fn-meta-cust {
      margin-top: 2mm;
      font-size: 10pt;
      line-height: 1.45;
      word-break: break-word;
    }
    .fn-meta-cust .k { font-weight: 700; margin-right: 2mm; }
    .fn-cust-name { font-weight: 600; }
    .fn-tbl-wrap { margin-top: 0; }
    .fn-tbl { width: 100%; border-collapse: collapse; font-size: 9pt; table-layout: fixed; }
    .fn-tbl thead { display: table-header-group; }
    .fn-page-head td {
      border: none;
      padding: 0 0 2mm;
      vertical-align: top;
      background: #fff;
    }
    .fn-page-head .fn-border { border: none; padding: 0; }
    .fn-tbl thead th {
      border: 1px solid #000;
      padding: 4px 3px;
      font-weight: 700;
      text-align: center;
      background: #fff;
      color: #000;
      border-bottom: 2px solid #000;
    }
    .fn-td {
      border: 1px solid #000;
      padding: 3px 4px;
      vertical-align: middle;
    }
    .fn-wrap {
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: normal;
      line-height: 1.25;
    }
    .fn-c { text-align: center; }
    .fn-l { text-align: left; }
    .fn-r { text-align: right; font-variant-numeric: tabular-nums; }
    .fn-bold { font-weight: 700; }
    .fn-tr-pack .fn-td { border-top: 1px dotted #bbb; }
    .fn-tr-total td { border-top: 2px solid #000; }
    .fn-total-lbl {
      text-align: right;
      font-weight: 700;
      padding: 6px 8px;
    }
    .fn-total-num { font-size: 10pt; padding: 5px 4px; }
    .fn-foot-wrap { margin-top: 3mm; page-break-inside: avoid; }
    .fn-foot {
      width: 100%;
      border-collapse: collapse;
      font-size: 10pt;
      table-layout: fixed;
    }
    .fn-foot td {
      padding: 5px 0 6px;
      vertical-align: bottom;
    }
    .fn-fl {
      font-weight: 700;
      white-space: nowrap;
      padding-right: 8px;
      line-height: 1.3;
    }
    .fn-fv { padding-right: 10px; }
    .fn-fv-last { padding-right: 0; }
    .fn-under {
      display: block;
      width: 100%;
      border-bottom: 1px dotted #000;
      min-height: 1.35em;
      padding: 1px 2px 2px;
      overflow: hidden;
      text-align: left;
      word-break: break-word;
    }
    .fn-remarks {
      margin-top: 2mm;
      font-size: 9.5pt;
      line-height: 1.4;
      padding-top: 1.5mm;
      border-top: 1px solid #ccc;
    }
    .fn-body-stack { display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div class="fn-sheet">
    <div class="fn-border">
      <div class="fn-body-stack">
        <div class="fn-tbl-wrap">
          <table class="fn-tbl" cellspacing="0">
            <thead>
              <tr class="fn-page-head">
                <td colspan="8">
                  <div class="fn-border">
                    <div class="fn-head-row">
                      <div class="fn-logo-cell">${logoBlock}</div>
                      <div class="fn-head-main">
                        <div class="fn-co-name">${escapeHtml(companyName)}</div>
                        <div class="fn-fn-title">Issue Request</div>
                        <div class="fn-co-sub">${escapeHtml(companyAddr)}</div>
                        ${gstLine}
                        <div class="fn-co-sub">${escapeHtml(phone)}</div>
                      </div>
                      <div class="fn-logo-cell" aria-hidden="true"></div>
                    </div>
                    <div class="fn-meta-bar">
                      <div class="fn-meta-row">
                        <div><span class="k">S. No.</span> ${escapeHtml(issueUid)}</div>
                        <div><span class="k">Shift</span> ${escapeHtml(shift)}</div>
                        <div class="fn-meta-date"><span class="k">Date</span> ${escapeHtml(docDate)}</div>
                      </div>
                      <div class="fn-meta-cust">
                        <span class="k">FG Item</span>
                        <span class="fn-cust-name">${escapeHtml(partyLine)}</span>
                      </div>
                      <div class="fn-meta-cust">
                        <span class="k">RM Item</span>
                        <span class="fn-cust-name">${escapeHtml(rmDesc ? `${rmCode} — ${rmDesc}` : rmCode)}</span>
                        <span class="k" style="margin-left:8mm;">Part Wt</span> ${escapeHtml(partWt)}
                        <span class="k" style="margin-left:4mm;">RM Wt</span> ${escapeHtml(rmWt)}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
              <tr>
                <th style="width:6%">S.No.</th>
                <th style="width:12%">Job Card</th>
                <th style="width:11%">Machine</th>
                <th style="width:10%">Issue Qty</th>
                <th style="width:20%">Coil No</th>
                <th style="width:22%">Heat No</th>
                <th style="width:10%">MRN No</th>
                <th style="width:9%">Coil Qty</th>
              </tr>
            </thead>
            <tbody>
              ${rowChunks.join("")}
            </tbody>
          </table>
        </div>

        <div class="fn-foot-wrap">
          <table class="fn-foot" cellspacing="0">
            <tr>
              <td class="fn-fl" style="width:14%">Created By</td>
              <td class="fn-fv" style="width:24%"><span class="fn-under">${createdBy || "&#160;"}</span></td>
              <td class="fn-fl" style="width:6%">At</td>
              <td class="fn-fv" style="width:20%"><span class="fn-under">${createdAt || "&#160;"}</span></td>
              <td class="fn-fl" style="width:10%">Req. Qty</td>
              <td class="fn-fv fn-fv-last" style="width:26%"><span class="fn-under">${escapeHtml(fmtQty(data.requested_qty ?? grandIssueQty))}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">Approved By</td>
              <td class="fn-fv"><span class="fn-under">${approvedBy || "&#160;"}</span></td>
              <td class="fn-fl">At</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${approvedAt || "&#160;"}</span></td>
            </tr>
          </table>
          ${
            remarks
              ? `<div class="fn-remarks"><strong>Remarks:</strong> ${remarks}</div>`
              : ""
          }
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
