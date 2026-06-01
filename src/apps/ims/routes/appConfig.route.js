import express from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import {
  getAppConfigList,
  updateAppConfig,
} from "../controllers/appConfig.controller.js";

const router = express.Router();

const superAdminOnly = authorize("super_admin");

router.post("/list", authenticate, superAdminOnly, getAppConfigList);
router.put("/", authenticate, superAdminOnly, updateAppConfig);

export default router;
