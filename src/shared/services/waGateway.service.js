import fetch from "node-fetch";
import config from "../../config/config.js";

const REQUESTED_DATA = "sendmessage";

function buildBody(filter) {
  return { requestedData: REQUESTED_DATA, filter };
}

export function resolveWaMessageUrl(templateKey) {
  return templateKey === "daily_reminder" ? config.waApi.swap : config.waApi.swa;
}

/** POST task notification to /wa/swa (instant) or /wa/swap (daily). */
export async function postWaMessage(templateKey, filter) {
  const url = resolveWaMessageUrl(templateKey);
  const timeoutMs = config.waApi.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(filter)),
      signal: controller.signal,
    });

    const text = await response.text();
    let json = {};
    if (text?.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { success: false, message: "Non-JSON response" };
      }
    }

    return { httpOk: response.ok, json, status: response.status, url };
  } catch (err) {
    const message = err?.cause?.message || err?.message || String(err);
    return { httpOk: false, json: { success: false, message }, status: 0, url };
  } finally {
    clearTimeout(timer);
  }
}
