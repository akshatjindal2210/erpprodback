import fetch from "node-fetch";
import config from "../../config/config.js";

function buildBody(requestedData, filter) {
  return { requestedData, filter };
}

/** Paid → swpa; free → swa. Daily reminder keeps paid channel when WhatsApp is on. */
export function resolveWaRequestedData(templateKey, sendVia) {
  const via = String(sendVia ?? "");
  const key = String(templateKey ?? "");
  if (via === "none") return "swa";
  if (via === "paid" || via === "whatsapp_2") return "swpa";
  if (key === "daily_reminder") return "swpa";
  return "swa";
}

export function resolveWaMessageUrl() {
  return config.waApi.url;
}

/** POST /send/wa — requestedData swa (normal) or swpa (paid). */
export async function postWaMessage(templateKey, filter, sendVia) {
  const url = resolveWaMessageUrl();
  const requestedData = resolveWaRequestedData(templateKey, sendVia);
  const timeoutMs = config.waApi.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
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

    return { httpOk: response.ok, json, status: response.status, url, requestedData };
  } catch (err) {
    const message = err?.cause?.message || err?.message || String(err);
    return {
      httpOk: false,
      json: { success: false, message },
      status: 0,
      url,
      requestedData,
    };
  } finally {
    clearTimeout(timer);
  }
}
