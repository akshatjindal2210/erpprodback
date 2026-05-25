import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { getAppConfigValue, getStickerCompanyInfo, APP_CONFIG_KEYS } from "../models/appConfig.model.js";

const getLogoBase64 = () => {
  try {
    const logoPath = path.join(process.cwd(), "logo.png");
    if (fs.existsSync(logoPath)) {
      const bitmap = fs.readFileSync(logoPath);
      return `data:image/png;base64,${bitmap.toString("base64")}`;
    }
  } catch (err) {
    console.error("Error reading logo.png:", err);
  }
  return null;
};

const logoBase64 = getLogoBase64();

const escapeHtmlText = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Safe segment for browser Save-as-PDF filename (from `<title>`). */
const sanitizePrintFilenamePart = (s) =>
  String(s ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-");

/** Browser print / Save as PDF default filename uses `<title>` (e.g. `Packing No. 12345`). */
export const buildStickerPrintDocumentTitle = (packingNumber) => {
  const pn = sanitizePrintFilenamePart(packingNumber);
  return pn ? `Packing No. ${pn}` : "Packing No.";
};

export const buildPrintDocument = (cards = [], { packing_number } = {}) => {
  const title = escapeHtmlText(buildStickerPrintDocumentTitle(packing_number));
  return `
    <html>
      <head>
        <title>${title}</title>
        <style>
          @page { margin: 0; size: 5.9in 3.8in; }
          body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: #fff; }
          .sticker-wrap { display: flex; flex-direction: column; align-items: center; width: 100%; }
          .sticker-card { 
            page-break-inside: avoid; 
            page-break-after: always; 
            width: 5.9in; 
            height: 3.8in;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
          }
        </style>
      </head>
      <body>
        <div class="sticker-wrap">
          ${cards.map((c) => `<div class="sticker-card">${c}</div>`).join("")}
        </div>
      </body>
    </html>
  `;
};

/** Screen preview: document size = one sticker card only (no full print page chrome). */
export const buildStickerPreviewDocument = (cardHtml) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sticker preview</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 5.7in;
    height: 3.6in;
    overflow: hidden;
    background: #fff;
    box-sizing: border-box;
  }
  body {
    display: block;
    line-height: 0;
  }
  body > div {
    width: 5.7in;
    height: 3.6in;
    box-sizing: border-box;
  }
</style>
</head>
<body>
${cardHtml}
</body>
</html>`;
};

/** Sticker print header — single company, server-only (do not pass from client). */
export const STICKER_COMPANY_INFO = Object.freeze({
  name: "H.P. FASTENERS PVT. LTD.",
  address: "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005",
});

/** External sticker QR: `?box_no_uid=…&id=…` (`id` = panel box_uid). No `box_uid` query param. */
async function resolveStickerQrPayload(sticker) {
  const boxNoUid = String(sticker?.box_no_uid || "").trim();
  const uidNum = Number(sticker?.box_uid);
  const boxUid = Number.isFinite(uidNum) && uidNum > 0 ? String(uidNum) : "";
  const plain = boxNoUid || boxUid;
  try {
    const baseRaw = await getAppConfigValue(APP_CONFIG_KEYS.BOX_QR_PUBLIC_BASE_URL);
    let base = String(baseRaw ?? "").trim();
    if (!base || !/^https?:\/\//i.test(base)) return plain;

    // Normalize: strip trailing ? & / so we never get `...//?id=` or broken joins.
    base = base.replace(/[?&]+$/, "").replace(/\/+$/, "");
    try {
      new URL(base);
    } catch {
      return plain;
    }

    if (!boxNoUid && !boxUid) return plain;

    const params = new URLSearchParams();
    if (boxNoUid) params.set("box_no_uid", boxNoUid);
    if (boxUid) params.set("id", boxUid);
    const joiner = base.includes("?") ? "&" : "?";
    const qrPayload = `${base}${joiner}${params.toString()}`;
    try {
      new URL(qrPayload);
    } catch {
      return plain;
    }
    return qrPayload;
  } catch {
    return plain;
  }
}

