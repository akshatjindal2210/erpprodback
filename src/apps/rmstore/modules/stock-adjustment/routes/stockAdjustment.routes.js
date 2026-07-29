import express from "express";
import { getAdjustments, getAdjustmentById, getActiveCoilsForMinus, createAdjustment, updateAdjustmentCtrl, deleteAdjustment } from "../controllers/stockAdjustment.controller.js";
import { renderSingleSaImsSticker, renderBulkSaImsStickers } from "../controllers/stockAdjustmentSticker.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";

const router = express.Router();
const MODULE = "rm_stock_adjustment";

router.post("/list", authenticate, accessControl(MODULE, "view"), getAdjustments);
router.post("/get", authenticate, accessControl(MODULE, "view"), getAdjustmentById);
router.post("/active-coils", authenticate, accessControl(MODULE, "view"), getActiveCoilsForMinus);
router.post("/create", authenticate, accessControl(MODULE, "add"), createAdjustment);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateAdjustmentCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteAdjustment);

/** IMS FG sticker design (buildStickerCardHtml) — same as IMS Stock Adjustment. */
router.post("/sticker/render-single", authenticate, accessControl(MODULE, "view"), renderSingleSaImsSticker);
router.post("/sticker/render-bulk", authenticate, accessControl(MODULE, "view"), renderBulkSaImsStickers);

export default router;
