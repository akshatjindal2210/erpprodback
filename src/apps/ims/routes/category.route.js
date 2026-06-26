import express from "express";
import { getCategories, getCategoryById, getCategoriesViews } from "../controllers/category.controller.js";
import { authenticate } from "../middleware/auth.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/helper", authenticate, helperAccess("category"), getCategoriesViews);

export default router;
