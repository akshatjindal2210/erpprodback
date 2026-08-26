/**
 * RM coil + QC sticker (85×65 mm). One layout for both; only title / QR payload differ.
 *
 * Flow: mrn.routes → coilStickerPrint.controller → buildStickerDocs (here) → HTML
 * Change size → RM_STICKER_*_MM. Change fields/order → LAYOUT.rows / bottomLeft.
 * Change QR / caption under QR → LAYOUT.qr
 */
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { findSpecItemDetail, findSpecItemDetailByItemCode, findSpecItemDetailByItemDesc } from "../../modules/spec/models/specMaster.model.js";

export const RM_STICKER_WIDTH_MM = 65;
export const RM_STICKER_HEIGHT_MM = 85;

export function rmStickerSize() {
  return { width_mm: RM_STICKER_WIDTH_MM, height_mm: RM_STICKER_HEIGHT_MM };
}

const EMPTY = "—";
const W = RM_STICKER_WIDTH_MM;
const H = RM_STICKER_HEIGHT_MM;

/**
 * Edit LAYOUT to change sticker design.
 * - rows / bottomLeft → fields & order
 * - qr → QR size + text under QR (bigger/smaller = change these numbers only)
 */
const LAYOUT = {
  rows: [
    { kind: "header" },
    {
      kind: "split",
      left: { label: "Condition", key: "condition", cls: "st-condition" },
      right: { label: "Color", key: "conditionColor" },
    },
    {
      kind: "split3",
      cols: [
        { label: "Grade", key: "grade", cls: "st-condition", width: "33%" },
        { label: "Color", key: "gradeColor", width: "31%" },
        { label: "Size", key: "size", width: "36%" },
      ],
    },
    { kind: "field", label: "Heat No", key: "lotNo" },
    { kind: "field", label: "Vendor", key: "vendor", wrap: true },
    { kind: "field", label: "Item", key: "itemCode" },
    { kind: "field", label: "Item Description", key: "itemDesc", wrap: true },
    { kind: "bottom" },
    { kind: "footer" },
  ],
  bottomLeft: [
    { label: "MRN UID", key: "mrnUid" },
    { label: "MRN Date", key: "mrnDate" },
    { label: "Coil No", key: "coilNo" },
    { label: "Wt.(Kg)", key: "qty" },
  ],
  meta: {
    align: "left",
  },
  qr: {
    sizeMm: 22,
    captionFontPx: 8.5,
    captionMaxHeightMm: 5,
    captionGapMm: 0.25,
  },
};

// ── helpers ───────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const text = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s && s !== EMPTY ? s : "";
};

const show = (v) => text(v) || EMPTY;

const first = (...vals) => {
  for (const v of vals) {
    const s = text(v);
    if (s) return s;
  }
  return EMPTY;
};

function fmtTs(v) {
  const d = v == null || String(v).trim() === "" ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) return EMPTY;
  const p = (n) => String(n).padStart(2, "0");
  const h24 = d.getHours();
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h24 % 12 || 12)}:${p(d.getMinutes())} ${h24 >= 12 ? "PM" : "AM"}`;
}

function fmtDate(v) {
  const d = v == null || String(v).trim() === "" ? null : new Date(v);
  if (!d || Number.isNaN(d.getTime())) return EMPTY;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function coilIndex(uid) {
  const last = String(uid || "")
    .split("_")
    .filter(Boolean)
    .pop();
  const n = Number(last);
  return Number.isFinite(n) && n > 0 ? String(n) : EMPTY;
}

let logoB64 = null;
try {
  const p = path.join(process.cwd(), "logo.png");
  if (fs.existsSync(p))
    logoB64 = `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
} catch (e) {
  console.error("Error reading logo.png:", e);
}

// ── data mapping ──────────────────────────────────────────────────────────

