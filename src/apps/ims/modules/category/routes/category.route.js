import express from "express";
import { getCategories, getCategoryById, getCategoriesViews } from "../controllers/category.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();

router.post("/helper", authenticate, helperAccess("category"), getCategoriesViews);

export default router;
