import jwt from "jsonwebtoken";
import dbQuery from "../../../config/db.js";
import config from "../../../config/config.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

function getTokenFromRequest(req) {
  const fromCookie = req.cookies?.[config.cookie_name];
  if (fromCookie) return fromCookie;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return null;
}

export const authenticate = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);

    if (!token)
      return res.status(401).json({ success: false, message: "Unauthorized no token" });

    const decoded = jwt.verify(token, config.jwt_secret);
// console.log("__ auth __",decoded);
    const [user] = await dbQuery(
      `SELECT id, name, username, email, type, status, auth_source, usercode FROM ${M.USERS} WHERE id = $1`,
      [decoded.id]
    );

    if (!user)
      return res.status(401).json({ success: false, message: "User session not found" });

    if (user.status !== "active")
      return res.status(403).json({ success: false, message: "Account suspended or inactive" });
// console.log("__ auth __",user);
    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ success: false, message: "Token expired" });
    if (err.name === "JsonWebTokenError")
      return res.status(401).json({ success: false, message: "Invalid token" });
    res.status(500).json({ success: false, message: err.message });
  }
};

export const authorize = (...allowedTypes) => (req, res, next) => {
  if (!req.user || !allowedTypes.includes(req.user.type))
    return res.status(403).json({ success: false, message: "Forbidden insufficient role" });
  next();
};