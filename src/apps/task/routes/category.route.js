import express from "express";
import { getCategories, getCategoriesViews, getCategoryById, createCategory, updateCategory, deleteCategory } from "../controllers/category.controller.js";
import { authenticate, authorize, activityLogger } from "../shared/index.js";
import { accessControl } from "../../core/middleware/accessControl.js";
import { categoryHelperAccess } from "../config/helperViews.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");

router.use(authenticate);

/** POST-only (CL Task style) */
router.post("/list", allRoles, accessControl("category", "view"), getCategories);
router.post("/get", allRoles, accessControl("category", "view"), getCategoryById);
router.post("/create", allRoles, accessControl("category", "add"), activityLogger, createCategory);
router.post("/update", allRoles, accessControl("category", "edit"), activityLogger, updateCategory);
router.post("/delete", allRoles, accessControl("category", "delete"), activityLogger, deleteCategory);

/** IMS-style helper for filters/forms — access via calling page module. */
router.post("/helper", categoryHelperAccess(), getCategoriesViews);

export default router;
