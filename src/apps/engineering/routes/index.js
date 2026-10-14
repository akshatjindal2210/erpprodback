import { Router } from "express";
import { authenticate } from "../../core/lib/middleware/auth.js";
import { accessControl } from "../../core/lib/middleware/accessControl.js";
import processMasterRoutes from "../modules/process-master/routes/processMaster.route.js";
import machineMasterRoutes from "../modules/machine-master/routes/machineMaster.route.js";
import primeItemMasterRoutes from "../modules/prime-item-master/routes/primeItemMaster.route.js";
import finishProcessMasterRoutes from "../modules/finish-process-master/routes/finishProcessMaster.route.js";

const router = Router();

router.use("/process-master", processMasterRoutes);
router.use("/machine-master", machineMasterRoutes);
router.use("/prime-item-master", primeItemMasterRoutes);
router.use("/finish-process-master", finishProcessMasterRoutes);

export default router;
