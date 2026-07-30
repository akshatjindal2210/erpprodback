/**
 * RM Coil sticker print design — separate from IMS box stickers.
 * Visual layout is portrait (100mm × 150mm) as used by RM MRN stickers.
 */
import QRCode from "qrcode";
import { findSpecItemDetail } from "../../modules/spec/models/specMaster.model.js";

const STICKER_WIDTH_MM = 100;
const STICKER_HEIGHT_MM = 150;
const STICKER_SIZE_MM = `${STICKER_WIDTH_MM}mm ${STICKER_HEIGHT_MM}mm`;

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

const DUMMY_STICKER_VALUES = Object.freeze({
  item_code: "PD-04",
  top_date: "A-3-Jan-23",
  grade: "MIX GRADE (SHORT COIL) F4",
  base_size: "5.50 mm",
  finish_size: "2.38 mm",
  condition: "HRP COAT",
  next_process: "FAD",
  next_department: "BY PASS",
  work_order_no: "IF227-0003",
  customer: "FINE WIRE",
  operator_code: "1853",
  operator_name: "RAM GOPAL",
  lot_no: "BA-27 ONLY",
  right_panel_code: "BW/LC/25",
  coil_no_uid: "26_3701_1_01_01",
  qr_fallback_uid: "26_3701_1_01_01",
  qty: 525,
  unit: "KGS",
});

function withDummy(value, fallback) {
  const s = value == null ? "" : String(value).trim();
  return s ? s : fallback;
}

/** Preview uses layout placeholders; real prints show "—" when a field is missing. */
function displayField(value, fallback, { preview = false } = {}) {
  const s = value == null ? "" : String(value).trim();
  if (s && s !== "—") return s;
  return preview ? fallback : "—";
}

