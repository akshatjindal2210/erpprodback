import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { getUserAppPreference, setUserAppPreference } from "../controllers/userAppPreference.controller.js";

const router = Router();

router.use(authenticate);
router.get("/", getUserAppPreference);
router.put("/", setUserAppPreference);

export default router;
