import { Router } from "express";
import recordRoutes from "../modules/record/routes/record.route.js";

/** Copy-kit only — do not mount until this folder has been copied and renamed. */
const router = Router();

router.use("/records", recordRoutes);

export default router;
