import express from "express";
import { getCategories, getCategoryById, createCategory, updateCategory, deleteCategory } from "../controllers/category.controller.js";
import { authenticate, authorize, activityLogger } from "../shared/index.js";

const router = express.Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");
const staffOnly = authorize("super_admin", "admin");

router.use(authenticate);
router.get("/", allRoles, getCategories);
router.get("/:id", allRoles, getCategoryById);
router.post("/", staffOnly, activityLogger, createCategory);
router.put("/:id", staffOnly, activityLogger, updateCategory);
router.delete("/:id", staffOnly, activityLogger, deleteCategory);

export default router;
