import fetch from "node-fetch";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DASHBOARD_QUERY_TIMEOUT_MS } from "./widgetQuery.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// true = Allow all public domains + hosts listed in ALLOWED_HOSTS (current mode)
// false = Allow ONLY the IPs/domains listed in ALLOWED_HOSTS (strict mode for future use)
const ALLOW_ALL_DOMAINS = true;

// Add new IPs or domains here in the future
const ALLOWED_HOSTS = new Set([
  "192.168.1.100",
  // "192.168.1.101", 
  // "api.example.com"
]);

function isAllowedHost(hostOrIp) {
  if (ALLOW_ALL_DOMAINS) return true;
  const cleanHost = String(hostOrIp || "").replace(/^\[|\]$/g, "").toLowerCase();
  return ALLOWED_HOSTS.has(cleanHost);
}

function isPrivateAddress(rawAddress) {
  const address = String(rawAddress || "").split("%")[0].toLowerCase();
  
  if (isAllowedHost(address)) return false;

  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0)
      || a >= 224;
  }

  if (isIP(address) === 6) {
    if (address === "::" || address === "::1") return true;
    if (/^(fc|fd)/.test(address) || /^fe[89ab]/.test(address) || address.startsWith("2001:db8:")) {
      return true;
    }
    const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mappedIpv4 ? isPrivateAddress(mappedIpv4) : false;
  }
  
  return true;
}

async function assertSafeUrl(rawUrl) {
  const url = new URL(validateJsonUrl(rawUrl));
  if (url.username || url.password) {
    throw new Error("API URL must not contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isAllowedHost(hostname) && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new Error("API URL cannot target localhost or a private network.");
  }

  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("API URL host could not be resolved.");
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("API URL cannot target localhost or a private network.");
  }
  return url;
}

export function validateJsonUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error("API URL is required.");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid API URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("API URL must not contain embedded credentials.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // ONLY 2 LINES ADDED HERE FOR STRICT MODE
  if (!ALLOW_ALL_DOMAINS && !isAllowedHost(hostname)) {
    throw new Error("Target host is not allowed.");
  }

  if (!isAllowedHost(hostname) && (hostname === "localhost"
    || hostname.endsWith(".localhost")
    || (isIP(hostname) && isPrivateAddress(hostname)))) {
    throw new Error("API URL cannot target localhost or a private network.");
  }
  return url.toString();
}

export function normalizeUrlRequestOptions(options = {}) {
  const method = String(options?.method || "GET").trim().toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error("URL data source only supports GET or POST.");
  }

  const rawBody = String(options?.body || "").trim();
  let body;
  if (method === "POST" && rawBody) {
    try {
      body = JSON.stringify(JSON.parse(rawBody));
    } catch {
      throw new Error("POST body must be valid JSON.");
    }
  }

  const excludedColumns = Array.isArray(options?.excludedColumns)
    ? options.excludedColumns.map((column) => String(column)).filter(Boolean)
    : [];
  return { method, body, excludedColumns };
}

/** Prefer row arrays inside common API envelopes over treating the envelope as one row. */
const ARRAY_PAYLOAD_KEYS = ["records", "data", "rows", "items", "results", "result", "list", "values"];

function extractArrayPayload(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 3) return null;

  for (const key of ARRAY_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") {
      const deeper = extractArrayPayload(nested, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

export function normalizeJsonToRows(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") {
    throw new Error("API JSON must be an object or an array.");
  }

  const arrayPayload = extractArrayPayload(json);
  if (arrayPayload) return arrayPayload;
  return [json];
}

function applyExcludedColumns(rows, excludedColumns = []) {
  if (!excludedColumns.length) return rows;
  const excluded = new Set(excludedColumns);
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => !excluded.has(key)),
    );
  });
}

export async function fetchUrlJsonRows(rawUrl, options = {}) {
  let url = new URL(validateJsonUrl(rawUrl));
  const { method, body, excludedColumns } = normalizeUrlRequestOptions(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DASHBOARD_QUERY_TIMEOUT_MS);

  try {
    let requestMethod = method;
    let requestBody = body;
    let response;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      url = await assertSafeUrl(url);
      const headers = { Accept: "application/json" };
      if (requestBody !== undefined) headers["Content-Type"] = "application/json";
      response = await fetch(url, {
        method: requestMethod,
        headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        redirect: "manual",
        size: MAX_RESPONSE_BYTES,
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) break;
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error(`API request exceeded ${MAX_REDIRECTS} redirects.`);
      }
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === "POST")) {
        requestMethod = "GET";
        requestBody = undefined;
      }
    }

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}.`);
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error("API returned invalid JSON.");
    }

    const rows = normalizeJsonToRows(json);
    return applyExcludedColumns(rows, excludedColumns);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`API request timed out after ${DASHBOARD_QUERY_TIMEOUT_MS / 1000} seconds.`);
    }
    if (String(error?.type || "") === "max-size") {
      throw new Error("API response is too large.");
    }
    if (/^(API|Enter)/.test(String(error?.message || ""))) throw error;
    throw new Error(`API request failed: ${error?.message || "Unknown error."}`);
  } finally {
    clearTimeout(timeout);
  }
}