import express from "express";
import { getUsers, getUserById, createUser, updateUser, deleteUser, loginUser, logoutUser, getMe, getUsersViews, getImsUsers } from "../controllers/user.controller.js";

import { authenticate } from "../middleware/auth.js";
import { accessControl, dynamicAccessControl } from "../middleware/accessControl.js";

const router = express.Router();

// ── Public Route ───────────────────────────────
router.post("/login", loginUser);

// ── Protected Routes ───────────────────────────
// Get all users
router.post("/list", authenticate, accessControl("users", "view"), getUsers);

// Get IMS users
router.post("/ims-list", authenticate, accessControl("users", "view"), getImsUsers);

// Get user by ID
router.post("/get", authenticate, accessControl("users", "view"), getUserById);

// Create user
router.post("/create", authenticate, accessControl("users", "add"), createUser);

// Update user
router.post("/update", authenticate, accessControl("users", "edit"), updateUser);

// Delete user
router.post("/delete", authenticate, accessControl("users", "delete"), deleteUser);

// Auth Me (GET = browser / health checks; POST = app — both need cookie or Bearer token)
router.get("/me", authenticate, getMe);
router.post("/me", authenticate, getMe);

// Logout
router.post("/logout", authenticate, logoutUser);

// Get Views (Helper API)
router.post("/helper", authenticate, dynamicAccessControl(), getUsersViews);

export default router;