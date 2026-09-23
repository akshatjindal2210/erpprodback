/**
 * Child-process PDF rasterizer. Do not import from the API process.
 * Usage: node rasterizePdfPages.child.js <absolute-pdf-path> [output.json]
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
const CMAP_URL = `${pathToFileURL(path.join(PDFJS_ROOT, "cmaps")).href}/`;
const STANDARD_FONT_DATA_URL = `${pathToFileURL(path.join(PDFJS_ROOT, "standard_fonts")).href}/`;
const WASM_URL = `${pathToFileURL(path.join(PDFJS_ROOT, "wasm")).href}/`;

const MAX_EDGE_PX = 1100;
const MAX_PAGES = 24;
const JPEG_QUALITY = 78;

class ReportCanvasFactory {
  constructor(_opts = {}) {}

  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext?.canvas) return;
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function scaleForPage(viewport) {
  const w = Number(viewport?.width) || 1;
  const h = Number(viewport?.height) || 1;
  return Math.min(MAX_EDGE_PX / w, MAX_EDGE_PX / h, 1.5);
}

function encodeJpeg(canvas) {
  if (typeof canvas.encodeSync === "function") {
    return canvas.encodeSync("jpeg", JPEG_QUALITY);
  }
  return canvas.toBuffer("image/jpeg", JPEG_QUALITY);
}

async function rasterizePdfPagesInProcess(diskPath) {
  const buf = fs.readFileSync(diskPath);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = getDocument({
    data: new Uint8Array(buf),
    CanvasFactory: ReportCanvasFactory,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    wasmUrl: WASM_URL,
    disableFontFace: true,
    enableScripting: false,
    useSystemFonts: false,
    useWasm: true,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  const pdf = await loadingTask.promise;
  const urls = [];
  const pageCount = Math.min(pdf.numPages || 0, MAX_PAGES);
  const canvasFactory = pdf.canvasFactory || new ReportCanvasFactory();

  try {
    for (let n = 1; n <= pageCount; n += 1) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: scaleForPage(base) });
      const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
      await page.render({
        canvasContext: canvasAndContext.context,
        canvas: canvasAndContext.canvas,
        viewport,
      }).promise;
      const jpeg = encodeJpeg(canvasAndContext.canvas);
      urls.push(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
      canvasFactory.destroy(canvasAndContext);
      page.cleanup();
    }
  } finally {
    // pdfjs v6 removed PDFDocumentProxy.destroy(); tear down via loadingTask
    await loadingTask.destroy?.();
  }

  return urls;
}

const pdfPath = process.argv[2];
const outPath = process.argv[3];
if (!pdfPath) {
  console.error("missing pdf path");
  process.exit(2);
}

try {
  const urls = await rasterizePdfPagesInProcess(pdfPath);
  const json = JSON.stringify(urls);
  if (outPath) fs.writeFileSync(outPath, json);
  else process.stdout.write(json);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