const formatStickerTopDate = (v) => {
  if (v == null || String(v).trim() === "") return "--";
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  }
  const s = String(v).trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const mon = Number(m[2]);
    const year = m[3];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day}-${months[Math.max(0, Math.min(11, mon - 1))]}-${year.slice(-2)}`;
  }
  return s;
};

/** Map MRN + coil (or preview sample) → print-row fields used by the design.
 *  Preview (no real coil uid / sa) may fill dummy layout placeholders.
 *  Real coils (MRN or Stock Adjustment) use live fields; missing → "—".
 */
export function mapCoilToStickerPrintRow(coil = {}, mrn = {}, opts = {}) {
  const hasRealCoil =
    Boolean(coil.coil_uid) ||
    Boolean(coil.sa_id) ||
    Boolean(String(coil.coil_no_uid || "").trim());
  const fillDummy = opts.fillDummy === true || (!hasRealCoil && opts.fillDummy !== false);
  const blank = (val, dummy) => {
    const s = val == null ? "" : String(val).trim();
    if (s) return s;
    return fillDummy ? dummy : "—";
  };

  const qty = Number(coil.qty ?? 0);
  const unit =
    String(coil.it_unit ?? mrn.it_unit ?? "").trim() ||
    (fillDummy ? DUMMY_STICKER_VALUES.unit : "KG");

  const saLabel =
    coil.sa_id != null ? `SA-${coil.sa_id}` : "";
  const packing =
    String(coil.mrn_no ?? mrn.mrn_no ?? "").trim() ||
    saLabel ||
    blank(null, DUMMY_STICKER_VALUES.right_panel_code);

  return {
    acc_name: blank(coil.acc_name ?? mrn.acc_name, DUMMY_STICKER_VALUES.customer),
    item_code: blank(coil.item_code ?? mrn.item_code, DUMMY_STICKER_VALUES.item_code),
    itemdesc: blank(coil.item_desc ?? mrn.item_desc, DUMMY_STICKER_VALUES.grade),
    qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : fillDummy ? DUMMY_STICKER_VALUES.qty : 0,
    unit,
    packing_number: packing,
    doc_dt: coil.mrn_dt ?? mrn.mrn_dt ?? coil.created_at ?? null,
    job_no: blank(coil.heat_no || mrn.it_lot_no, DUMMY_STICKER_VALUES.qr_fallback_uid),
    party_rate_cust_code: null,
    coil_no_uid: blank(coil.coil_no_uid, DUMMY_STICKER_VALUES.coil_no_uid),
    coil_uid: coil.coil_uid ?? null,
    lot_no: blank(coil.it_lot_no ?? mrn.it_lot_no ?? coil.heat_no, DUMMY_STICKER_VALUES.lot_no),
    grade: blank(coil.grade ?? mrn.grade ?? coil.item_desc ?? mrn.item_desc, DUMMY_STICKER_VALUES.grade),
    base_size: blank(coil.base_size ?? mrn.base_size, DUMMY_STICKER_VALUES.base_size),
    finish_size: blank(coil.finish_size ?? mrn.finish_size, DUMMY_STICKER_VALUES.finish_size),
    condition: blank(coil.condition ?? mrn.condition, DUMMY_STICKER_VALUES.condition),
    next_process: blank(coil.next_process ?? mrn.next_process, DUMMY_STICKER_VALUES.next_process),
    next_department: blank(coil.next_department ?? mrn.next_department, DUMMY_STICKER_VALUES.next_department),
    work_order_no: blank(coil.work_order_no ?? mrn.work_order_no, DUMMY_STICKER_VALUES.work_order_no),
    operator_code: blank(coil.operator_code ?? mrn.operator_code, DUMMY_STICKER_VALUES.operator_code),
    operator_name: blank(coil.operator_name ?? mrn.operator_name, DUMMY_STICKER_VALUES.operator_name),
    box_no_uid: coil.coil_no_uid || "",
    box_uid: coil.coil_uid ?? null,
  };
}

/** RM Spec Master → sticker fields (print time only; nothing saved on coil). */
export async function loadSpecStickerFields(item_dcode) {
  const item = Number(item_dcode);
  if (!Number.isFinite(item) || item <= 0) return {};

  const detail = await findSpecItemDetail(item);
  if (!detail) return {};

  const out = {};
  if (detail.grade) out.grade = String(detail.grade).trim();
  if (detail.condition) out.condition = String(detail.condition).trim();
  if (detail.size) out.base_size = String(detail.size).trim();

  for (const line of detail.specs || []) {
    const val = String(line.print_val || "").trim();
    const name = String(line.spec_name || "").trim().toLowerCase();
    if (!val || !name) continue;
    if (name.includes("finish")) out.finish_size = val;
    else if (name.includes("next proc")) out.next_process = val;
    else if (name.includes("next dep")) out.next_department = val;
    else if (name.includes("work order") || name === "wo no") out.work_order_no = val;
    else if (name.includes("op name") || name.includes("operator name")) out.operator_name = val;
    else if (name.includes("op code") || name.includes("operator code")) out.operator_code = val;
    else if (name.includes("base size")) out.base_size = val;
    else if (name.includes("grade")) out.grade = val;
    else if (name.includes("condition")) out.condition = val;
  }

  return out;
}

/** Coil + MRN + optional spec snapshot → print row (pass `spec` in bulk to skip re-fetch). */
export function buildCoilStickerPrintRow(coil = {}, mrn = {}, opts = {}) {
  const spec = opts.spec || {};
  const { isQc = false, ...mapOpts } = opts;
  return {
    ...mapCoilToStickerPrintRow({ ...spec, ...coil }, { ...spec, ...mrn }, mapOpts),
    ...(isQc ? { is_qc: true, sticker_kind: "qc" } : {}),
  };
}

export function buildCoilStickerPrintDocumentTitle(mrnNo) {
  const pn = sanitizePrintFilenamePart(mrnNo);
  return pn ? `MRN No. ${pn}` : "MRN Coil Stickers";
}

export function buildCoilStickerPreviewDocument(cardHtml) {
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
    width: ${STICKER_WIDTH_MM}mm;
    height: ${STICKER_HEIGHT_MM}mm;
    overflow: hidden;
    background: #edecec45;
    box-sizing: border-box;
  }
  body {
    display: block;
    line-height: 1.2;
  }
  body > div {
    width: ${STICKER_WIDTH_MM}mm;
    height: ${STICKER_HEIGHT_MM}mm;
    box-sizing: border-box;
  }
  #html-content-holder{
    display:grid;
    grid-template-rows: 7mm 16mm 12mm 12mm 12mm 12mm 12mm minmax(0,1fr);
  }
  #html-content-holder *{ box-sizing:border-box; color:#000; }
  .st-row{ display:flex; min-height:0; }
  .st-box{ border:0.3px solid #000; border-top:none; }
  .st-box.first{ border-top:0.3px solid #000; }
  .st-col6{ width:50%; min-width:0; padding:0.8mm 1.4mm; }
  .st-col6.l{ border-right:0.3px solid #000; }
  .st-col12{ width:100%; min-width:0; padding:0.8mm 1.4mm; }
  .st-label{ font-size:8px; margin:0; line-height:1; font-weight:500; }
  .st-val{
    display:block;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:clip;
    line-height:1;
  }
  .st-head{ font-size:5.2mm; font-weight:900; margin-top:0.8mm; }
  .st-h2{ font-size:4.3mm; font-weight:700; margin-top:0.8mm; }
  .st-mid{ font-size:4.8mm; font-weight:700; margin-top:0.6mm; }
  .st-small{ font-size:3.5mm; font-weight:700; margin-top:0.6mm; }
  .st-bottom{
    display:flex;
    min-height:0;
  }
  .st-left{
    width:50%;
    border-right:0.3px solid #000;
    display:grid;
    grid-template-rows: 20mm 18mm minmax(0,1fr);
    min-height:0;
  }
  .st-left-cell{ padding:0.8mm 1.4mm; min-height:0; overflow:hidden; }
  .st-left-cell + .st-left-cell{ border-top:0.3px solid #000; }
  .st-right{
    width:50%;
    padding:0.8mm 1.4mm;
    display:flex;
    flex-direction:column;
    min-height:0;
  }
  .st-rtop{ font-size:3.8mm; font-weight:600; line-height:1; min-height:4.2mm; }
  .st-qr-wrap{
    flex:1;
    display:flex;
    align-items:flex-start;
    justify-content:center;
    padding-top:1mm;
    overflow:hidden;
  }
</style>
</head>
<body>
${cardHtml}
</body>
</html>`;
}

