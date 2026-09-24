import express from "express";
import { getDesignations, getDesignationById, createDesignation, updateDesignationData, deleteDesignationData, getDesignationsHelper } from "../controllers/designation.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();

router.post("/list", authenticate, accessControl("designations", "view"), getDesignations);
router.post("/get", authenticate, accessControl("designations", "view"), getDesignationById);
router.post("/create", authenticate, accessControl("designations", "add"), createDesignation);
router.post("/update", authenticate, accessControl("designations", "edit"), updateDesignationData);
router.post("/delete", authenticate, accessControl("designations", "delete"), deleteDesignationData);
router.post("/helper", authenticate, helperAccess("designations"), getDesignationsHelper);

export default router;
