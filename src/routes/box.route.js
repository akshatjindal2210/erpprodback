import express from "express";
import { getBoxes, getBoxById, createBox, updateBox, deleteBox, getInHandBoxesByPacking, stickerFetchBox, generateStickers, previewSticker, removeGeneratedStickers, trackStickerDownload, trackBulkDownload, overrideCustomer, getBoxDownloadHistory, getPackingDownloadSummary, renderSingleSticker, renderBulkStickers, stickerManagementList, createOverrideRequest, listOverrideRequests, approveOverrideRequest, updateOverrideRequest, getBoxesViews } from "../controllers/box.controller.js";

import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl, accessControlAny } from "../middleware/accessControl.js";

const router = express.Router();

// ─── Box CRUD ─────────────────────────────────────────────────
router.post("/list",   authenticate, accessControl("boxes", "view"),   getBoxes);
router.post("/in-hand-by-packing", authenticate, accessControl("stock_adjustment", "view"), getInHandBoxesByPacking);
router.post("/get",    authenticate, accessControl("boxes", "view"),   getBoxById);
// router.post("/create", authenticate, accessControl("boxes", "add"),    createBox);
// router.post("/update", authenticate, accessControl("boxes", "edit"),   updateBox);
// router.post("/delete", authenticate, accessControl("boxes", "delete"), deleteBox);

// ─── Sticker ──────────────────────────────────────────────────
router.post("/sticker/fetch", authenticate, accessControl("packing_entry", "view"), stickerFetchBox);

// ——— Bulk generate ————————————————————————————————————————————
router.post("/sticker/generate", authenticate, accessControl("packing_entry", ["add", "edit"]), generateStickers);
router.post("/sticker/preview", authenticate, accessControl("packing_entry", ["view", "add", "edit"]), previewSticker);
router.post("/sticker/remove", authenticate, accessControl("packing_entry", "delete"), removeGeneratedStickers);

// ─── Download Tracking ────────────────────────────────────────
router.post("/sticker/download", authenticate, accessControl("packing_entry", "edit"), trackStickerDownload);
router.post("/sticker/download-bulk", authenticate, accessControl("packing_entry", "edit"), trackBulkDownload);
router.post("/sticker/render-single", authenticate, accessControl("packing_entry", "view"), renderSingleSticker);
router.post("/sticker/render-bulk", authenticate, accessControlAny([{ moduleName: "packing_entry", actions: "view" }, { moduleName: "stock_adjustment", actions: ["add", "authorize"] }]), renderBulkStickers);

// ─── History & Reports ────────────────────────────────────────
router.post("/sticker/download-history", authenticate, accessControl("packing_entry", "view"), getBoxDownloadHistory);
router.post("/sticker/download-summary", authenticate, accessControl("packing_entry", "view"), getPackingDownloadSummary);

router.post("/sticker/management-list", authenticate, accessControl("sticker_download_logs", "view"), stickerManagementList);

// ─── Customer Override ────────────────────────────────────────
router.post("/sticker/override-cust", authenticate, accessControl("change_override_customer", "edit"), overrideCustomer);

router.post("/sticker/override/list", authenticate, accessControl("change_override_customer", "view"), listOverrideRequests);
router.post("/sticker/override/request", authenticate, accessControl("change_override_customer", "add"), createOverrideRequest);
router.post("/sticker/override/update", authenticate, accessControl("change_override_customer", "edit"), updateOverrideRequest);
router.post("/sticker/override/approve", authenticate, accessControl("change_override_customer", "authorize"), approveOverrideRequest);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getBoxesViews);

export default router;