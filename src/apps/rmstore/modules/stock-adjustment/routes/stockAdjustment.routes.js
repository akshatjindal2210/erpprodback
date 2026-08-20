import express from "express";
import { getAdjustments, getAdjustmentById, getActiveCoilsForMinus, createAdjustment, updateAdjustmentCtrl, deleteAdjustment } from "../controllers/stockAdjustment.controller.js";
import { renderSingleSaCoilSticker, renderBulkSaCoilStickers, uploadSaDocs } from "../controllers/stockAdjustmentSticker.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { rmTcUpload } from "../../../lib/middleware/upload.js";

const router = express.Router();
const MODULE = "rm_stock_adjustment";

router.post("/list", authenticate, accessControl(MODULE, "view"), getAdjustments);
router.post("/get", authenticate, accessControl(MODULE, "view"), getAdjustmentById);
router.post("/active-coils", authenticate, accessControl(MODULE, "view"), getActiveCoilsForMinus);
router.post("/create", authenticate, accessControl(MODULE, "add"), createAdjustment);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateAdjustmentCtrl);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteAdjustment);

/** RM coil sticker design (MRN Portal style). */
router.post("/sticker/render-single", authenticate, accessControl(MODULE, "view"), renderSingleSaCoilSticker);
router.post("/sticker/render-bulk", authenticate, accessControl(MODULE, "view"), renderBulkSaCoilStickers);
router.post("/upload-docs", authenticate, accessControl(MODULE, "add"), rmTcUpload.fields([{ name: "tc", maxCount: 1 }, { name: "rmtc", maxCount: 1 }]), uploadSaDocs);

export default router;