export function mapCoilToStickerPrintRow(coil = {}, mrn = {}) {
  const qty = Number(coil.qty ?? 0);
  const packing = first(
    coil.mrn_no,
    mrn.mrn_no,
    coil.sa_id != null ? `SA-${coil.sa_id}` : "",
  );
  const unit = first(coil.it_unit, mrn.it_unit, "KG");
  return {
    acc_name: first(coil.acc_name ?? mrn.acc_name),
    item_code: first(coil.item_code ?? mrn.item_code),
    itemdesc: first(coil.item_desc ?? mrn.item_desc),
    qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 0,
    unit: unit === EMPTY ? "KG" : unit,
    mrn_no: packing,
    mrn_uid: first(coil.mrn_uid ?? mrn.uid ?? mrn.mrn_uid),
    packing_number: packing,
    doc_dt: coil.mrn_dt ?? mrn.mrn_dt ?? coil.created_at ?? null,
    coil_no_uid: first(coil.coil_no_uid),
    coil_uid: coil.coil_uid ?? null,
    lot_no: first(coil.it_lot_no ?? mrn.it_lot_no ?? coil.heat_no),
    grade: first(coil.grade ?? mrn.grade),
    base_size: first(coil.base_size ?? mrn.base_size),
    finish_size: first(coil.finish_size ?? mrn.finish_size),
    condition: first(coil.condition ?? mrn.condition),
    next_process: first(coil.next_process ?? mrn.next_process),
    next_department: first(coil.next_department ?? mrn.next_department),
    work_order_no: first(coil.work_order_no ?? mrn.work_order_no),
    operator_code: first(coil.operator_code ?? mrn.operator_code),
    operator_name: first(coil.operator_name ?? mrn.operator_name),
    box_no_uid: text(coil.coil_no_uid) || "",
    box_uid: coil.coil_uid ?? null,
    created_by: first(
      coil.created_by ??
        coil.created_by_name ??
        mrn.created_by_name ??
        mrn.created_by,
    ),
    created_at: coil.created_at ?? mrn.created_at ?? null,
    total_coils: Number.isFinite(Number(coil.total_coils))
      ? Number(coil.total_coils)
      : null,
  };
}

