import express from "express";
import { getCategories, getCategoryById, getCategoriesViews } from "../controllers/category.controller.js";
import { authenticate } from "../middleware/auth.js";
import { dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

// ─── GET Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getCategoriesViews);

export default router;
