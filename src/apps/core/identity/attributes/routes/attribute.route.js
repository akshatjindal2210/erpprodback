import express from "express";
import { getAttributes, getAttributeById, createAttribute, updateAttributeData, deleteAttributeData, getAttributesHelper } from "../controllers/attribute.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();

// CRUD — no attributes menu yet; same as Users permissions.
router.post("/list", authenticate, accessControl("users", "view"), getAttributes);
router.post("/get", authenticate, accessControl("users", "view"), getAttributeById);
router.post("/create", authenticate, accessControl("users", "add"), createAttribute);
router.post("/update", authenticate, accessControl("users", "edit"), updateAttributeData);
router.post("/delete", authenticate, accessControl("users", "delete"), deleteAttributeData);
router.post("/helper", authenticate, helperAccess("attributes"), getAttributesHelper);

export default router;
