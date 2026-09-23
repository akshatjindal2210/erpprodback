import QRCode from "qrcode";
import { docNoFromStandardBoxNoUid } from "../../../../ims/lib/stickerUidHelpers.js";
import { getAppConfigValue, getStickerCompanyInfo, APP_CONFIG_KEYS } from "../../../configuration/models/appConfig.model.js";
import { getPrintLogoDataUrl, getPrintLogoBlock, buildPrintLogoCss } from "../print/printLogo.js";

export function resolveStickerPackingNumber(sticker = {}, fallback = null) {
  const candidates = [
    sticker?.packing_number,
    sticker?.package_no,
    sticker?.doc_no,
    fallback,
    docNoFromStandardBoxNoUid(sticker?.box_no_uid),
  ];
  for (const c of candidates) {
    const s = c != null ? String(c).trim() : "";
    if (s) return s;
  }
  return null;
}

const DOC_DATE_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Packing entry doc_dt → DD/MM/YYYY (sticker PACKING DT.; matches frontend formatDocDate). */
export function formatDocDate(v) {
  if (v == null || String(v).trim() === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${String(v.getDate()).padStart(2, "0")}/${String(v.getMonth() + 1).padStart(2, "0")}/${v.getFullYear()}`;
  }
  const s = String(v).trim();
  if (/invalid/i.test(s)) return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(s);
  if (iso) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    }
  }
  const monTok = /^(\d{1,2})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{4})$/i.exec(s);
  if (monTok) {
    const day = parseInt(monTok[1], 10);
    const year = parseInt(monTok[3], 10);
    const monIdx = DOC_DATE_MON.findIndex((x) => x.toLowerCase() === monTok[2].toLowerCase());
    if (monIdx >= 0 && day >= 1 && day <= 31 && year > 0) {
      return `${String(day).padStart(2, "0")}/${String(monIdx + 1).padStart(2, "0")}/${year}`;
    }
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return `${String(parsed.getDate()).padStart(2, "0")}/${String(parsed.getMonth() + 1).padStart(2, "0")}/${parsed.getFullYear()}`;
  }
  return s;
}

/** Resolve packing doc date from sticker row (dailyprod / IMS), not box created_at. */
export function resolveStickerDocDt(sticker = {}) {
  const raw =
    sticker?.doc_dt ??
    sticker?.docdt ??
    sticker?.Doc_Dt ??
    sticker?.["Doc Dt"] ??
    null;
  if (raw == null || String(raw).trim() === "") return null;
  return raw;
}

export function formatStickerPackingDate(sticker = {}) {
  return formatDocDate(resolveStickerDocDt(sticker)) ?? "--";
}

const logoBase64 = getPrintLogoDataUrl();

const escapeHtmlText = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sanitizePrintFilenamePart = (s) =>
  String(s ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-");

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

export const buildStickerCardHtml = async (sticker) => {
  const company = await getStickerCompanyInfo();
  const qrObject = await resolveStickerQrPayload(sticker);

  let qrUrl = "";
  try {
    qrUrl = await QRCode.toDataURL(qrObject, { width: 240, margin: 0, color: { dark: "#000000", light: "#ffffff" } });
  } catch (err) {
    qrUrl = "";
  }

  const packingDate = formatStickerPackingDate(sticker);

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
          <td style="font-size:${detailValueSize}px; font-weight:500; padding:${detailPadY}px 8px; line-height:1.2; word-break:break-word; vertical-align:middle;">${resolveStickerPackingNumber(sticker) || "--"}</td>
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

/** DD/MM/YY — packing doc_dt for bill print (not row created_at). */
const fmtBillPackingDate = (line) => {
  const formatted = formatDocDate(resolveStickerDocDt(line));
  if (!formatted) return "—";
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(formatted);
  if (m) return `${m[1]}/${m[2]}/${m[3].slice(-2)}`;
  return formatted;
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

/** Split comma-separated values into deduped list. */
const parseBillNoList = (raw) => {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (!s.includes(",")) return [s];
  const seen = new Set();
  const out = [];
  for (const part of s.split(",")) {
    const v = part.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

/**
 * Print footer bill meta — DB saved bill only (ims_forwarding_note_item_wise.bill_no / bill_dt).
 * Live invfnote list merge (billno) is ignored on print.
 */
const collectPrintBillMeta = (note = {}) => {
  const bills = [];
  const dates = [];
  let maker = null;
  let at = null;
  const billSeen = new Set();
  const dateSeen = new Set();
  let atMs = 0;

  for (const grp of note.items || []) {
    for (const line of grp.breakdowns || []) {
      const bill = String(line?.line_bill_no || line?.bill_no || "").trim();
      if (bill && !billSeen.has(bill)) {
        billSeen.add(bill);
        bills.push(bill);
      }

      const dt = String(line?.line_bill_dt || line?.bill_dt || "").trim();
      if (dt && !dateSeen.has(dt)) {
        dateSeen.add(dt);
        dates.push(dt);
      }

      const lineMaker = String(
        line?.bill_updated_by_name || line?.line_bill_updated_by || line?.bill_updated_by || ""
      ).trim();
      const lineAt = line?.line_bill_updated_at || line?.bill_updated_at || null;
      const lineAtMs = lineAt ? new Date(lineAt).getTime() : 0;
      if (Number.isFinite(lineAtMs) && lineAtMs >= atMs) {
        atMs = lineAtMs;
        at = lineAt;
        if (lineMaker) maker = lineMaker;
      } else if (!maker && lineMaker) {
        maker = lineMaker;
      }
    }
  }

  return { bills, dates, maker, at };
};

/** Print HTML — comma-separated; each value never wraps mid-token. */
const formatBillNosPrintHtml = (bills) => {
  const list = Array.isArray(bills) ? bills : parseBillNoList(bills);
  if (!list.length) return "";
  return list .map((bill) => `<span class="fn-bill-one">${escapeHtml(bill)}</span>`).join('<span class="fn-bill-sep">, </span>');
};

const fmtBillAtPrint = (d) => {
  if (!d) return "";
  try {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return String(d);
    const hh = String(x.getHours()).padStart(2, "0");
    const mm = String(x.getMinutes()).padStart(2, "0");
    return `${fmtBillShortDate(x)} ${hh}:${mm}`;
  } catch {
    return String(d);
  }
};

/**
 * Print-ready forwarding note — layout aligned with classic handwritten FN
 * (company header, FORWARDING NOTE title, S.No./Date/Customer, 6-column grid: each packing
 * on its own row under one S.No.; item total in Total Qty. on the last packing row, dotted footer).
 * @param {object} note - `findForwardingNote` row (includes `items` with `breakdowns`)
 * @param {object} companyInfo - optional `{ name, address, gstin?, phone? }`
 */
export const buildForwardingNoteBillDocument = (note, companyInfo = {}) => {
  const companyName = companyInfo?.name || "H. P. FASTENERS PVT. LTD.";
  const companyAddr = companyInfo?.address || "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005";
  const gstin = companyInfo?.gstin || "";
  const phone = companyInfo?.phone || "";
  const email = companyInfo?.email || "info@jflindia.com";
  const contactLine = `Customer Care: ${phone || email || "info@jflindia.com"}`;
  const items = Array.isArray(note.items) ? note.items : [];

  let itemSr = 0;
  const rowChunks = [];
  let grandTotal = 0;
  let sumBoxCount = 0;

  for (const grp of items) {
    const breakdowns = Array.isArray(grp.breakdowns) ? grp.breakdowns : [];
    if (!breakdowns.length) continue;

    itemSr += 1;
    const hpCode = escapeHtml(grp.item_code || breakdowns[0]?.item_code || "—");
    const schNo = escapeHtml(grp.schno || breakdowns[0]?.schno || "—");
    const itemTotal = Math.round(
      Number(grp.total_qty) ||
        breakdowns.reduce((sum, line) => sum + Math.round(Number(line.total_qty || 0)), 0)
    );
    const multiPacking = breakdowns.length > 1;
    const lastIdx = breakdowns.length - 1;

    breakdowns.forEach((line, idx) => {
      const lineQty = Math.round(Number(line.total_qty || 0));
      if (Number.isFinite(lineQty)) grandTotal += lineQty;
      sumBoxCount += Number(line.box || 0) + Number(line.loose_box || 0);
      const pkgNo = escapeHtml(line.packing_number || "—");
      const pkgDate = fmtBillPackingDate(line);
      const qtyCell = fmtQtyPlain(line.total_qty);
      const isFirst = idx === 0;
      const isLast = idx === lastIdx;
      const snCell = isFirst ? String(itemSr) : "&#160;";
      const codeCell = isFirst ? hpCode : "&#160;";
      const schNoCell = isFirst ? schNo : "&#160;";
      let totalQtyCell;
      if (!multiPacking) {
        totalQtyCell = `<td class="fn-td fn-r fn-bold">${qtyCell}</td>`;
      } else if (isLast) {
        totalQtyCell = `<td class="fn-td fn-r fn-bold">${fmtQtyPlain(itemTotal)}</td>`;
      } else {
        totalQtyCell = `<td class="fn-td fn-c">&#160;</td>`;
      }
      const rowClass = !isFirst && multiPacking ? ` class="fn-tr-pack"` : "";
      rowChunks.push(`
        <tr${rowClass}>
          <td class="fn-td fn-c">${snCell}</td>
          <td class="fn-td fn-l">${codeCell}</td>
          <td class="fn-td fn-c">${schNoCell}</td>
          <td class="fn-td fn-c">${pkgNo}</td>
          <td class="fn-td fn-c">${escapeHtml(pkgDate)}</td>
          <td class="fn-td fn-r">${qtyCell}</td>
          ${totalQtyCell}
        </tr>`);
    });
  }

  grandTotal = Math.round(grandTotal);
  if (!rowChunks.length) {
    rowChunks.push(`
      <tr><td colspan="7" class="fn-td fn-c" style="padding:10px;font-style:italic;">No line items on this document.</td></tr>`);
  } else {
    const gt = fmtQtyPlain(grandTotal);
    rowChunks.push(`
      <tr class="fn-tr-total">
        <td colspan="5" class="fn-td fn-total-lbl">Total</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${gt}</td>
        <td class="fn-td fn-r fn-bold fn-total-num">${gt}</td>
      </tr>`);
  }

  const docDateShort = fmtBillShortDate(note.timestamp || note.created_at);
  const challanNo = String(note.fuid ?? "");
  const partyName = escapeHtml(note.acc_name || "—");
  const poNumber = escapeHtml(String(note.po_number ?? "").trim() || "—");
  const { bills: printBills, dates: printDates, maker: printMaker, at: printAt } = collectPrintBillMeta(note);
  const billNoHtml = formatBillNosPrintHtml(printBills);
  const billDateHtml = formatBillNosPrintHtml(printDates);
  const billMadeByHtml = printMaker ? escapeHtml(printMaker) : "";
  const billAtHtml = printAt ? escapeHtml(fmtBillAtPrint(printAt)) : "";
  const forwardedByHtml = escapeHtml(
    String(note.created_by_name || note.created_by || "").trim()
  );
  const forwardedAtHtml = escapeHtml(
    fmtBillAtPrint(note.created_at || note.timestamp || "")
  );
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

  const logoBlock = getPrintLogoBlock();

  const gstLine = gstin ? `<div class="fn-co-sub">GSTIN : ${escapeHtml(gstin)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Forwarding Note ${escapeHtml(challanNo)}</title>
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
    ${buildPrintLogoCss()}
    .fn-head-main {
      flex: 1;
      min-width: 0;
      text-align: center;
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
    .fn-tr-pack .fn-td { border-top: 1px dotted #bbb; }
    .fn-col-sn { width: 7%; }
    .fn-col-code { width: 20%; }
    .fn-col-sch { width: 11%; }
    .fn-col-pkg { width: 14%; }
    .fn-col-dt { width: 14%; }
    .fn-col-qty { width: 17%; }
    .fn-tr-total td { border-top: 2px solid #000; }
    .fn-total-lbl {
      text-align: right;
      font-weight: 700;
      padding: 6px 8px;
      letter-spacing: 0.02em;
    }
    .fn-total-num { font-size: 10.5pt; padding: 6px 6px; }
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
    .fn-bill-stack {
      line-height: 1.45;
      white-space: normal;
      word-break: normal;
      overflow-wrap: normal;
    }
    .fn-bill-one {
      display: inline;
      white-space: nowrap;
      word-break: keep-all;
    }
    .fn-bill-sep { white-space: nowrap; }
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
                <td colspan="7">
                  <div class="fn-border">
                    <div class="fn-head-row">
                      <div class="fn-logo-cell">${logoBlock}</div>
                      <div class="fn-head-main">
                        <div class="fn-co-name">${escapeHtml(companyName)}</div>
                        <div class="fn-fn-title">Forwarding Note</div>
                        <div class="fn-co-sub">${escapeHtml(companyAddr)}</div>
                        ${gstLine}
                        <div class="fn-co-sub">${escapeHtml(contactLine)}</div>
                      </div>
                      <div class="fn-logo-cell" aria-hidden="true"></div>
                    </div>
                    <div class="fn-meta-bar">
                      <div class="fn-meta-row">
                        <div><span class="k">S. No.</span> ${escapeHtml(challanNo)}</div>
                        <div class="fn-meta-date"><span class="k">Date</span> ${escapeHtml(docDateShort)}</div>
                      </div>
                      <div class="fn-meta-cust"><span class="k">Customer</span> <span class="fn-cust-name">${partyName}</span></div>
                    </div>
                  </div>
                </td>
              </tr>
              <tr>
                <th class="fn-col-sn">S. No.</th>
                <th class="fn-col-code">H. P. Code</th>
                <th class="fn-col-sch">Schedule No.</th>
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
            <colgroup>
              <col style="width:24%" />
              <col style="width:26%" />
              <col style="width:24%" />
              <col style="width:26%" />
            </colgroup>
            <tr>
              <td class="fn-fl">BOXES</td>
              <td class="fn-fv"><span class="fn-under">${escapeHtml(boxesDisplay) || "&#160;"}</span></td>
              <td class="fn-fl">WEIGHT</td>
              <td class="fn-fv fn-fv-last"><span class="fn-under">&#160;</span></td>
            </tr>
            <tr>
              <td class="fn-fl">CARTAGE</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${escapeHtml(cartageStr) || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">PO NUMBER</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${poNumber}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">TRANSPORTER NAME</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${transport || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">TRANSPORTER ID</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${transportId || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">VEHICLE NO</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under">${vehicle || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">Bill No.</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under fn-bill-stack">${billNoHtml || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">Bill Date</td>
              <td class="fn-fv fn-fv-last" colspan="3"><span class="fn-under fn-bill-stack">${billDateHtml || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">Bill Made by</td>
              <td class="fn-fv"><span class="fn-under">${billMadeByHtml || "&#160;"}</span></td>
              <td class="fn-fl">Bill At</td>
              <td class="fn-fv fn-fv-last"><span class="fn-under">${billAtHtml || "&#160;"}</span></td>
            </tr>
            <tr>
              <td class="fn-fl">Forwarded By</td>
              <td class="fn-fv"><span class="fn-under">${forwardedByHtml || "&#160;"}</span></td>
              <td class="fn-fl">Forwarded At</td>
              <td class="fn-fv fn-fv-last"><span class="fn-under">${forwardedAtHtml || "&#160;"}</span></td>
            </tr>
          </table>
          ${remarks ? `<div class="fn-remarks"><strong>Remarks :</strong> ${remarks}</div>` : ""}
        </div>
      </div>
    </div>
  </div>
  <div class="fn-page-count" aria-hidden="true"></div>
</body>
</html>`;
};


export const sanitizeSearch = (val) => typeof val === "string" ? val.trim().slice(0, 100) : undefined;

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

export const cleanPermissionMap = (p) => ({
  module_id:     p.module_id,
  module_name:   p.module_name,
  module_label:  p.module_label,
  module_app_type: p.module_app_type,
  module_is_active: p.module_is_active,
  can_view:      p.can_view,
  can_view_days: p.can_view_days,
  can_add:       p.can_add,
  can_edit:      p.can_edit,
  can_edit_days: p.can_edit_days,
  can_delete:    p.can_delete,
  can_authorize: p.can_authorize,
});
