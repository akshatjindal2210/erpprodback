import { AsyncLocalStorage } from "node:async_hooks";

const imsAls = new AsyncLocalStorage();

const IMS_INTERNAL_MSG = /requested\s*data|requested\s*date|`requested/i;

/** Raw IMS / SQL wording users should never see in toasts. */
const IMS_TECHNICAL_MSG =
  /database\s*query\s*failed|query\s*failed|sql\s*error|syntax\s*error|invalid\s*input\s*syntax|relation\s+".+"\s+does\s+not\s+exist|column\s+".+"\s+does\s+not\s+exist|permission\s+denied\s+for|internal\s+server\s+error|unhandled|stack\s*trace|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i;

/** Strip IMS-internal / technical errors — show a clear user-facing message instead. */
export function toPublicImsMessage(message, fallback = "ERP (IMS) data could not be loaded.") {
  const m = String(message ?? "").trim();
  if (!m || IMS_INTERNAL_MSG.test(m) || IMS_TECHNICAL_MSG.test(m)) return fallback;
  if (/^request to https?:\/\//i.test(m) || /socket hang up|fetch failed|aborted|ECONNRESET|EPIPE/i.test(m)) {
    return "IMS ERP server unreachable. Contact admin or try again when the IMS service is online.";
  }
  return m;
}

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
  s.reasons.push(toPublicImsMessage(message));
}

/** Schedule-planning (and similar) APIs: plain JSON only — no `ims_meta` on the response. */
export function clearImsMetaForResponse() {
  const s = imsAls.getStore();
  if (!s) return;
  s.unavailable = false;
  s.reasons.length = 0;
}
