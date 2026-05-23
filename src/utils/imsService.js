import fetch from "node-fetch";
import { noteImsIssue } from "./imsMeta.js";

const IMS_URL = process.env.IMS_BASE_URL?.trim() || "http://192.168.1.100:3200/data/imsdata";
const IMS_FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.IMS_FETCH_TIMEOUT_MS) || 15000);

/** Auth (`checkpass`) must still throw on transport failure so login returns 503, not a fake wrong password. */
export const fetchFromIMS = async (requestedData, filter = {}) => {
  const isCheckpass = requestedData === "checkpass";
  try {
    const body = { requestedData };
    if (Object.keys(filter).length > 0) {
      body.filter = filter;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMS_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(IMS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json;
    try {
      json = text && String(text).trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error("IMS returned invalid JSON");
    }

    if (!json.success) {
      if (isCheckpass) {
        throw new Error(json.message || "IMS API failed");
      }
      noteImsIssue(json.message || "IMS request failed.");
      return [];
    }
    return json.records;
  } catch (error) {
    console.error("IMS API Error:", error.message);
    if (isCheckpass) throw error;
    noteImsIssue(error.message || "IMS connection failed.");
    return [];
  }
};
