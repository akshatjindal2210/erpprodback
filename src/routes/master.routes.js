import express from "express";
import { authenticate } from "../middleware/auth.js";
import { getItems, getItemById, getLedgers, getLedgerById, getPartyRates, getDailyProd, getPackByFinancialYearDoc, resolvePartyRateCustCodeForSticker, getItemsViews, getLedgersViews, getPartyRatesViews, getDailyProdViews } from "../controllers/master.controller.js";
import { accessControl, dynamicAccessControl, accessControlAny } from "../middleware/accessControl.js";

const router = express.Router();

/*// ─── Items (dynamic: e.g. product_master from Product pages, packing_standard from Packing Standard modal) */
router.post("/items/list",   authenticate, accessControl("product_master", "view"), getItems);
router.post("/items/get",    authenticate, accessControl("product_master", "view"), getItemById);

// ─── Ledger (dynamic: customer_master OR packing_standard, etc.)
router.post("/ledgers/list", authenticate, accessControl("customer_master", "view"), getLedgers);
router.post("/ledgers/get",  authenticate, accessControl("customer_master", "view"), getLedgerById);

// ─── Party Rate
router.post("/party-rates/list", authenticate, accessControl("customer_item_code", "view"), getPartyRates);
/** One customer+item narr1 lookup (sticker UI). Not `/party-rates/helper` (full IMS list). */
router.post("/party-rates/resolve-cust-code", authenticate, accessControlAny([{ moduleName: "packing_entry", actions: ["view", "add", "edit"] }]), resolvePartyRateCustCodeForSticker);

// ─── Daily Prod
router.post("/daily-prod/list",  authenticate, accessControl("packing_entry", "view"), getDailyProd);
router.post("/daily-prod/pack-by-fy", authenticate, dynamicAccessControl(), getPackByFinancialYearDoc);

// ─── Helper Views
router.post("/items/helper", authenticate, dynamicAccessControl(), getItemsViews);
router.post("/ledgers/helper", authenticate, dynamicAccessControl(), getLedgersViews);
router.post("/party-rates/helper", authenticate, dynamicAccessControl(), getPartyRatesViews);
router.post("/daily-prod/helper", authenticate, dynamicAccessControl(), getDailyProdViews);

export default router;