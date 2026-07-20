/** Same CORS for Express + Socket.IO (from CLIENT_URL). */
import config from "./config.js";

export const corsOptions = {
  origin: [...config.frontend_url],
  credentials: true,
};
