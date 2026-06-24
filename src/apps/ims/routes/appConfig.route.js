import express from "express";
import { authenticate } from "../middleware/auth.js";
import { getAppConfigList, updateAppConfig } from "../controllers/appConfig.controller.js";
import { dynamicAccessControl } from "../../core/middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, dynamicAccessControl(), getAppConfigList);
router.put("/", authenticate, dynamicAccessControl(), updateAppConfig);

export default router;