// ─── Sticker card builder ─────────────────────────────────────────
export const buildStickerCardHtml = async (sticker) => {
  const company = await getStickerCompanyInfo();
  const qrObject = await resolveStickerQrPayload(sticker);

  let qrUrl = "";
  try {
    qrUrl = await QRCode.toDataURL(qrObject, { width: 240, margin: 0, color: { dark: "#000000", light: "#ffffff" } });
  } catch (err) {
    qrUrl = "";
  }

  const packingDate = sticker.created_at ? new Date(sticker.created_at).toLocaleDateString("en-GB") : "--";

  // Inline style helper: shrink font when text is long so it stays on one line
  const adaptiveFont = (text = "", baseSize = 22, minSize = 14) => {
    const len = String(text).length;
    if (len > 40) return minSize;
    if (len > 25) return Math.max(minSize, baseSize - 4);
    return baseSize;
  };

  const customerAndDescSize = adaptiveFont(
    String(sticker.acc_name || "").length >= String(sticker.itemdesc || "").length
      ? sticker.acc_name
      : sticker.itemdesc,
    15,
    11
  );
  const accNameSize  = customerAndDescSize;
  const itemCodeSize = adaptiveFont(sticker.item_code, 18, 12);
  const itemDescSize = customerAndDescSize;
  const resolvedCustCode = sticker.party_rate_cust_code != null && String(sticker.party_rate_cust_code).trim() !== "" ? String(sticker.party_rate_cust_code).trim() : null;
  const hasCustCode = !!(resolvedCustCode && resolvedCustCode !== "--");
  const detailPadY = hasCustCode ? 4 : 8;
  const detailValueSize = hasCustCode ? 14 : 15;
  const topRowPadTop = hasCustCode ? 7 : 9;
  const topRowPadBottom = hasCustCode ? 3 : 5;
  
  return `
  <div style="
    width:5.7in;
    height:3.6in;
    font-family:Arial,sans-serif;
    background:#fff;
    color:#000;
    box-sizing:border-box;
    overflow:hidden;
    display:flex;
    flex-direction:column;
    border: 1.5px solid #000;
  ">

    <div style="
      display:flex;
      align-items:center;
      border-bottom:1.5px solid #000;
      padding:5px 10px;
      gap:0;
      flex-shrink:0;
    ">
      <!-- Logo -->
      <div style="width:90px; height:65px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-right:15px;">
        ${logoBase64
          ? `<img src="${logoBase64}" style="max-width:100%; max-height:100%; object-fit:contain; filter:grayscale(1) brightness(0);" />`
          : `<div style="width:80px; height:55px; border:2.5px solid #000; border-radius:8px; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:32px; letter-spacing:-1px;">JFL</div>`
        }
      </div>

      <!-- Company info (centre) -->
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center; text-align:center; min-width:0;">
        <div style="margin:0; font-size:24px; font-weight:900; line-height:1.1; color:#000; letter-spacing:0.5px; white-space:nowrap; ">
          ${company.name}
        </div>
        <div style="margin:2px 0 0 0; font-size:12px; font-weight:700; color:#111; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${company.address}
        </div>
        ${company.email ? `<div style="margin:1px 0 0 0; font-size:11px; font-weight:700; color:#333; line-height:1.2;">Customer Care Email:- ${company.email}</div>` : ""}
      </div>

      <!-- Right spacer -->
      <div style="width:70px; flex-shrink:0; margin-left:12px;"></div>
    </div>

    <!-- ── BODY TABLE ── -->
    <table style="width:100%; border-collapse:collapse; table-layout:fixed; flex:1;">
      <tbody>

        <!-- CUST. NAME -->
        <tr>
          <td style="width:20%; font-weight:700; font-size:11px; padding:8px 6px 4px 6px; vertical-align:middle; white-space:nowrap;">CUST. NAME</td>
          <td style="width:3%; font-weight:700; font-size:11px; padding:8px 0 4px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${accNameSize}px; font-weight:400; padding:${topRowPadTop}px 8px ${topRowPadBottom}px 8px; line-height:1.2; word-break:break-word; vertical-align:middle;" colspan="2">${sticker.acc_name || "--"}</td>
        </tr>

        <!-- PART CODE -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:4px 6px; vertical-align:middle; white-space:nowrap;">PART CODE</td>
          <td style="font-weight:700; font-size:11px; padding:4px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${Math.max(14, itemCodeSize)}px; font-weight:900; padding:4px 8px; line-height:1.15; word-break:break-word; vertical-align:middle;" colspan="2">
            <span style="font-weight:900; letter-spacing:0.2px;">
              ${sticker.item_code || "--"}
            </span>
          </td>
        </tr>

        <!-- DESCRIPTION -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:4px 6px 8px 6px; border-bottom:1.5px solid #000; vertical-align:middle; white-space:nowrap;">DESCRIPTION</td>
          <td style="font-weight:700; font-size:11px; padding:4px 0 8px 0; border-bottom:1.5px solid #000; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${itemDescSize}px; font-weight:500; padding:4px 8px 7px 8px; line-height:1.2; border-bottom:1.5px solid #000; word-break:break-word; vertical-align:middle;" colspan="2">${sticker.itemdesc || "--"}</td>
        </tr>

        <!-- BOX QTY + QR (rowspan 4) -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 6px; vertical-align:middle; white-space:nowrap;">BOX QTY</td>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="width:47%; font-size:${detailValueSize + 1}px; font-weight:700; padding:${detailPadY}px 8px; vertical-align:middle; line-height:1.2;">
            ${Number(sticker.qty || 0).toLocaleString()} ${sticker.unit || "PCS"}.
          </td>
          <!-- QR CODE cell -->
          <td style="width:30%; text-align:center; border-left:1.5px solid #000; vertical-align:middle; padding:2px 6px;" rowspan="${hasCustCode ? 5 : 4}">
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%; padding:0; margin:0; margin-top:4px;">
              ${qrUrl ? `<img src="${qrUrl}" style="display:block; width:92%; max-width:205px; max-height:148px; height:auto; object-fit:contain; margin:0 auto;" />`: `<span style="font-size:10px;">QR N/A</span>`}
              <div style="font-size:12px; font-weight:900; font-family:monospace; letter-spacing:0.15px; line-height:1.05; word-break:break-all; text-align:center; padding:0; margin-top:3px;">
                ${sticker.box_no_uid || "--"}
              </div>
            </div>
          </td>
        </tr>

        <!-- PACKING NO. -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 6px; vertical-align:middle; white-space:nowrap;">PACKING NO.</td>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${detailValueSize}px; font-weight:500; padding:${detailPadY}px 8px; line-height:1.2; word-break:break-word; vertical-align:middle;">${sticker.packing_number || "--"}</td>
        </tr>

        <!-- PACKING DT. -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 6px; vertical-align:middle; white-space:nowrap;">PACKING DT.</td>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${detailValueSize}px; font-weight:500; padding:${detailPadY}px 8px; line-height:1.2; vertical-align:middle;">${packingDate}</td>
        </tr>

        <!-- JC NO. -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 6px; vertical-align:middle; white-space:nowrap;">JC NO.</td>
          <td style="font-weight:700; font-size:11px; padding:${detailPadY}px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:${detailValueSize}px; font-weight:500; padding:${detailPadY}px 8px; line-height:1.2; vertical-align:middle;">${sticker.job_no || "--"}</td>
        </tr>

        ${hasCustCode ? `
        <!-- CUST. CODE -->
        <tr>
          <td style="font-weight:700; font-size:11px; padding:4px 6px; vertical-align:middle; white-space:nowrap;">CUST. CODE</td>
          <td style="font-weight:700; font-size:11px; padding:4px 0; text-align:center; vertical-align:middle;">:</td>
          <td style="font-size:14px; font-weight:500; padding:4px 8px; line-height:1.2; vertical-align:middle;">${resolvedCustCode}</td>
        </tr>
        ` : ""}

      </tbody>
    </table>
  </div>
  `;
};

