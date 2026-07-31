import express from "express";
import { getMrnList, generateMrn, deleteGeneratedMrn } from "../controllers/mrn.controller.js";
import { getMrnDetail, generateMrnStickers, getMrnCoils, uploadMrnDocs, saveMrnStickerDraftCtrl } from "../controllers/mrnSticker.controller.js";
import { previewCoilSticker, renderSingleCoilSticker, renderBulkCoilStickers, renderBatchQcSticker } from "../controllers/coilStickerPrint.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { rmTcUpload } from "../../../lib/middleware/upload.js";

const router = express.Router();
const MODULE = "rm_mrn_portal";

router.post("/list", authenticate, accessControl(MODULE, "view"), getMrnList);
router.post("/generate", authenticate, accessControl(MODULE, "add"), generateMrn);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteGeneratedMrn);

router.post("/detail", authenticate, accessControl(MODULE, "view"), getMrnDetail);
router.post("/coils", authenticate, accessControl(MODULE, "view"), getMrnCoils);

/** Generate stickers — JSON body only (no files). */
router.post("/generate-stickers", authenticate, accessControl(MODULE, "add"), generateMrnStickers);

/** Save sticker form draft — optional TC/RMTC upload, no coils created. */
router.post(
  "/save-sticker-draft",
  authenticate,
  accessControl(MODULE, "add"),
  rmTcUpload.fields([{ name: "tc", maxCount: 1 }, { name: "rmtc", maxCount: 1 }]),
  saveMrnStickerDraftCtrl
);

/** Simple TC/RMTC upload after generate. */
router.post("/upload-docs", authenticate, accessControl(MODULE, "add"), rmTcUpload.fields([{ name: "tc", maxCount: 1 }, { name: "rmtc", maxCount: 1 }]), uploadMrnDocs);

router.post("/sticker/preview", authenticate, accessControl(MODULE, ["view", "add"]), previewCoilSticker);
router.post("/sticker/render-single", authenticate, accessControl(MODULE, "view"), renderSingleCoilSticker);
router.post("/sticker/render-bulk", authenticate, accessControl(MODULE, "view"), renderBulkCoilStickers);
router.post("/sticker/render-batch-qc", authenticate, accessControl(MODULE, "view"), renderBatchQcSticker);

export default router;
