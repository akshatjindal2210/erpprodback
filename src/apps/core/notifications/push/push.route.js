import { Router } from "express";
import { authenticate, authorize } from "../../lib/middleware/auth.js";
import { optionalAuthenticate } from "../../lib/middleware/optionalAuth.js";
import { getPushPublicKey, savePushSubscription, linkPushSubscription, unlinkPushSubscription, unsubscribePush, sendPushNotification, reportPushReceived, reportPushRead, getPushLogs } from "./push.controller.js";

const router = Router();
const superAdmin = authorize("super_admin");

router.get("/vapid-public-key", getPushPublicKey);
router.post("/subscribe", optionalAuthenticate, savePushSubscription);
router.post("/link", authenticate, linkPushSubscription);
router.post("/unlink", authenticate, unlinkPushSubscription);
router.post("/unsubscribe", optionalAuthenticate, unsubscribePush);
router.post("/delivery/received", reportPushReceived);
router.post("/delivery/read", reportPushRead);
router.get("/logs", authenticate, superAdmin, getPushLogs);
router.post("/send", authenticate, superAdmin, sendPushNotification);

export default router;
