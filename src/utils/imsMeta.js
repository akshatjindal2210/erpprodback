import { AsyncLocalStorage } from "node:async_hooks";

const imsAls = new AsyncLocalStorage();

/**
 * Express middleware: tracks IMS / internal-ERP issues during a request and merges `ims_meta` into successful JSON responses so the client can show a warning toast.
 */
export function imsMetaMiddleware(req, res, next) {
  const store = { unavailable: false, reasons: [] };
  imsAls.run(store, () => {
    const origJson = res.json.bind(res);
    res.json = function imsAwareJson(body) {
      if (store.unavailable && body && typeof body === "object" && !Array.isArray(body)) {
        const reasons = [...new Set(store.reasons)].filter(Boolean);
        body.ims_meta = {
          ok: false,
          message:
            reasons[0] ||
            "ERP (IMS) link failed. Data shown may be incomplete until the connection is restored.",
          reasons,
        };
        try {
          res.setHeader("X-IMS-Available", "0");
        } catch (_) {
          /* ignore */
        }
      }
      return origJson(body);
    };
    next();
  });
}

/** Call from IMS helpers when the internal ERP request failed or returned no usable payload. */
export function noteImsIssue(message) {
  const s = imsAls.getStore();
  if (!s || message == null || String(message).trim() === "") return;
  s.unavailable = true;
  s.reasons.push(String(message).trim());
}
