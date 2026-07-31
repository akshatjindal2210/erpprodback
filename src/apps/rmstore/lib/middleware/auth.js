/** Re-use core auth (same JWT / user lookup as other apps). */
export { authenticate, authorize } from "../../../core/lib/middleware/auth.js";
