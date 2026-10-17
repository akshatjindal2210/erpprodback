import { Router } from "express";
import masterRoutes from "../modules/master/routes/master.routes.js";
import shortageRoutes from "../modules/shortage/routes/shortage.route.js";
import jobCardRoutes from "../modules/job-card/routes/jobCard.route.js";
import toolingRoutes from "../modules/tooling/routes/tooling.route.js";

const router = Router();

router.use("/master", masterRoutes);
router.use("/shortage", shortageRoutes);
router.use("/tooling", toolingRoutes);
router.use("/job-card", jobCardRoutes);

export default router;