export function buildCoilStickerPrintDocument(cards = [], { mrn_no } = {}) {
  const title = escapeHtmlText(buildCoilStickerPrintDocumentTitle(mrn_no));
  return `
    <html>
      <head>
        <title>${title}</title>
        <style>
          @page { margin: 0; size: ${STICKER_SIZE_MM}; }
          body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: #edecec45; }
          .sticker-wrap { display: flex; flex-direction: column; align-items: center; width: 100%; }
          .sticker-card {
            page-break-inside: avoid;
            page-break-after: always;
            width: ${STICKER_WIDTH_MM}mm;
            height: ${STICKER_HEIGHT_MM}mm;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
          }
          #html-content-holder{
            display:grid;
            grid-template-rows: 7mm 16mm 12mm 12mm 12mm 12mm 12mm minmax(0,1fr);
          }
          #html-content-holder *{ box-sizing:border-box; color:#000; }
          .st-row{ display:flex; min-height:0; }
          .st-box{ border:0.3px solid #000; border-top:none; }
          .st-box.first{ border-top:0.3px solid #000; }
          .st-col6{ width:50%; min-width:0; padding:0.8mm 1.4mm; }
          .st-col6.l{ border-right:0.3px solid #000; }
          .st-col12{ width:100%; min-width:0; padding:0.8mm 1.4mm; }
          .st-label{ font-size:8px; margin:0; line-height:1; font-weight:500; }
          .st-val{
            display:block;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:clip;
            line-height:1;
          }
          .st-head{ font-size:5.2mm; font-weight:900; margin-top:0.8mm; }
          .st-h2{ font-size:4.3mm; font-weight:700; margin-top:0.8mm; }
          .st-mid{ font-size:4.8mm; font-weight:700; margin-top:0.6mm; }
          .st-small{ font-size:3.5mm; font-weight:700; margin-top:0.6mm; }
          .st-bottom{
            display:flex;
            min-height:0;
          }
          .st-left{
            width:50%;
            border-right:0.3px solid #000;
            display:grid;
            grid-template-rows: 20mm 18mm minmax(0,1fr);
            min-height:0;
          }
          .st-left-cell{ padding:0.8mm 1.4mm; min-height:0; overflow:hidden; }
          .st-left-cell + .st-left-cell{ border-top:0.3px solid #000; }
          .st-right{
            width:50%;
            padding:0.8mm 1.4mm;
            display:flex;
            flex-direction:column;
            min-height:0;
          }
          .st-rtop{ font-size:3.8mm; font-weight:600; line-height:1; min-height:4.2mm; }
          .st-qr-wrap{
            flex:1;
            display:flex;
            align-items:flex-start;
            justify-content:center;
            padding-top:1mm;
            overflow:hidden;
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
}

/**
 * Coil sticker card HTML — same visual structure as IMS box sticker.
 * Change labels/layout here only (does not affect IMS).
 */
async function buildStickerCardHtmlBase(row, { preview = false } = {}) {
  const disp = (value, fallback) => displayField(value, fallback, { preview });

  const uid = disp(row.coil_no_uid || row.box_no_uid, DUMMY_STICKER_VALUES.coil_no_uid);
  const isQc = row.is_qc === true || String(row.sticker_kind || "").toLowerCase() === "qc";
  // QC stickers encode QC|{uid} so inspect gate rejects plain coil / MRN / user scans
  const qrFallback = preview ? DUMMY_STICKER_VALUES.qr_fallback_uid : "";
  const qrPayload = isQc
    ? `QC|${uid || String(row.coil_uid || qrFallback)}`
    : (uid || String(row.coil_uid || qrFallback));

  let qrUrl = "";
  try {
    if (qrPayload) {
      qrUrl = await QRCode.toDataURL(qrPayload, {
        width: 240,
        margin: 0,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  } catch {
    qrUrl = "";
  }

  const accName = escapeHtmlText(disp(row.acc_name, DUMMY_STICKER_VALUES.customer));
  const itemCode = escapeHtmlText(disp(row.item_code, DUMMY_STICKER_VALUES.item_code));
  const lotNo = escapeHtmlText(disp(row.lot_no, DUMMY_STICKER_VALUES.lot_no));
  const rightTopCode = escapeHtmlText(disp(row.packing_number, DUMMY_STICKER_VALUES.right_panel_code));
  const safeQty = Number(row.qty);
  const qtyValue =
    Number.isFinite(safeQty) && safeQty > 0
      ? Math.round(safeQty).toLocaleString()
      : preview
        ? DUMMY_STICKER_VALUES.qty
        : "0";
  const qtyUnit = disp(row.unit, DUMMY_STICKER_VALUES.unit);
  const qtyText = `${qtyValue}${qtyUnit && qtyUnit !== "—" ? ` ${qtyUnit}` : ""}`;
  const grade = escapeHtmlText(disp(row.grade || row.itemdesc, DUMMY_STICKER_VALUES.grade));
  const baseSize = escapeHtmlText(disp(row.base_size, DUMMY_STICKER_VALUES.base_size));
  const finishSize = escapeHtmlText(disp(row.finish_size, DUMMY_STICKER_VALUES.finish_size));
  const condition = escapeHtmlText(disp(row.condition, DUMMY_STICKER_VALUES.condition));
  const nextProcess = escapeHtmlText(disp(row.next_process, DUMMY_STICKER_VALUES.next_process));
  const nextDepartment = escapeHtmlText(disp(row.next_department, DUMMY_STICKER_VALUES.next_department));
  const workOrderNo = escapeHtmlText(disp(row.work_order_no, DUMMY_STICKER_VALUES.work_order_no));
  const operatorCode = escapeHtmlText(disp(row.operator_code, DUMMY_STICKER_VALUES.operator_code));
  const operatorName = escapeHtmlText(disp(row.operator_name, DUMMY_STICKER_VALUES.operator_name));
  const computedTopDate = formatStickerTopDate(row.doc_dt);
  const topDate = escapeHtmlText(
    disp(computedTopDate === "--" ? "" : computedTopDate, DUMMY_STICKER_VALUES.top_date)
  );
  const bannerText = isQc ? (preview ? "QC PREVIEW" : "QC STICKER") : "";
  const qcBanner = isQc
    ? preview
      ? `<div style="width:100%;box-sizing:border-box;background:#b45309;color:#fff;text-align:center;padding:1.8mm 2mm;font-size:4.4mm;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;line-height:1.1;border-bottom:1px solid #000;">${bannerText}</div>`
      : `<div style="width:100%;box-sizing:border-box;background:#111;color:#fff;text-align:center;padding:1.6mm 2mm;font-size:4.2mm;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;line-height:1.1;border-bottom:1px solid #000;">${bannerText}</div>`
    : "";

  return `
  <div id="html-content-holder" style="background-color:#edecec45;width:${STICKER_WIDTH_MM}mm;height:${STICKER_HEIGHT_MM}mm;border:1px solid #000;box-sizing:border-box;font-family:Arial,sans-serif;color:#000;overflow:hidden;">
      ${qcBanner}
      <div class="st-row st-box first">
        <div class="st-col6 l">
          <span class="st-val st-small">${itemCode}</span>
        </div>
        <div class="st-col6">
          <span class="st-val st-small">${topDate}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col12">
          <p class="st-label">Grade</p>
          <span class="st-val st-head">${grade}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col6 l">
          <p class="st-label">Base Size</p>
          <span class="st-val st-h2">${baseSize}</span>
        </div>
        <div class="st-col6">
          <p class="st-label">Finish Size</p>
          <span class="st-val st-h2">${finishSize}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col12">
          <p class="st-label">Condition</p>
          <span class="st-val st-h2">${condition}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col6 l">
          <p class="st-label">Next Proc.</p>
          <span class="st-val st-mid">${nextProcess}</span>
        </div>
        <div class="st-col6">
          <p class="st-label">Next Dep.</p>
          <span class="st-val st-mid">${nextDepartment}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col6 l">
          <p class="st-label">Wo No</p>
          <span class="st-val st-mid">${workOrderNo}</span>
        </div>
        <div class="st-col6">
          <p class="st-label">Customer</p>
          <span class="st-val st-mid">${accName}</span>
        </div>
      </div>
      <div class="st-row st-box">
        <div class="st-col6 l">
          <p class="st-label">Op. Code</p>
          <span class="st-val st-mid">${operatorCode}</span>
        </div>
        <div class="st-col6">
          <p class="st-label">Op. Name</p>
          <span class="st-val st-mid">${operatorName}</span>
        </div>
      </div>
      <div class="st-row st-box st-bottom">
        <div class="st-left">
          <div class="st-left-cell">
            <p class="st-label">Lot No</p>
            <span class="st-val st-mid">${lotNo}</span>
          </div>
          <div class="st-left-cell">
            <p class="st-label">Coil No</p>
            <span class="st-val st-small">${escapeHtmlText(disp(uid, DUMMY_STICKER_VALUES.coil_no_uid))}</span>
          </div>
          <div class="st-left-cell">
            <p class="st-label">Wt.(Kg)</p>
            <span class="st-val st-mid">${escapeHtmlText(qtyText)}</span>
          </div>
        </div>
        <div class="st-right">
          <div class="st-val st-rtop">${rightTopCode}</div>
          <div class="st-qr-wrap">
          ${qrUrl
            ? `<img src="${qrUrl}" alt="${escapeHtmlText(uid || DUMMY_STICKER_VALUES.qr_fallback_uid)}" width="118" height="118" style="display:block;" />`
            : `<div style="width:118px;height:118px;border:1px solid #000;display:flex;align-items:center;justify-content:center;">QR N/A</div>`
          }
          </div>
        </div>
      </div>
  </div>
  `;
}

/**
 * Preview card HTML.
 * Keep this separate from the print sticker builder so preview can diverge safely.
 */
export async function buildCoilStickerPreviewCardHtml(row) {
  return buildStickerCardHtmlBase(row, { preview: true });
}

/**
 * Printable sticker card HTML.
 * Keep this separate from the preview builder so print changes do not affect preview.
 */
export async function buildCoilStickerCardHtml(row) {
  return buildStickerCardHtmlBase(row, { preview: false });
}
