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
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("training_videos", "view"), getTrainingVideos);

router.post("/get", authenticate, accessControl("training_videos", "view"), getTrainingVideoById);

router.post("/create", authenticate, accessControl("training_videos", "add"), createTrainingVideo);

router.post("/update", authenticate, accessControl("training_videos", "edit"), updateTrainingVideoController);

router.post("/approve", authenticate, accessControl("training_videos", "authorize"), approveTrainingVideoController);

router.post("/delete", authenticate, accessControl("training_videos", "delete"), deleteTrainingVideoController);

router.post("/helper", authenticate, dynamicAccessControl(), getTrainingVideosViews);

export default router;
