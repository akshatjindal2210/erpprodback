/**
 * Production app routes — mounted at `/api/production`.
 *
 * | Prefix    | Module              | Tables        |
 * |-----------|---------------------|---------------|
 * | `/jc`     | Maintain Job Card   | prod_jc       |
 * | `/plan`   | Production Planning | prod_plan     |
 * | `/master` | Production masters  | (ERP helpers) |
 * | `/shortage`, `/tooling` | Shortage & tooling queues | ims_shortage, prod_jc |
 */
import { Router } from "express";
import masterRoutes from "../modules/master/routes/master.routes.js";
import shortageRoutes from "../modules/shortage/routes/shortage.route.js";
import toolingRoutes from "../modules/tooling/routes/tooling.route.js";
import jcRoutes from "../modules/jc/routes/jc.route.js";
import planRoutes from "../modules/plan/routes/plan.route.js";

const router = Router();

router.use("/master", masterRoutes);
router.use("/shortage", shortageRoutes);
router.use("/tooling", toolingRoutes);
router.use("/jc", jcRoutes);
router.use("/plan", planRoutes);

export default router;