// ─── Forwarding note bill (print / save as PDF from browser) ─────────────
const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const fmtBillNum = (n) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-IN"));

/** Plain integer for qty columns (no thousands separators). */
const fmtQtyPlain = (n) => {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return String(Math.round(num));
};

/** DD/MM/YY — matches handwritten forwarding note style */
const fmtBillShortDate = (d) => {
  if (!d) return "—";
  try {
    const x = new Date(d);
    const day = String(x.getDate()).padStart(2, "0");
    const mo = String(x.getMonth() + 1).padStart(2, "0");
    const yr = String(x.getFullYear()).slice(-2);
    return `${day}/${mo}/${yr}`;
  } catch {
    return String(d);
  }
};

/**
 * Print-ready forwarding note — layout aligned with classic handwritten FN
 * (company header, FORWARDING NOTE title, S.No./Date/Customer, 6-column grid, dotted footer).
 * @param {object} note - `findForwardingNote` row (includes `items` with `breakdowns`)
 * @param {object} companyInfo - optional `{ name, address, gstin?, phone? }`
 */
export const buildForwardingNoteBillDocument = (note, companyInfo = {}) => {
  const companyName = companyInfo?.name || "H. P. FASTENERS PVT. LTD.";
  const companyAddr = companyInfo?.address || "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005";
  const gstin = companyInfo?.gstin || "";
  const phone = companyInfo?.phone || "Customer Care: info@jflindia.com";
  const items = Array.isArray(note.items) ? note.items : [];

  let sr = 0;
  const rowChunks = [];
  let grandTotal = 0;
  let sumBoxCount = 0;

  for (const grp of items) {
    const breakdowns = Array.isArray(grp.breakdowns) ? grp.breakdowns : [];
    for (const line of breakdowns) {
      sr += 1;
      const lineQty = Math.round(Number(line.total_qty || 0));
      if (Number.isFinite(lineQty)) grandTotal += lineQty;
      sumBoxCount += Number(line.box || 0) + Number(line.loose_box || 0);
      const hpCode = escapeHtml(grp.item_code || line.item_code || "—");
      const pkgNo = escapeHtml(line.packing_number || "—");
      const pkgDate = fmtBillShortDate(line.created_at || line.updated_at);
      const qtyCell = fmtQtyPlain(line.total_qty);
      rowChunks.push(`
        <tr>
          <td class="fn-td fn-c">${sr}</td>
          <td class="fn-td fn-l">${hpCode}</td>
          <td class="fn-td fn-c">${pkgNo}</td>
          <td class="fn-td fn-c">${escapeHtml(pkgDate)}</td>
          <td class="fn-td fn-r">${qtyCell}</td>
          <td class="fn-td fn-r fn-bold">${qtyCell}</td>
        </tr>`);
    }
  }

  grandTotal = Math.round(grandTotal);
  if (!rowChunks.length) {
    rowChunks.push(`
      <tr><td colspan="6" class="fn-td fn-c" style="padding:10px;font-style:italic;">No line items on this document.</td></tr>`);
  } else {
    const gt = fmtQtyPlain(grandTotal);
    rowChunks.push(`
      <tr class="fn-tr-total">
        <td colspan="4" class="fn-td fn-total-lbl">Total</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${gt}</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${gt}</td>
      </tr>`);
  }

  const docDateShort = fmtBillShortDate(note.timestamp || note.created_at);
  const challanNo = String(note.fuid ?? "");
  const partyName = escapeHtml(note.acc_name || "—");
  const billNo = escapeHtml(note.bill_no || "—");
  const transport = escapeHtml(note.transporter_name || "");
  const transportId = escapeHtml(note.transporter_id || "");
  const vehicle = escapeHtml(note.vehicle_number || "");
  const cartageStr =
    note.cartage != null && note.cartage !== "" ? fmtBillNum(note.cartage) : "";
  const remarks = note.remarks ? escapeHtml(String(note.remarks)) : "";
  const boxesDisplay =
    sumBoxCount > 0
      ? String(sumBoxCount)
      : note.total_items != null && note.total_items !== ""
        ? String(note.total_items)
        : "";

  const logoBlock = logoBase64
    ? `<img class="fn-logo-img" src="${logoBase64}" alt="" />`
    : `<div class="fn-logo-fallback" aria-hidden="true">JFL</div>`;

  const gstLine = gstin ? `<div class="fn-co-sub">GSTIN : ${escapeHtml(gstin)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Forwarding Note ${escapeHtml(challanNo)}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm 10mm 10mm 10mm; }
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
    .fn-sheet {
      width: 100%;
      max-width: 190mm;
      margin: 0 auto;
    }
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
      margin-bottom: 0;
    }
    .fn-logo-cell {
      flex: 0 0 20mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fn-head-main {
      flex: 1;
      min-width: 0;
      text-align: center;
    }
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
      font-weight: 900; font-size: 8pt; letter-spacing: -0.5px;
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
    .fn-co-sub { text-align: center; font-size: 8.5pt; margin-top: 1.5mm; line-height: 1.35; color: #000; }
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
      font-size: 10.5pt;
      line-height: 1.45;
      word-break: break-word;
    }
    .fn-meta-cust .k { font-weight: 700; margin-right: 2mm; }
    .fn-cust-name { font-weight: 600; }
    .fn-tbl-wrap { margin-top: 0; flex: 1; }
    .fn-tbl { width: 100%; border-collapse: collapse; font-size: 10pt; table-layout: fixed; }
    .fn-tbl thead th {
      border: 1px solid #000;
      padding: 5px 4px;
      font-weight: 700;
      text-align: center;
      background: #fff;
      color: #000;
      border-bottom: 2px solid #000;
    }
    .fn-td {
      border: 1px solid #000;
      padding: 4px 5px;
      vertical-align: middle;
    }
    .fn-blank .fn-td { height: 4mm; }
    .fn-c { text-align: center; }
    .fn-l { text-align: left; }
    .fn-r { text-align: right; font-variant-numeric: tabular-nums; }
    .fn-bold { font-weight: 700; }
    .fn-col-sn { width: 8%; }
    .fn-col-code { width: 24%; }
    .fn-col-pkg { width: 16%; }
    .fn-col-dt { width: 16%; }
    .fn-col-qty { width: 18%; }
    .fn-tr-total td { border-top: 2px solid #000; }
    .fn-total-lbl {
      text-align: right;
      font-weight: 700;
      padding: 6px 8px;
      letter-spacing: 0.02em;
    }
    .fn-total-num { font-size: 10.5pt; padding: 6px 6px; }
    .fn-foot-wrap { margin-top: 3mm; page-break-inside: avoid; }
    .fn-foot { width: 100%; border-collapse: collapse; font-size: 10pt; table-layout: fixed; }
    .fn-foot td { padding: 5px 6px 6px; vertical-align: bottom; }
    .fn-fg-lbl {
      font-weight: 700;
      white-space: normal;
      width: 32%;
      max-width: 42mm;
      padding-right: 10px;
      padding-left: 2px;
      vertical-align: bottom;
      line-height: 1.25;
      hyphens: manual;
    }
    .fn-fg-cell { width: 18%; vertical-align: bottom; }
    .fn-fg-full { vertical-align: bottom; padding-left: 4px; }
    .fn-under {
      display: block;
      border-bottom: 1px dotted #000;
      min-height: 1.35em;
      padding: 2px 4px 3px 6px;
      word-break: break-word;
      overflow: visible;
      text-align: left;
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
      <div class="fn-head-row">
        <div class="fn-logo-cell">${logoBlock}</div>
        <div class="fn-head-main">
          <div class="fn-co-name">${escapeHtml(companyName)}</div>
          <div class="fn-fn-title">Forwarding Note</div>
          <div class="fn-co-sub">${escapeHtml(companyAddr)}</div>
          ${gstLine}
          <div class="fn-co-sub">${escapeHtml(phone)}</div>
        </div>
      </div>

      <div class="fn-meta-bar">
        <div class="fn-meta-row">
          <div><span class="k">S. No.</span> ${escapeHtml(challanNo)}</div>
          <div class="fn-meta-date"><span class="k">Date</span> ${escapeHtml(docDateShort)}</div>
        </div>
        <div class="fn-meta-cust"><span class="k">Customer</span> <span class="fn-cust-name">${partyName}</span></div>
      </div>

      <div class="fn-body-stack">
        <div class="fn-tbl-wrap">
          <table class="fn-tbl" cellspacing="0">
            <thead>
              <tr>
                <th class="fn-col-sn">S. No.</th>
                <th class="fn-col-code">H. P. Code</th>
                <th class="fn-col-pkg">Packing No.</th>
                <th class="fn-col-dt">Packing Date</th>
                <th class="fn-col-qty">Qty.</th>
                <th class="fn-col-qty">Total Qty.</th>
              </tr>
            </thead>
            <tbody>${rowChunks.join("")}</tbody>
          </table>
        </div>

        <div class="fn-foot-wrap">
          <table class="fn-foot" cellspacing="0">
            <colgroup><col style="width:32%" /><col style="width:18%" /><col style="width:18%" /><col style="width:32%" /></colgroup>
            <tr>
              <td class="fn-fg-lbl">BOXES</td>
              <td class="fn-fg-cell"><span class="fn-under">${escapeHtml(boxesDisplay)}</span></td>
              <td class="fn-fg-lbl">WEIGHT</td>
              <td class="fn-fg-cell"><span class="fn-under">&#160;</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">CARTAGE</td>
              <td class="fn-fg-full" colspan="3"><span class="fn-under">${escapeHtml(cartageStr)}</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">TRANSPORTER NAME</td>
              <td class="fn-fg-full" colspan="3"><span class="fn-under">${transport}</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">TRANSPORTER ID</td>
              <td class="fn-fg-full" colspan="3"><span class="fn-under">${transportId || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">VEHICLE NO</td>
              <td class="fn-fg-full" colspan="3"><span class="fn-under">${vehicle}</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">Bill No.</td>
              <td class="fn-fg-cell"><span class="fn-under">${billNo !== "—" ? billNo : "&#160;"}</span></td>
              <td class="fn-fg-lbl">Bill Made by</td>
              <td class="fn-fg-cell"><span class="fn-under">&#160;</span></td>
            </tr>
            <tr>
              <td class="fn-fg-lbl">Forwarded By</td>
              <td class="fn-fg-full" colspan="3"><span class="fn-under">&#160;</span></td>
            </tr>
          </table>
          ${remarks ? `<div class="fn-remarks"><strong>Remarks :</strong> ${remarks}</div>` : ""}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
};


// ─── Helper: sanitize search string ──────────────────────────────
export const sanitizeSearch = (val) => typeof val === "string" ? val.trim().slice(0, 100) : undefined;

// ─── Helper: format permissions array ────────────────────────────
export const formatPermissions = (permissions) =>
  Object.entries(permissions).map(([moduleId, perms]) => ({
    module_id:     Number(moduleId),
    can_view:      perms.can_view      || false,
    can_view_days: perms.can_view_days || 0,
    can_add:       perms.can_add       || false,
    can_edit:      perms.can_edit      || false,
    can_edit_days: perms.can_edit_days || 0,
    can_delete:    perms.can_delete    || false,
    can_authorize: perms.can_authorize || false,
  }));

// ─── Helper: clean permission response ───────────────────────────
export const cleanPermissionMap = (p) => ({
  module_id:     p.module_id,
  module_name:   p.module_name,
  module_label:  p.module_label,
  module_is_active: p.module_is_active,
  can_view:      p.can_view,
  can_view_days: p.can_view_days,
  can_add:       p.can_add,
  can_edit:      p.can_edit,
  can_edit_days: p.can_edit_days,
  can_delete:    p.can_delete,
  can_authorize: p.can_authorize,
});
