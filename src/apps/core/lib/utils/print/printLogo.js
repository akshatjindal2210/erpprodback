/**
 * Shared A4 print header logo (QC / Coil report, Issue Request, Forwarding Note).
 *
 * To make the logo smaller or larger later, change ONLY:
 *   PRINT_LOGO_SIZE_MM
 * (millimetres — image max height; cell is SIZE+2).
 */

import fs from "fs";
import path from "path";

/** ← Edit this one number to resize logo on all A4 prints. */
export const PRINT_LOGO_SIZE_MM = 46;

function sizeMm() {
  const n = Number(PRINT_LOGO_SIZE_MM);
  return Number.isFinite(n) && n > 0 ? n : 46;
}

/** Resolve logo.png from common server cwd locations. */
export function getPrintLogoDataUrl() {
  try {
    const candidates = [
      path.join(process.cwd(), "logo.png"),
      path.join(process.cwd(), "backend", "logo.png"),
    ];
    for (const logoPath of candidates) {
      if (fs.existsSync(logoPath)) {
        const bitmap = fs.readFileSync(logoPath);
        return `data:image/png;base64,${bitmap.toString("base64")}`;
      }
    }
  } catch (err) {
    console.error("[printLogo] Error reading logo.png:", err?.message || err);
  }
  return null;
}

/** HTML for left-header logo (uses .fn-logo-img / .fn-logo-fallback). */
export function getPrintLogoBlock() {
  const src = getPrintLogoDataUrl();
  if (src) return `<img class="fn-logo-img" src="${src}" alt="" />`;
  return `<div class="fn-logo-fallback" aria-hidden="true">JFL</div>`;
}

/**
 * CSS for .fn-logo-cell / .fn-logo-img / .fn-logo-fallback.
 * Inject into each print document &lt;style&gt; block.
 */
export function buildPrintLogoCss() {
  const img = sizeMm();
  const cell = img + 2;
  const fb = Math.max(12, Math.round(img * 0.82));
  const fbFont = Math.max(8, Math.round(img * 0.3));
  return `
    .fn-logo-cell {
      flex: 0 0 ${cell}mm;
      width: ${cell}mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fn-logo-img {
      max-height: ${img}mm;
      max-width: ${cell}mm;
      width: 100%;
      height: auto;
      object-fit: contain;
      display: block;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .fn-logo-fallback {
      width: ${fb}mm; height: ${fb}mm;
      border: 2.5px solid #0b3d91;
      color: #0b3d91;
      clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: ${fbFont}pt;
    }`;
}
