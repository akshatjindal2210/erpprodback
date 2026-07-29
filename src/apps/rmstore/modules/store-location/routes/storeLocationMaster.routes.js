import express from "express";
import { getLocations, getLocationById, createLocation, updateLocation, deleteLocation, getLocationsViews } from "../controllers/storeLocationMaster.controller.js";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { helperAccess } from "../../../lib/config/views/helperViews.js";

const router = express.Router();

const MODULE = "rm_store_location_master";

router.post("/list", authenticate, accessControl(MODULE, "view"), getLocations);
router.post("/get", authenticate, accessControl(MODULE, "view"), getLocationById);
router.post("/create", authenticate, accessControl(MODULE, "add"), createLocation);
router.post("/update", authenticate, accessControl(MODULE, ["edit", "authorize"]), updateLocation);
router.post("/delete", authenticate, accessControl(MODULE, "delete"), deleteLocation);
router.post("/helper", authenticate, helperAccess("locations"), getLocationsViews);

export default router;
