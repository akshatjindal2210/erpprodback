import express from "express";
import { getDesignations, getDesignationById, createDesignation, updateDesignationData, deleteDesignationData, getDesignationsHelper } from "../controllers/designation.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../middleware/accessControl.js";
import { pageHelperAccess } from "../middleware/pageHelperAccess.js";
import { resolveDesignationViewsSelectFields } from "../config/view-fields/designation.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("designations", "view"), getDesignations);
router.post("/get", authenticate, accessControl("designations", "view"), getDesignationById);
router.post("/create", authenticate, accessControl("designations", "add"), createDesignation);
router.post("/update", authenticate, accessControl("designations", "edit"), updateDesignationData);
router.post("/delete", authenticate, accessControl("designations", "delete"), deleteDesignationData);
router.post("/helper", authenticate, pageHelperAccess(resolveDesignationViewsSelectFields), getDesignationsHelper);

export default router;
