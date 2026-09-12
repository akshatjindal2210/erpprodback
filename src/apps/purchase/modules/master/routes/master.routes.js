import express from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl, accessControlAny } from "../../../../core/lib/middleware/accessControl.js";
import { getItems, getItemById, getItemsViews } from "../controllers/master.controller.js";

const router = express.Router();

const ITEM_HELPER_ACCESS = [
  { moduleName: "purchase_master", actions: "view" },
  { moduleName: "purchase_shortage", actions: ["view", "add", "edit", "authorize"] },
];

router.post("/items/list", authenticate, accessControl("purchase_master", "view"), getItems);
router.post("/items/get", authenticate, accessControl("purchase_master", "view"), getItemById);
router.post("/items/helper", authenticate, accessControlAny(ITEM_HELPER_ACCESS), getItemsViews);

export default router;
