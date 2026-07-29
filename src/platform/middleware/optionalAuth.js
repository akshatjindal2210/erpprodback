import jwt from "jsonwebtoken";
import config from "../../config/app/config.js";
import User from "../../apps/core/identity/users/models/user.model.js";

/** Sets req.user when a valid session cookie exists; otherwise continues without auth. */
export const optionalAuthenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.[config.cookie_name] || req.headers.authorization?.split(" ")[1];
    if (!token) return next();

    const decoded = jwt.verify(token, config.jwt_secret);
    const user = await User.getById(decoded.id);
    if (user?.status === "active") {
      req.user = user;
    }
  } catch {
    /* ignore invalid/expired token for optional auth */
  }
  next();
};
