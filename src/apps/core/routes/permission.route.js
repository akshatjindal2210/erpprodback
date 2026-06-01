import express from "express";
import { getUserPermissions, getPermissionById, setPermission, setBulkPermissions, updatePermission, removePermission } from "../controllers/permission.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../middleware/accessControl.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("user_permissions", "view"), getUserPermissions);
router.post("/get", authenticate, accessControl("user_permissions", "view"), getPermissionById);
router.post("/set", authenticate, accessControl("user_permissions", "add"), setPermission);
router.post("/set-bulk", authenticate, accessControl("user_permissions", "add"), setBulkPermissions);
router.post("/update", authenticate, accessControl("user_permissions", "edit"), updatePermission);
router.post("/remove", authenticate, accessControl("user_permissions", "delete"), removePermission);

export default router;
