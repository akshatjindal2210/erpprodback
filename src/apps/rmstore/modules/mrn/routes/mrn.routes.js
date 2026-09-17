import express from "express";
import { getMrnList, generateMrn, deleteGeneratedMrn, lookupErpMrn, listErpMrnsForFinancialYear, listErpLotsForFinancialYear, searchAdjustmentMrns } from "../controllers/mrn.controller.js";
import { getMrnDetail, generateMrnStickers, getMrnCoils, uploadMrnDocs, saveMrnStickerDraftCtrl, approveMrnStickers, rejectMrnPortal, cancelMrnPortalRejection } from "../controllers/mrnSticker.controller.js";
import { previewCoilSticker, renderSingleCoilSticker, renderBulkCoilStickers, renderBatchQcSticker } from "../controllers/coilStickerPrint.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import { rmTcUpload } from "../../../lib/middleware/upload.js";

const router = express.Router();
const MODULE = "rm_mrn_portal";

const mrnErpReader = accessControlAny([
  { moduleName: MODULE, actions: ["view", "add"] },
  { moduleName: "rm_stock_adjustment", actions: "view" },
]);

router.post("/list", authenticate, accessControl(MODULE, ["view", "add", "authorize"]), getMrnList);
router.post("/erp-list", authenticate, mrnErpReader, listErpMrnsForFinancialYear);
router.post("/erp-lots", authenticate, mrnErpReader, listErpLotsForFinancialYear);
router.post("/erp-lookup", authenticate, mrnErpReader, lookupErpMrn);
router.post("/erp-search", authenticate, mrnErpReader, searchAdjustmentMrns);
router.post("/generate", authenticate, accessControl(MODULE, "add"), generateMrn);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteGeneratedMrn);

router.post("/detail", authenticate, accessControl(MODULE, ["view", "add", "authorize"]), getMrnDetail);
router.post("/coils", authenticate, accessControl(MODULE, ["view", "add"]), getMrnCoils);

/** Generate stickers — JSON body only (no files). */
router.post("/generate-stickers", authenticate, accessControl(MODULE, "add"), generateMrnStickers);
router.post("/approve-stickers", authenticate, accessControl(MODULE, "authorize"), approveMrnStickers);
router.post("/reject", authenticate, accessControl(MODULE, "authorize"), rejectMrnPortal);
router.post("/cancel-rejection", authenticate, accessControl(MODULE, "authorize"), cancelMrnPortalRejection);

/** Save sticker form draft — optional TC/RMTC upload, no coils created. */
router.post("/save-sticker-draft", authenticate, accessControl(MODULE, "add"), rmTcUpload.fields([{ name: "tc", maxCount: 1 }, { name: "rmtc", maxCount: 1 }]), saveMrnStickerDraftCtrl);

/** Simple TC/RMTC upload after generate. */
router.post("/upload-docs", authenticate, accessControl(MODULE, "add"), rmTcUpload.fields([{ name: "tc", maxCount: 1 }, { name: "rmtc", maxCount: 1 }]), uploadMrnDocs);

/** 
 * Sticker print/preview — HTML from coilStickerDesign.js only.
 * preview → render-single → render-bulk → render-batch-qc
 */
router.post("/sticker/preview", authenticate, accessControl(MODULE, ["view", "add"]), previewCoilSticker);
router.post("/sticker/render-single", authenticate, accessControl(MODULE, ["view", "add"]), renderSingleCoilSticker);
router.post("/sticker/render-bulk", authenticate, accessControl(MODULE, ["view", "add"]), renderBulkCoilStickers);
router.post("/sticker/render-batch-qc", authenticate, accessControl(MODULE, ["view", "add"]), renderBatchQcSticker);

export default router;
