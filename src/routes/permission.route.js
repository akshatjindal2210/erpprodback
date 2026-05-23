import express from "express";
import { getUserPermissions, getPermissionById, setPermission, setBulkPermissions, updatePermission, removePermission } from "../controllers/permission.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../middleware/accessControl.js";

const router = express.Router();

// ─── GET all permissions for a user (POST-safe)
router.post("/list", authenticate, accessControl("user_permissions", "view"), getUserPermissions);

// ─── SET single permission (POST-safe)
router.post("/create", authenticate, accessControl("user_permissions", "add"), setPermission);

// ─── GET single permission (POST-safe)
router.post("/get", authenticate, accessControl("user_permissions", "view"), getPermissionById);

// ─── UPDATE permission (POST-safe)
router.post("/update", authenticate, accessControl("user_permissions", "edit"), updatePermission);

// ─── SET bulk permissions (POST-safe)
router.post("/bulk-create", authenticate, accessControl("user_permissions", "add"), setBulkPermissions);

// ─── REMOVE single permission (POST-safe)
router.post("/delete", authenticate, accessControl("user_permissions", "delete"), removePermission);

export default router;