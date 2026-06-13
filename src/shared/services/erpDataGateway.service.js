import fetch from "node-fetch";
import config from "../../config/config.js";

export function getErpDataGatewayUrl() {
  return config.erpInternalApi.url;
}

function buildBody(requestedData, filter) {
  const body = { requestedData };
  if (filter != null && typeof filter === "object" && !Array.isArray(filter)) {
    body.filter = filter;
  }
  return body;
}

/** POST { requestedData, filter } to IMS data API */
export async function postErpDataGateway(requestedData, filter) {
  const timeoutMs = config.erpInternalApi.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(config.erpInternalApi.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(requestedData, filter)),
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

    return { httpOk: response.ok, json, status: response.status };
  } catch (err) {
    const message = err?.cause?.message || err?.message || String(err);
    return { httpOk: false, json: { success: false, message }, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}
