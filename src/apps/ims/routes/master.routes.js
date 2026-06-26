import express from "express";
import { authenticate } from "../middleware/auth.js";
import { getItems, getItemById, getLedgers, getLedgerById, getPartyRates, getDailyProd, getPackByFinancialYearDoc, resolvePartyRateCustCodeForSticker, getItemsViews, getLedgersViews, getPartyRatesViews, getDailyProdViews, getFinancialYears } from "../controllers/master.controller.js";
import { accessControl, dynamicAccessControl, accessControlAny } from "../../core/middleware/accessControl.js";
import { helperAccess } from "../config/helperViews.js";

const router = express.Router();

router.post("/items/list",   authenticate, accessControl("product_master", "view"), getItems);
router.post("/items/get",    authenticate, accessControl("product_master", "view"), getItemById);

router.post("/ledgers/list", authenticate, accessControl("customer_master", "view"), getLedgers);
router.post("/ledgers/get",  authenticate, accessControl("customer_master", "view"), getLedgerById);

router.post("/party-rates/list", authenticate, accessControl("customer_item_code", "view"), getPartyRates);
router.post("/party-rates/resolve-cust-code", authenticate, accessControlAny([{ moduleName: "packing_entry", actions: ["view", "add", "edit"] }]), resolvePartyRateCustCodeForSticker);

router.post("/daily-prod/list",  authenticate, accessControl("packing_entry", "view"), getDailyProd);
router.post("/daily-prod/pack-by-fy", authenticate, dynamicAccessControl(), getPackByFinancialYearDoc);

router.post("/items/helper", authenticate, helperAccess("items"), getItemsViews);
router.post("/ledgers/helper", authenticate, helperAccess("ledgers"), getLedgersViews);
router.post("/party-rates/helper", authenticate, helperAccess("partyRates"), getPartyRatesViews);
router.post("/daily-prod/helper", authenticate, helperAccess("dailyProd"), getDailyProdViews);
router.post("/financial-years", authenticate, getFinancialYears);

export default router;
