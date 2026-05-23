import express from "express";
import {
  getTrainingVideos,
  getTrainingVideoById,
  createTrainingVideo,
  updateTrainingVideoController,
  approveTrainingVideoController,
  deleteTrainingVideoController,
  getTrainingVideosViews,
} from "../controllers/trainingVideo.controller.js";
import moduleSopRoutes from "./moduleSop.routes.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.use("/sops", moduleSopRoutes);

// ─── GET all videos
router.post("/list", authenticate, accessControl("training_videos", "view"), getTrainingVideos);

// ─── GET single video  
router.post("/get", authenticate, accessControl("training_videos", "view"), getTrainingVideoById);

// ─── CREATE video  
router.post("/create", authenticate, accessControl("training_videos", "add"), createTrainingVideo);

// ─── UPDATE video  
router.post("/update", authenticate, accessControl("training_videos", "edit"), updateTrainingVideoController);

// ─── APPROVE video
router.post("/approve", authenticate, accessControl("training_videos", "authorize"), approveTrainingVideoController);

// ─── DELETE video  
router.post("/delete", authenticate, accessControl("training_videos", "delete"), deleteTrainingVideoController);

// ─── GET Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getTrainingVideosViews);

export default router;
