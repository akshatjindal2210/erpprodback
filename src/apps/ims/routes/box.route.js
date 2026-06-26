import express from "express";
import { getBoxes, getBoxById, createBox, updateBox, deleteBox, getInHandBoxesByPacking, getStockAdjustmentAddBoxesByPattern, stickerFetchBox, generateStickers, previewSticker, removeGeneratedStickers, trackStickerDownload, trackBulkDownload, overrideCustomer, getBoxDownloadHistory, getPackingDownloadSummary, renderSingleSticker, renderBulkStickers, stickerManagementList, createOverrideRequest, listOverrideRequests, approveOverrideRequest, updateOverrideRequest, getBoxesViews } from "../controllers/box.controller.js";

import { authenticate } from "../middleware/auth.js";
import { accessControl, accessControlAny } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/list",   authenticate, accessControl("boxes", "view"),   getBoxes);
router.post("/in-hand-by-packing", authenticate, accessControl("stock_adjustment", "view"), getInHandBoxesByPacking);
router.post("/sa-add-by-adjustment", authenticate, accessControl("stock_adjustment", "view"), getStockAdjustmentAddBoxesByPattern);
router.post("/get",    authenticate, accessControl("boxes", "view"),   getBoxById);

router.post("/sticker/fetch", authenticate, accessControl("packing_entry", "view"), stickerFetchBox);

// ——— Bulk generate ————————————————————————————————————————————
router.post("/sticker/generate", authenticate, accessControl("packing_entry", ["add", "edit"]), generateStickers);
router.post("/sticker/preview", authenticate, accessControl("packing_entry", ["view", "add", "edit"]), previewSticker);
router.post("/sticker/remove", authenticate, accessControl("packing_entry", "delete"), removeGeneratedStickers);

router.post("/sticker/download", authenticate, accessControl("packing_entry", "edit"), trackStickerDownload);
router.post("/sticker/download-bulk", authenticate, accessControl("packing_entry", "edit"), trackBulkDownload);
router.post("/sticker/render-single", authenticate, accessControlAny([{ moduleName: "packing_entry", actions: "view" }, { moduleName: "stock_adjustment", actions: "view" }, { moduleName: "change_override_customer", actions: "view" } ]), renderSingleSticker);
router.post("/sticker/render-bulk", authenticate, accessControlAny([{ moduleName: "packing_entry", actions: "view" }, { moduleName: "stock_adjustment", actions: "view" }, { moduleName: "change_override_customer", actions: "view" } ]), renderBulkStickers);

router.post("/sticker/download-history", authenticate, accessControl("packing_entry", "view"), getBoxDownloadHistory);
router.post("/sticker/download-summary", authenticate, accessControl("packing_entry", "view"), getPackingDownloadSummary);

router.post("/sticker/management-list", authenticate, accessControl("sticker_download_logs", "view"), stickerManagementList);

router.post("/sticker/override-cust", authenticate, accessControl("change_override_customer", "edit"), overrideCustomer);

router.post("/sticker/override/list", authenticate, accessControl("change_override_customer", "view"), listOverrideRequests);
router.post("/sticker/override/request", authenticate, accessControl("change_override_customer", "add"), createOverrideRequest);
router.post("/sticker/override/update", authenticate, accessControl("change_override_customer", "edit"), updateOverrideRequest);
router.post("/sticker/override/approve", authenticate, accessControl("change_override_customer", "authorize"), approveOverrideRequest);

// Views (Helper API)
router.post("/helper", authenticate, helperAccess("boxes"), getBoxesViews);

export default router;