function specFieldKey(nameRaw) {
  const n = String(nameRaw || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  if (!n) return null;
  if (n.includes("finish size") || n === "finish") return "finish_size";
  if (n.includes("base size") || n === "size") return "base_size";
  if (n.includes("next proc")) return "next_process";
  if (n.includes("next dep")) return "next_department";
  if (n.includes("wo no") || n.includes("work order")) return "work_order_no";
  if (n.includes("op code") || n.includes("operator code"))
    return "operator_code";
  if (n.includes("op name") || n.includes("operator name"))
    return "operator_name";
  if (n.includes("condition")) return "condition";
  if (n.includes("grade")) return "grade";
  return null;
}

export async function loadSpecStickerFields(item_dcode, item_code = null, item_desc = null) {
  const id = Number(item_dcode);
  let detail = Number.isFinite(id) && id > 0 ? await findSpecItemDetail(id) : null;
  if (!detail && item_code)
    detail = await findSpecItemDetailByItemCode(item_code);
  if (!detail && item_desc)
    detail = await findSpecItemDetailByItemDesc(item_desc);
  if (!detail && item_code && item_code !== item_desc)
    detail = await findSpecItemDetailByItemDesc(item_code);
  if (!detail) return {};

  const out = {};
  for (const [k, src] of [
    ["grade", detail.grade],
    ["condition", detail.condition],
    ["base_size", detail.size],
    ["condition_color", detail.condition_color],
    ["grade_color", detail.grade_color],
  ]) {
    const v = text(src);
    if (v) out[k] = v;
  }
  for (const line of detail.specs || []) {
    const val = text(line.print_val);
    const field = specFieldKey(line.spec_name);
    if (val && field) out[field] = val;
  }
  return out;
}

export async function resolveSpecStickerFields(coil = {}, mrn = {}) {
  return loadSpecStickerFields(
    coil.item_dcode ?? mrn.item_dcode ?? null,
    coil.item_code ?? mrn.item_code ?? null,
    coil.item_desc ?? mrn.item_desc ?? null,
  );
}

export function buildCoilStickerPrintRow(coil = {}, mrn = {}, opts = {}) {
  const spec = opts.spec || {};
  const mapped = mapCoilToStickerPrintRow(
    { ...spec, ...coil },
    { ...spec, ...mrn },
  );
  return {
    ...mapped,
    created_by: first(opts.created_by, mapped.created_by),
    created_at: opts.created_at ?? mapped.created_at ?? new Date(),
    condition_color: text(spec.condition_color ?? coil.condition_color ?? mrn.condition_color),
    grade_color: text(spec.grade_color ?? coil.grade_color ?? mrn.grade_color),
    ...(opts.isQc ? { is_qc: true, sticker_kind: "qc" } : {}),
  };
}

export function buildCoilStickerPrintDocumentTitle(mrnNo) {
  const pn = String(mrnNo ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-");
  return pn ? `MRN No. ${pn}` : "MRN Coil Stickers";
}

// ── CSS / HTML ────────────────────────────────────────────────────────────

const CSS = `
#html-content-holder.rm-sticker{
  display:grid;
  grid-template-rows:5.4mm 7.4mm 7.4mm 7.4mm 7.4mm 7.4mm 7.4mm 29.6mm 4mm;
  height:${H}mm;max-height:${H}mm;padding:0.8mm;margin:0 auto;border:none;box-sizing:border-box;
}
#html-content-holder.rm-sticker *{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}
.rm-sticker .st-row{display:flex;align-items:stretch;min-height:0;max-height:100%;overflow:hidden;width:100%}
.rm-sticker .st-row.rm-field{align-items:center;flex-wrap:nowrap}
.rm-sticker .st-row.st-footer{overflow:visible;max-height:none;align-items:center}
.rm-sticker .st-box{border-left:.4px solid #000;border-right:.4px solid #000;border-bottom:.4px solid #000;border-top:none;overflow:hidden;width:100%;min-height:0;background:#fff}
.rm-sticker .st-box.first{border-top:.4px solid #000}

.rm-sticker .st-label{
  display:block;flex:0 0 auto;margin:0;padding:0;
  font-size:2mm;line-height:1.15;font-weight:700;
  text-transform:uppercase;letter-spacing:.02em;color:#000;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.rm-sticker .st-val,.rm-sticker .st-val-wrap,.rm-sticker .st-condition,.rm-sticker .st-mid,.rm-sticker .st-ts{
  display:block;flex:0 0 auto;margin:0;padding:0;color:#000;
  white-space:nowrap;overflow:visible;line-height:1.15;
}
.rm-sticker .st-val,.rm-sticker .st-val-wrap,.rm-sticker .st-mid,.rm-sticker .st-condition{
  font-size:2.7mm;
}
.rm-sticker .st-val,.rm-sticker .st-val-wrap,.rm-sticker .st-mid{font-weight:700}
.rm-sticker .st-val.st-condition{
  font-weight:900;
  -webkit-text-stroke:.35px #000;
}
.rm-sticker .st-val-wrap{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.rm-sticker .st-ts{font-size:2mm;font-weight:800;line-height:1.1}

.rm-field,.rm-half-field,.rm-sticker .st-left-cell{
  display:flex;flex-direction:row;align-items:center;gap:.5mm;
  padding:0 1mm;min-width:0;width:100%;height:100%;
  overflow:hidden;
}
.rm-sticker .st-split{display:flex;width:100%;height:100%;min-width:0;align-items:stretch}
.rm-sticker .st-split .rm-half-field{padding:0 .7mm}
.rm-sticker .st-col6{width:50%;min-width:0;overflow:hidden;display:flex;align-items:center}
.rm-sticker .st-col6.l{border-right:.4px solid #000}
.rm-sticker .st-col{min-width:0;overflow:hidden;height:100%;display:flex;align-items:center}
.rm-sticker .st-col.l{border-right:.4px solid #000}

.rm-header{align-items:center;padding:0;overflow:hidden}
.rm-logo,.rm-header-spacer{width:12mm;flex-shrink:0;height:100%}
.rm-logo{display:flex;align-items:center;justify-content:center;padding:.15mm}
.rm-logo img{max-width:10.5mm;max-height:4mm;object-fit:contain;filter:grayscale(1) brightness(0)}
.rm-logo-fallback{font-weight:900;font-size:2.6mm;line-height:1;color:#000}
.rm-title{
  flex:1;display:flex;align-items:center;justify-content:center;
  font-size:2.9mm;font-weight:900;letter-spacing:.05em;text-transform:uppercase;
  color:#000;line-height:1;min-width:0;height:100%;padding:0 .3mm;
  overflow:hidden;white-space:nowrap;
}

.rm-sticker .st-bottom{display:flex;height:100%;width:100%;min-height:0}
.rm-sticker .st-left{
  width:50%;border-right:.4px solid #000;
  display:grid;grid-template-rows:repeat(${LAYOUT.bottomLeft.length},7.4mm);
  min-height:0;align-content:stretch;
}
.rm-sticker .st-left-cell{
  min-height:0;height:7.4mm;max-height:7.4mm;overflow:hidden;
  display:flex;flex-direction:row;align-items:center;gap:.5mm;
  padding:0 1mm;
}
.rm-sticker .st-left-cell + .st-left-cell{border-top:.4px solid #000}
.rm-sticker .st-left-cell .st-label{font-size:2mm;font-weight:700;color:#000}

.rm-sticker .st-right{
  width:50%;padding:.3mm;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:0;gap:.2mm;
}
.rm-sticker .st-qr-wrap{
  flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  width:100%;overflow:hidden;
}
.rm-sticker .st-qr-wrap img{
  display:block;width:${LAYOUT.qr.sizeMm}mm;height:${LAYOUT.qr.sizeMm}mm;object-fit:contain;
}
.rm-sticker .st-qr-uid{
  font-size:${LAYOUT.qr.captionFontPx}px;font-weight:700;font-family:monospace;
  line-height:1.5;word-break:break-all;text-align:center;color:#000;
  margin:0;max-width:100%;overflow:hidden;max-height:${LAYOUT.qr.captionMaxHeightMm}mm;flex-shrink:0;
}

.rm-sticker .st-footer{
  border:none !important;
  background:transparent;
  display:flex;align-items:center;gap:2mm;
  padding:.25mm .5mm .2mm;width:100%;min-height:0;
  overflow:visible;max-height:none;
}
.rm-sticker .st-footer.st-meta-left{justify-content:flex-start}
.rm-sticker .st-footer.st-meta-center{justify-content:center}
.rm-sticker .st-footer.st-meta-right{justify-content:flex-end}
.rm-sticker .st-footer .st-meta-item{
  display:inline-flex;flex-direction:row;align-items:center;gap:.35mm;
  min-width:0;max-width:100%;overflow:visible;line-height:1.15;
}
.rm-sticker .st-footer .st-label{
  display:inline;text-transform:none;font-size:1.85mm;font-weight:700;
  flex-shrink:0;color:#000;letter-spacing:0;line-height:1.15;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.rm-sticker .st-footer .st-val,
.rm-sticker .st-footer .st-ts{
  display:inline;flex:0 1 auto;min-width:0;margin-top:0;
  font-size:1.85mm;font-weight:800;line-height:1.15;color:#000;
  overflow:visible;text-overflow:clip;
}
`;

function cell(label, value, { wrap = false, cls = "" } = {}) {
  const vCls = ["st-val", wrap ? "st-val-wrap" : "", cls]
    .filter(Boolean)
    .join(" ");
  return `<span class="st-label">${esc(label)}:</span><span class="${vCls}">${value}</span>`;
}

function splitColClass(col, isLast) {
  return `st-col${isLast ? "" : " l"} rm-half-field`;
}

function buildCardHtml(f) {
  const logo = logoB64 ? `<img src="${logoB64}" alt="" />` : `<div class="rm-logo-fallback">JFL</div>`;
  const qrMm = LAYOUT.qr.sizeMm;
  const qr = f.qrUrl
    ? `<img src="${f.qrUrl}" alt="${esc(f.uid)}" />`
    : `<div style="width:${qrMm}mm;height:${qrMm}mm;border:1px solid #000;display:flex;align-items:center;justify-content:center;font-size:7px;">QR N/A</div>`;

  const html = LAYOUT.rows
    .map((row, i) => {
      const firstCls = i === 0 ? " first" : "";
      if (row.kind === "header") {
        return `<div class="st-row st-box${firstCls} rm-header"><div class="rm-logo">${logo}</div><div class="rm-title">${f.title}</div><div class="rm-header-spacer" aria-hidden="true"></div></div>`;
      }
      if (row.kind === "field") {
        return `<div class="st-row st-box${firstCls} rm-field">${cell(row.label, f[row.key], row)}</div>`;
      }
      if (row.kind === "split") {
        return `<div class="st-row st-box${firstCls} st-split">
          <div class="st-col6 l rm-half-field">${cell(row.left.label, f[row.left.key], row.left)}</div>
          <div class="st-col6 rm-half-field">${cell(row.right.label, f[row.right.key], row.right)}</div>
        </div>`;
      }
      if (row.kind === "split3") {
        const cols = row.cols || [];
        return `<div class="st-row st-box${firstCls} st-split">${cols
          .map((col, ci) => {
            const w = String(col.width || "33%").trim();
            return `<div class="${splitColClass(col, ci === cols.length - 1)}" style="flex:0 0 ${w};width:${w}">${cell(col.label, f[col.key], col)}</div>`;
          })
          .join("")}</div>`;
      }
      if (row.kind === "bottom") {
        const left = LAYOUT.bottomLeft
          .map(
            (c) =>
              `<div class="st-left-cell">${cell(c.label, f[c.key], { cls: "st-mid" })}</div>`,
          )
          .join("");
        return `<div class="st-row st-box${firstCls} st-bottom">
          <div class="st-left">${left}</div>
          <div class="st-right"><div class="st-qr-wrap">${qr}</div><div class="st-qr-uid">${esc(f.uid)}</div></div>
        </div>`;
      }
      // if (row.kind === "footer") {
      //   const alignRaw = String(LAYOUT.meta?.align || "left").toLowerCase();
      //   const align =
      //     alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";
      //   return `<div class="st-row st-footer st-meta-${align}">
      //     <span class="st-meta-item"><span class="st-label">Created By:</span><span class="st-val st-ts">${f.createdBy}</span></span>
      //     <span class="st-meta-item"><span class="st-label">Timestamp:</span><span class="st-val st-ts">${f.timestamp}</span></span>
      //   </div>`;
      // }
      if (row.kind === "footer") {
        const alignRaw = String(LAYOUT.meta?.align || "left").toLowerCase();
        const align = alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";
        return `<div class="st-row st-footer st-meta-${align}">
        <span class="st-meta-item">
          <span class="st-val st-ts">${f.createdBy}</span>
          <span class="st-label st-ts">||</span>
          <span class="st-val st-ts">${f.timestamp}</span>
          </span>
        </div>`;
      }
      return "";
    })
    .join("");

  return `<div id="html-content-holder" class="rm-sticker" style="background:#fff;width:${W}mm;height:${H}mm;max-height:${H}mm;border:none;overflow:hidden;box-sizing:border-box;">${html}</div>`;
}

async function buildCard(row) {
  const isQc =
    row.is_qc === true || String(row.sticker_kind || "").toLowerCase() === "qc";
  const uid = text(row.coil_no_uid || row.box_no_uid || row.coil_uid);
  const qrPayload = isQc ? (uid ? `QC|${uid}` : "") : uid;

  let qrUrl = "";
  try {
    if (qrPayload) {
      qrUrl = await QRCode.toDataURL(qrPayload, {
        width: 320,
        margin: 0,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  } catch {
    /* QR N/A */
  }

  const qtyN = Number(row.qty);
  const qty =
    Number.isFinite(qtyN) && qtyN > 0
      ? `${Math.round(qtyN).toLocaleString()}${text(row.unit) ? ` ${text(row.unit)}` : ""}`
      : EMPTY;
  const coilNo =
    isQc && Number(row.total_coils) > 0
      ? String(row.total_coils)
      : coilIndex(uid);

  return buildCardHtml({
    title: isQc ? "QC Sticker" : "RM Sticker",
    condition: esc(show(row.condition)),
    conditionColor: esc(show(row.condition_color)),
    grade: esc(show(row.grade)),
    gradeColor: esc(show(row.grade_color)),
    size: esc(show(text(row.base_size) || row.finish_size)),
    lotNo: esc(show(row.lot_no)),
    mrnDate: esc(fmtDate(row.doc_dt)),
    vendor: esc(show(row.acc_name)),
    itemCode: esc(show(row.item_code)),
    itemDesc: esc(show(row.itemdesc)),
    coilNo: esc(coilNo),
    qty: esc(qty),
    mrnUid: esc(show(row.mrn_uid)),
    uid: uid || EMPTY,
    qrUrl,
    createdBy: esc(show(row.created_by)),
    timestamp: esc(fmtTs(row.created_at)),
  });
}

export async function buildCoilStickerPreviewCardHtml(row) {
  return buildCard(row);
}

export async function buildCoilStickerCardHtml(row) {
  return buildCard(row);
}

export function buildCoilStickerPreviewDocument(cardHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Sticker preview</title>
<style>html,body{margin:0;padding:0;width:${W}mm;height:${H}mm;overflow:hidden;background:#edecec45;box-sizing:border-box}body{display:block;line-height:1.2}body>div{width:${W}mm;height:${H}mm;box-sizing:border-box}${CSS}</style>
</head><body>${cardHtml}</body></html>`;
}

export function buildCoilStickerPrintDocument(cards = [], { mrn_no } = {}) {
  const title = esc(buildCoilStickerPrintDocumentTitle(mrn_no));
  return `<html><head><title>${title}</title><style>
@page{margin:0;size:${W}mm ${H}mm}
html,body{margin:0;padding:0;width:${W}mm;font-family:Arial,sans-serif;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sticker-wrap{margin:0;padding:0;width:${W}mm}
.sticker-card{page-break-inside:avoid;break-inside:avoid;width:${W}mm;height:${H}mm;max-height:${H}mm;overflow:hidden;box-sizing:border-box}
.sticker-card:not(:last-child){page-break-after:always;break-after:page}
.sticker-card:last-child{page-break-after:avoid;break-after:avoid}
${CSS}</style></head><body><div class="sticker-wrap">${cards.map((c) => `<div class="sticker-card">${c}</div>`).join("")}</div></body></html>`;
}

/** Print window title — QC vs coil. */
export function buildStickerPrintTitle(mrnNo, { isQc = false, batch = false } = {}) {
  const base = buildCoilStickerPrintDocumentTitle(mrnNo);
  if (!isQc) return base;
  if (batch) return mrnNo ? `MRN No. ${String(mrnNo).trim()} — Batch QC` : "Batch QC Sticker";
  return mrnNo ? `MRN No. ${String(mrnNo).trim()} — QC` : "QC Sticker";
}

/**
 * One pipeline: coil + mrn → HTML.
 * Controllers should call this instead of wiring spec/row/card/doc themselves.
 */
export async function buildStickerDocs(coils, mrn = {}, { isQc = false, createdBy, preview = false } = {}) {
  const list = Array.isArray(coils) ? coils : [coils];
  if (!list.length) throw new Error("No coils to print.");

  const spec = await resolveSpecStickerFields(list[0], mrn || {});
  const cards = [];
  for (const coil of list) {
    const row = buildCoilStickerPrintRow(coil, mrn || {}, {
      isQc,
      spec,
      created_by: coil.created_by || createdBy,
    });
    cards.push(await buildCard(row));
  }

  const mrnNo = list[0].mrn_no ?? mrn?.mrn_no;
  const html = preview
    ? buildCoilStickerPreviewDocument(cards[0])
    : buildCoilStickerPrintDocument(cards, { mrn_no: mrnNo });

  return {
    html,
    print_title: buildStickerPrintTitle(mrnNo, { isQc }),
    total: cards.length,
    mrn_no: mrnNo,
    is_qc: !!isQc,
  };
}
