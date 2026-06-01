import express from "express";
import {
  getModuleSops,
  getModuleSopById,
  createModuleSop,
  updateModuleSopController,
  deleteModuleSopController,
  getModuleSopHelper,
} from "../controllers/moduleSop.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("training_videos", "view"), getModuleSops);
router.post("/get", authenticate, accessControl("training_videos", "view"), getModuleSopById);
router.post("/create", authenticate, accessControl("training_videos", "add"), createModuleSop);
router.post("/update", authenticate, accessControl("training_videos", "edit"), updateModuleSopController);
router.post("/delete", authenticate, accessControl("training_videos", "delete"), deleteModuleSopController);
router.post("/helper", authenticate, dynamicAccessControl(), getModuleSopHelper);

export default router;
