import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import {
  createBin,
  deleteBin,
  getBins,
  getBinTypes,
  getBinCategoryTags,
  getBinMaterialTags,
  previewBinBatch,
  getBinsViews,
  resolveBinQrPayloads,
  updateBin,
} from "../controllers/binMaster.controller.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const MOD = "production_bin_master";
const router = express.Router();

router.post("/types", authenticate, accessControl(MOD, "view"), getBinTypes);
router.post("/category-tags", authenticate, accessControl(MOD, "view"), getBinCategoryTags);
router.post("/b-type-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/class-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/kind-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/variant-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/subtype-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/material-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/type-tags", authenticate, accessControl(MOD, "view"), getBinMaterialTags);
router.post("/preview", authenticate, accessControl(MOD, "add"), previewBinBatch);
router.post("/qr-payloads", authenticate, accessControl(MOD, "view"), resolveBinQrPayloads);
router.post("/helper", authenticate, helperAccess("bins"), getBinsViews);
router.post("/list", authenticate, accessControl(MOD, "view"), getBins);
router.post("/create", authenticate, accessControl(MOD, "add"), createBin);
router.post(
  "/update",
  authenticate,
  accessControlAny([
    { moduleName: MOD, actions: "edit" },
    { moduleName: MOD, actions: "authorize" },
  ]),
  updateBin,
);
router.post("/delete", authenticate, accessControl(MOD, "delete"), deleteBin);

export default router;
