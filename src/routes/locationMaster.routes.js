import express from "express";
import { getLocations, getLocationById, createLocation, updateLocation, deleteLocation, getLocationsViews, getLocationViewById } from "../controllers/locationMaster.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

// List
router.post("/list", authenticate, accessControl("location_master", "view"), getLocations);

// Get single
router.post("/get", authenticate, accessControl("location_master", "view"), getLocationById);

// Create
router.post("/create", authenticate, accessControl("location_master", "add"), createLocation);

// Update (allow both edit users and authorize users)
router.post("/update", authenticate, accessControl("location_master", ["edit", "authorize"]), updateLocation);

// Delete
router.post("/delete", authenticate, accessControl("location_master", "delete"), deleteLocation);

// Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getLocationsViews);
// router.post("/view-get", authenticate, dynamicAccessControl(), getLocationViewById);

export default router;