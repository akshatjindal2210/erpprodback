import jwt from "jsonwebtoken";
import config from "../../../config/config.js";
import User from "../models/user.model.js";

export const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.[config.cookie_name] || req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ success: false, message: "Unauthorized — no token" });
    }

    const decoded = jwt.verify(token, config.jwt_secret);
    // console.log("[Auth Middleware] Decoded token:", decoded);
    const user = await User.getById(decoded.id);

    if (!user) {
      console.warn(`[Auth Middleware] User not found for ID: ${decoded.id}`);
      return res.status(401).json({ success: false, message: "User session not found" });
    }

    if (user.status !== "active") {
      return res.status(403).json({ success: false, message: "Account suspended or inactive" });
    }

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
  if (!req.user || !allowedTypes.includes(req.user.type)) {
    return res.status(403).json({ success: false, message: "Forbidden: insufficient permissions" });
  }
  next();
};
