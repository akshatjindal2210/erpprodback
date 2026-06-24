import express from "express";
import { getQcHoldMaterials, getQcHoldMaterialById, getActiveQcHoldParents, createQcHoldMaterial, submitQcHoldMaterial, approveQcHoldSubmissionController, updateQcHoldMaterialController, deleteQcHoldMaterialController, getQcHoldPackingMeta, verifyQcHoldBox, expandQcHoldFullBoxes, getQcHoldCompletionBoxes, getQcHoldReasonsViews } from "../controllers/qcHoldMaterial.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, accessControlAny } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.use(authenticate);

router.post("/packing-meta", accessControl("qc_hold_material", "view"), getQcHoldPackingMeta);
router.post("/reason-helper", accessControl("qc_hold_material", "view"), getQcHoldReasonsViews);
router.post("/verify-box", accessControl("qc_hold_material", ["view", "add", "edit"]), verifyQcHoldBox);
router.post("/expand-full-hold", accessControl("qc_hold_material", ["add", "edit"]), expandQcHoldFullBoxes);
router.post("/completion-boxes", accessControl("qc_hold_material", "view"), getQcHoldCompletionBoxes);
router.post("/active-holds", accessControlAny([
  { moduleName: "qc_hold_material", actions: ["view", "add", "edit"] },
  { moduleName: "out_entry", actions: "view" }
]), getActiveQcHoldParents);
router.post("/list", accessControl("qc_hold_material", "view"), getQcHoldMaterials);
router.post("/get", accessControlAny([
  { moduleName: "qc_hold_material", actions: "view" },
  { moduleName: "out_entry", actions: "view" }
]), getQcHoldMaterialById);
router.post("/create", accessControl("qc_hold_material", "add"), createQcHoldMaterial);
router.post("/submit", accessControl("qc_hold_material", ["add", "edit"]), submitQcHoldMaterial);
router.post("/approve-submission", accessControl("qc_hold_material", "authorize"), approveQcHoldSubmissionController);
router.post("/update", accessControl("qc_hold_material", ["edit", "authorize"]), updateQcHoldMaterialController);
router.post("/delete", accessControl("qc_hold_material", "delete"), deleteQcHoldMaterialController);

export default router;
