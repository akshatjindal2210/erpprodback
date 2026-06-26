import { Router } from "express";
import { loginUser, logoutUser, getUsers, getImsUsers, createUser, updateUser, deleteUser, getMe, changePassword, getUserStats, getUserById, getUsersViews } from "../controllers/user.controller.js";
import { authenticate } from "../middleware/auth.js";
import { accessControl } from "../middleware/accessControl.js";

const router = Router();

router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.get("/me", authenticate, getMe);
router.put("/password", authenticate, changePassword);
router.get("/stats", authenticate, getUserStats);

router.post("/users/list", authenticate, accessControl("users", "view"), getUsers);
router.post("/users/ims", authenticate, accessControl("users", "view"), getImsUsers);
router.post("/users/get", authenticate, accessControl("users", "view"), getUserById);
router.post("/users/create", authenticate, accessControl("users", "add"), createUser);
router.post("/users/update", authenticate, accessControl("users", "edit"), updateUser);
router.post("/users/delete", authenticate, accessControl("users", "delete"), deleteUser);
router.post("/users/helper", authenticate, getUsersViews);

export default router;
