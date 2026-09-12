import { Router } from "express";
import masterRoutes from "../modules/master/routes/master.routes.js";
import shortageRoutes from "../modules/shortage/routes/shortage.route.js";

const router = Router();

router.use("/master", masterRoutes);
router.use("/shortage", shortageRoutes);

export default router;
