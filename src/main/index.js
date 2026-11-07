import { app, ipcMain, shell, BrowserWindow, WebContentsView, dialog, Menu, net, session, clipboard, nativeImage, screen } from "electron";
import { join, resolve } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import https from "node:https";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled rejection:", reason);
});
function isFreeModel(model) { 
  return /-free$/.test(model || "");
}
const isOpenAiCompat = (provider) => provider === "openai";
function buildHeaders({ model, apiKey }) {
  const headers = { "Content-Type": "application/json" };
  const key = isFreeModel(model) ? "" : (apiKey || "").trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}
const TRANSIENT_STATUSES =  new Set([408, 425, 429, 502, 503, 504]);
const TRANSIENT_PATTERNS = /temporarily unavailable|rate limit|overloaded|timeout|busy|capacity|queue|service unavailable/i;
function isTransientError(status, message) {
  if (TRANSIENT_STATUSES.has(status)) return true;
  return TRANSIENT_PATTERNS.test(message);
}
function textFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).join("");
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "reasoning_content", "reasoning", "thinking", "summary"]) {
      const text = textFromValue(value[key]);
      if (text) return text;
    }
  }
  return "";
}
function collectReasoning(source) {
  const parts = [];
  const add = (value) => {
    const text = textFromValue(value);
    if (text && !parts.includes(text)) parts.push(text);
  };
  add(source?.reasoning_content);
  add(source?.reasoning);
  add(source?.thinking);
  if (Array.isArray(source?.reasoning_details)) {
    source.reasoning_details.forEach((detail) => add(detail?.text ?? detail?.content ?? detail));
  }
  return parts.join("");
}
function mergeReasoning(...values) {
  const parts = [];
  values.forEach((value) => {
    const text = textFromValue(value);
    if (text && !parts.includes(text)) parts.push(text);
  });
  return parts.join("");
}
function splitEmbeddedReasoning(value) {
  const text = textFromValue(value);
  const content = [];
  const reasoning = [];
  let cursor = 0;
  let inReasoning = false;
  const tagPattern = /<\/?(?:think|thinking|analysis|reasoning)>/gi;
  let match;
  while (match = tagPattern.exec(text)) {
    (inReasoning ? reasoning : content).push(text.slice(cursor, match.index));
    inReasoning = match[0][1] !== "/";
    cursor = tagPattern.lastIndex;
  }
  (inReasoning ? reasoning : content).push(text.slice(cursor));
  return { content: content.join(""), reasoning: reasoning.join("") };
}
function createContentRouter(onChunk, onReasoning) {
  const tagCandidates = [
    "<think>",
    "</think>",
    "<thinking>",
    "</thinking>",
    "<analysis>",
    "</analysis>",
    "<reasoning>",
    "</reasoning>"
  ];
  const tagPattern = /<\/?(?:think|thinking|analysis|reasoning)>/i;
  let pending = "";
  let inReasoning = false;
  const emit = (text) => {
    if (!text) return;
    if (inReasoning) onReasoning?.(text);
    else onChunk?.(text);
  };
  const partialTagLength = (text) => {
    const lower = text.toLowerCase();
    for (let length = Math.min(lower.length, 12); length > 0; length -= 1) {
      const suffix = lower.slice(-length);
      if (tagCandidates.some((tag) => tag.startsWith(suffix))) return length;
    }
    return 0;
  };
  const feed = (value) => {
    const text = textFromValue(value);
    if (!text) return;
    pending += text;
    while (true) {
      const match = pending.match(tagPattern);
      if (!match) break;
      emit(pending.slice(0, match.index));
      inReasoning = match[0][1] !== "/";
      pending = pending.slice(match.index + match[0].length);
    }
    const keep = partialTagLength(pending);
    emit(pending.slice(0, pending.length - keep));
    pending = pending.slice(pending.length - keep);
  };
  const flush = () => {
    emit(pending);
    pending = "";
  };
  return { feed, flush };
}
function buildChatBody({ model, messages, stream, provider, reasoningEffort }) {
  const body = { model, messages, stream };
  const effort = ["low", "medium", "high", "max"].includes(String(reasoningEffort || "").toLowerCase())
    ? String(reasoningEffort).toLowerCase()
    : "high";
  if (provider === "ollama") {
    body.think = effort === "max" ? "high" : effort;
  } else {
    body.reasoning_effort = effort === "max" ? "high" : effort;
    if (/claude/i.test(String(model))) {
      const budget = effort === "low" ? 1024 : effort === "medium" ? 8192 : effort === "high" ? 16384 : 32768;
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  return body;
}

async function chatSend({ url, model, messages, provider, apiKey, org, reasoningEffort, envConfig: envConfig2 }) {
  const headers = buildHeaders({ model, apiKey, envConfig: envConfig2 });
  const isOpenAI = isOpenAiCompat(provider);
  let body = buildChatBody({ model, messages, stream: false, provider, reasoningEffort });
  let attempt = 0;
  const maxAttempts = 5;
  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
    } catch (err) {
      const msg = err.message || "Network error";
      if (attempt < maxAttempts - 1 && /ssl|handshake|certificate|network|econnreset|etimedout|enotfound/i.test(msg)) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, error: msg };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let data2 = null;
      try { data2 = text ? JSON.parse(text) : null } catch { data2 = null }
      const detail = data2?.error?.message || (typeof data2?.error === 'string' ? data2.error : null) || text || `HTTP ${res.status}`
      const error2 = `${res.status} ${res.statusText || 'Error'}: ${detail}`.slice(0, 500)
      if (attempt < maxAttempts - 1 && isTransientError(res.status, error2)) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, error: error2, status: res.status };
    }
    const data = await res.json().catch(() => null);
    const error = data?.error?.message || data?.error || null;
    if (error && isTransientError(res.status, error) && attempt < maxAttempts - 1) {
      attempt += 1;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const responseMessage = isOpenAI ? data?.choices?.[0]?.message : data?.message;
    const embedded = splitEmbeddedReasoning(responseMessage?.content);
    const content = embedded.content;
    const reasoning = mergeReasoning(collectReasoning(responseMessage), embedded.reasoning);
    return {
      ok: true,
      data: { message: { content }, reasoning },
      diagnostics: {
        usage: data?.usage,
        finish_reason: data?.choices?.[0]?.finish_reason || data?.done_reason
      }
    };
  }
}
async function chatSendStream({ url, model, messages, provider, apiKey, org, reasoningEffort, envConfig: envConfig2 }, { signal, onChunk, onReasoning }) {
  const headers = buildHeaders({ model, apiKey, envConfig: envConfig2 });
  const isOpenAI = isOpenAiCompat(provider);
  const body = buildChatBody({ model, messages, stream: true, provider, reasoningEffort });
  let attempt = 0;
  const maxAttempts = 5;
  let res;
  while (true) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
    } catch (err) {
      const msg = err.message || "Network error";
      if (attempt < maxAttempts - 1 && /ssl|handshake|certificate|network|econnreset|etimedout|enotfound/i.test(msg)) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, error: msg };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let data = null;
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      const detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || text || `HTTP ${res.status}`
      const error = `${res.status} ${res.statusText || 'Error'}: ${detail}`.slice(0, 500)
      if (attempt < maxAttempts - 1 && isTransientError(res.status, error)) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, error, status: res.status };
    }
    break;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const contentRouter = createContentRouter(onChunk, onReasoning);
  let aborted = false;
  if (signal) {
    if (signal.aborted) aborted = true;
    signal.addEventListener("abort", () => {
      aborted = true;
    });
  }
  const routeContent = (text) => contentRouter.feed(text);
  while (true) {
    if (aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf(isOpenAI ? "\n\n" : "\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (isOpenAI ? 2 : 1));
      if (!block.trim()) continue;
      if (isOpenAI) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          const reasoning = collectReasoning(delta);
          if (reasoning) onReasoning(reasoning);
          routeContent(delta?.content);
        }
      } else {
        let chunk;
        try {
          chunk = JSON.parse(block);
        } catch {
          continue;
        }
        const reasoning = collectReasoning(chunk.message);
        if (reasoning) onReasoning(reasoning);
        routeContent(chunk.message?.content);
      }
    }
  }
  contentRouter.flush();
  return aborted ? { ok: true, aborted: true } : { ok: true };
}
async function webFetchStream(url, { signal, onChunk, onReasoning }) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0" } });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text") && !contentType.includes("json")) {
    return { ok: false, error: `Unsupported content type: ${contentType}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const contentRouter = createContentRouter(onChunk, onReasoning);
  const routeContent = (text) => contentRouter.feed(text);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      routeContent(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (err.name === "AbortError") return { ok: true, aborted: true };
    return { ok: false, error: err.message };
  }
  contentRouter.flush();
  return { ok: true };
}
const isWindows11 = process.platform === "win32" && Number(os.release().split(".")[2] || 0) >= 22e3;
try {
  const envPath = join(app.getAppPath(), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
} catch {
}
function getGoogleClientId() {
  return (process.env.GOOGLE_CLIENT_ID || "").trim();
}

async function applyProxyFromEnv() {
  const proxy = (
    process.env.CILAMAI_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    ""
  ).trim();
  if (!proxy) return;
  let proxyRules = proxy;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyRules) && !proxyRules.includes("=")) {
    proxyRules = `http://${proxyRules}`;
  }
  try {
    await session.defaultSession.setProxy({ proxyRules });
    console.log(`[Proxy] Using ${proxyRules}`);
  } catch (err) {
    console.warn(`[Proxy] Failed to apply ${proxyRules}:`, err?.message || err);
  }
}

const OAUTH_FETCH_TIMEOUT_MS = 30e3;
const OAUTH_FETCH_ATTEMPTS = 3;

function describeOAuthNetworkError(err, host) {
  const code = err?.cause?.code || err?.code || "";
  const detail = err?.cause?.message || err?.message || String(err || "Unknown network error");
  let hint = "Check your internet connection or proxy settings.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) {
    hint = "Check your internet connection and DNS settings.";
  } else if (/ECONNREFUSED|ECONNRESET|CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)) {
    hint = "Check your internet connection, firewall, VPN, or proxy settings.";
  }
  return `Could not reach ${host} to finish signing in. ${hint} (${code || detail})`;
}

async function oauthFetch(url, options = {}) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
  }
  let lastError = null;
  for (let attempt = 0; attempt < OAUTH_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_FETCH_TIMEOUT_MS);
    try {
      return await net.fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      lastError = err;
      console.warn(
        `[OAuth] Request to ${host} failed (attempt ${attempt + 1}/${OAUTH_FETCH_ATTEMPTS}):`,
        err?.cause?.code || err?.message || err
      );
    } finally {
      clearTimeout(timer);
    }
    if (attempt < OAUTH_FETCH_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 1e3 * 2 ** attempt));
    }
  }
  const error = new Error(describeOAuthNetworkError(lastError, host));
  error.cause = lastError;
  throw error;
}
const OAUTH_BIND_HOST = "127.0.0.1";
const OAUTH_PORTS = Array.from({ length: 11 }, (_, i) => 3e3 + i);
const OAUTH_TIMEOUT_MS = 5 * 60 * 1e3;
function describeOAuthRedirectError(rawError, redirectUri) {
  const msg = String(rawError || "");
  if (/redirect_uri_mismatch|redirect_uri\b.*mismatch|invalid_grant|incorrect_redirect_uri/i.test(msg)) {
    return [
      "OAuth error: redirect_uri_mismatch.",
      `The sign-in flow used redirect_uri: ${redirectUri}`,
      "Add that exact value (same scheme, host, port, and no trailing slash) to the Authorized redirect URIs of your OAuth client, save, wait a minute, then try again."
    ].join(" ");
  }
  return msg;
}
function resolveOAuthCallback() {
  const configured = (process.env.OAUTH_REDIRECT_URI || "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (!/^https?:$/.test(url.protocol)) throw new Error("must be an http(s) URI");
      if (!url.port) throw new Error("must include an explicit port");
      return { ports: [Number(url.port)], pinned: true, redirectFor: () => configured };
    } catch (err) {
      console.warn(`[OAuth] Ignoring invalid OAUTH_REDIRECT_URI (${err.message}): ${configured}`);
    }
  }
  return {
    ports: OAUTH_PORTS,
    pinned: false,
    redirectFor: (port) => `http://${OAUTH_BIND_HOST}:${port}`
  };
}
const streamControllers =  new Map();
const TRANSIENT_STATUSES_MAIN =  new Set([408, 425, 429, 502, 503, 504]);
const TRANSIENT_MESSAGES = /temporarily unavailable|rate limit|overloaded|timeout|busy|capacity|queue/i;
async function sendWithRetry(fn, attempts = 5) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await fn();
    if (last?.ok !== false && last?.error == null) return last;
    const isTransient = TRANSIENT_STATUSES_MAIN.has(last?.status) || TRANSIENT_MESSAGES.test(last?.error || "");
    if (!isTransient || attempt >= attempts - 1) return last;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return last;
}
let pendingApiKey = null;
let sessionFile = null;
let sessionWriteTimer = null;
let windowStateFile = null;
function getSessionFile() {
  if (sessionFile) return sessionFile;
  sessionFile = join(app.getPath("userData"), "sessions.json");
  return sessionFile;
}
function getWindowStateFile() {
  if (windowStateFile) return windowStateFile;
  windowStateFile = join(app.getPath("userData"), "window-state.json");
  return windowStateFile;
}
function getReleaseNotesFile() {
  return join(app.getPath("userData"), "release-notes.json");
}
function loadReleaseNotes() {
  try {
    const text = readFileSync(getReleaseNotesFile(), "utf8");
    return JSON.parse(text);
  } catch {
    return { lastShownVersion: "0.0.0" };
  }
}
function saveReleaseNotes(data) {
  try {
    writeFile(getReleaseNotesFile(), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save release notes data:", err);
  }
}
// A frameless but resizable window on Windows keeps an invisible resize border
// inside its bounds, so getBounds() describes a rect larger than the visible UI.
// Persisting and restoring the *content* bounds keeps the sidebar flush with the
// window edge and keeps a window left at a screen edge reachable on next start.
function applyRestoredWindowBounds(win, state) {
  try {
    const current = win.getContentBounds();
    const size = (value, fallback) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const axis = (value, fallback) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? n : fallback;
    };
    const width = Math.max(1000, size(state?.width, current.width));
    const height = Math.max(700, size(state?.height, current.height));
    const x = axis(state?.x, current.x);
    const y = axis(state?.y, current.y);
    const area = screen.getDisplayNearestPoint({ x, y }).workArea;
    const margin = 40;
    const clampedX = Math.min(Math.max(x, area.x - width + margin), area.x + area.width - margin);
    const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - margin);
    win.setContentBounds({ x: clampedX, y: clampedY, width, height });
  } catch (err) {
    console.error("Failed to restore window bounds:", err);
  }
}

function loadWindowState() {
  try {
    const text = readFileSync(getWindowStateFile(), "utf8");
    return JSON.parse(text);
  } catch {
    return { maximized: true, width: 1440, height: 900 };
  }
}
function saveWindowState(state) {
  try {
    writeFile(getWindowStateFile(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save window state:", err);
  }
}
function loadSessionsFromDisk() {
  try {
    const text = readFileSync(getSessionFile(), "utf8");
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}
function scheduleSessionWrite(data) {
  clearTimeout(sessionWriteTimer);
  sessionWriteTimer = setTimeout(async () => {
    try {
      await writeFile(getSessionFile(), JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to write sessions:", err);
    }
  }, 300);
}
let envConfig = { googleSearchKey: "", googleSearchCx: "", ollamaUrl: "https://ollama.com", ollamaApiKey: "50b5b19e0b6640408bcf831407450c3d.677Vh0R7CgcYdVv7YUINWBLE" };
function loadEnvConfig() {
  const candidates = [
    join(app.getAppPath(), ".env"),
    join(app.getPath("userData"), ".env")
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1].toUpperCase();
        const value = m[2].replace(/^["']|["']$/g, "");
        if (key === "GOOGLE_SEARCH_KEY") envConfig.googleSearchKey = value;
        if (key === "GOOGLE_SEARCH_CX") envConfig.googleSearchCx = value;
        if (key === "OLLAMA_URL") envConfig.ollamaUrl = value;
        if (key === "OLLAMA_API_KEY") envConfig.ollamaApiKey = value;
      }
      if (envConfig.ollamaApiKey || envConfig.ollamaUrl) break;
    } catch {
      continue;
    }
  }
}
loadEnvConfig();
function extractApiKey(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--set-apikey=")) return arg.slice(13);
    if (arg.startsWith("--api-key=")) return arg.slice(10);
    if (arg.startsWith("--apikey=")) return arg.slice(9);
    if (arg === "--set-apikey" || arg === "--api-key" || arg === "--apikey") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return null;
}
function extractIpcCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--ipc=")) return arg.slice(6);
    if (arg === "--ipc") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return null;
}
function extractAvatar(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--avatar=")) return arg.slice(9);
    if (arg.startsWith("--user-avatar=")) return arg.slice(14);
    if (arg === "--avatar" || arg === "--user-avatar") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return null;
}
function extractUser(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--user=")) return arg.slice(7);
    if (arg === "--user") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return null;
}
function extractModelArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--model=")) return arg.slice(8);
    if (arg === "--model") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return null;
}
function consumePendingApiKey() {
  const key = pendingApiKey;
  pendingApiKey = null;
  return key;
}
ipcMain.handle("app:platform-info", () => ({
  platform: process.platform,
  isWindows11
}));
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("app:copy-image-to-clipboard", (_event, dataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return { ok: false, error: "Image is empty" };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("app:check-updates", async () => {
  const fallbackVersion = app.getVersion();
  const defaultDownloadUrl = "https://github.com/XDev127/CilamAI/releases/latest/download/CilamAI-Setup.exe";
  const fallbackReleaseUrl = `https://github.com/XDev127/CilamAI/releases/tag/v${fallbackVersion}`;
  const tagFromUrl = (url) => {
    const match = String(url || "").match(/\/releases\/tag\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  };
  try {
    const getJson = (url) => new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CilamAI",
          Accept: "application/vnd.github+json"
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return resolve(getJson(response.headers.location));
        }
        if (response.statusCode !== 200) return reject(new Error(`GitHub HTTP ${response.statusCode}`));
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid update response"));
          }
        });
      });
      request.on("error", reject);
    });
    let release = null;
    try {
      release = await getJson("https://api.github.com/repos/XDev127/CilamAI/releases/latest");
    } catch {
      try {
        const tags = await getJson("https://api.github.com/repos/XDev127/CilamAI/tags");
        if (Array.isArray(tags) && tags.length > 0) {
          release = { tag_name: tags[0].name, html_url: `https://github.com/XDev127/CilamAI/releases/tag/${tags[0].name}` };
        }
      } catch {
      }
    }
    const releaseTag = release?.tag_name || release?.name || tagFromUrl(release?.html_url) || fallbackVersion;
    const latest = String(releaseTag || fallbackVersion).replace(/^CilamAI\s+v?/i, "").replace(/^v/i, "").trim() || fallbackVersion;
    const assetUrl = release?.assets?.find((asset) => /CilamAI-Setup\.exe$/i.test(asset.name || ""))?.browser_download_url;
    const downloadUrl = assetUrl || (release?.tag_name ? `https://github.com/XDev127/CilamAI/releases/download/${release.tag_name}/CilamAI-Setup.exe` : defaultDownloadUrl);
    const releasePageUrl = release?.html_url || `https://github.com/XDev127/CilamAI/releases/tag/v${latest}`;
    return { ok: true, current: app.getVersion(), latest, url: releasePageUrl, downloadUrl };
  } catch (err) {
    return {
      ok: true,
      current: app.getVersion(),
      latest: app.getVersion(),
      url: fallbackReleaseUrl,
      downloadUrl: defaultDownloadUrl
    };
  }
});
ipcMain.handle("app:download-and-install", async (_event, downloadUrl) => {
  const fs = require("node:fs");
  const { Readable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  const tempDir = app.getPath("temp");
  const fileName = `CilamAI-Update-${Date.now()}.exe`;
  const filePath = join(tempDir, fileName);
  const candidateUrls = [
    downloadUrl,
    "https://github.com/XDev127/CilamAI/releases/latest/download/CilamAI-Setup.exe",
    // Never pin an old release here: follow the running build's version.
    `https://github.com/XDev127/CilamAI/releases/download/v${app.getVersion()}/CilamAI-Setup.exe`
  ].filter(Boolean);
  let downloaded = false;
  for (const url of candidateUrls) {
    try {
      const response = await net.fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CilamAI" },
        redirect: "follow"
      });
      if (response.ok && response.body) {
        const fileStream = fs.createWriteStream(filePath);
        await pipeline(Readable.fromWeb(response.body), fileStream);
        downloaded = true;
        break;
      }
    } catch (e) {
    }
  }
  if (downloaded) {
    try {
      // CilamAI must be gone before NSIS overwrites its locked files
      // (app.asar etc.). So: quit the app first, then a detached cmd waits 2s
      // and launches the installer silently — the chain survives the app exit.
      const launcher = require("node:child_process").spawn(
        "cmd.exe",
        ["/c", `timeout /t 2 /nobreak >nul && start "" /wait "${filePath}" /S`],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      launcher.unref();
      setTimeout(() => app.quit(), 400);
      return { ok: true };
    } catch (e) {
    }
  }
  const targetUrl = downloadUrl || "https://github.com/XDev127/CilamAI/releases/latest";
  shell.openExternal(targetUrl);
  return { ok: true, openedInBrowser: true };
});
let currentTheme = "system";
const themeFile = () => join(app.getPath("userData"), "theme.json");
try {
  const savedTheme = readFileSync(themeFile(), "utf8");
  if (savedTheme) currentTheme = savedTheme.trim();
} catch {
}
function broadcastTheme(theme) {
  currentTheme = theme;
  try {
    writeFileSync(themeFile(), theme);
  } catch {
  }
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send("app:theme-changed", theme);
    }
  });
}
ipcMain.handle("app:set-theme", (_event, theme) => {
  broadcastTheme(theme);
  return { ok: true, theme };
});
ipcMain.handle("app:get-theme", () => ({ theme: currentTheme }));

const NEWS_FEEDS = [
  {
    source: "BBC News",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    stripQuery: /\?at_medium=RSS&at_campaign=rss$/
  },
  {
    source: "Google News",
    url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
    stripQuery: null
  }
];
const NEWS_TIMEOUT_MS = 1000;
function rssTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return "";
  return match[1]
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}
async function fetchNews(limit) {
  for (const feed of NEWS_FEEDS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
    try {
      const res = await net.fetch(feed.url, {
        signal: controller.signal,
        headers: { "User-Agent": "CilamAI", Accept: "application/rss+xml,application/xml,text/xml" }
      });
      if (!res.ok) continue;
      const xml = String(await res.text());
      const items = (xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [])
        .map((block) => {
          let source = rssTag(block, "source") || feed.source;
          let title = rssTag(block, "title");
          
          if (source && title.endsWith(` - ${source}`)) {
            title = title.slice(0, -(source.length + 3)).trim();
          }
          const published = Date.parse(rssTag(block, "pubDate"));
          return {
            title,
            url: feed.stripQuery ? rssTag(block, "link").replace(feed.stripQuery, "") : rssTag(block, "link"),
            source,
            published: Number.isFinite(published) ? published : null
          };
        })
        .filter((item) => item.title && item.url)
        .slice(0, limit);
      if (items.length) return { ok: true, items };
    } catch (err) {
      console.warn("[news] feed failed:", feed.url, err?.message || err);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "No news returned" };
}
ipcMain.handle("news:get", (_event, limit) => fetchNews(Math.min(Math.max(Number(limit) || 30, 1), 30)));
function decodeSearchHtml(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      const point = parseInt(code, 16);
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
ipcMain.handle("agent:web-search", async (_event, rawQuery) => {
  const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 500) : "";
  if (!query) return { ok: false, error: "Search query is empty" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "CilamAI", Accept: "text/html" }
    });
    if (!response.ok) return { ok: false, error: `Web search failed with HTTP ${response.status}` };
    const html = await response.text();
    const anchors = [...html.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
    const snippets = [...html.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
    const items = anchors.slice(0, 5).flatMap((match, index) => {
      const href = /\bhref=["']([^"']+)["']/i.exec(match[1])?.[1];
      const title = decodeSearchHtml(match[2]);
      const snippet = decodeSearchHtml(snippets[index]?.[2] || "");
      if (!href || !title) return [];
      let resultUrl;
      try {
        const parsed = new URL(href, "https://html.duckduckgo.com");
        const redirected = parsed.searchParams.get("uddg");
        resultUrl = redirected ? new URL(redirected) : parsed;
        if (!["http:", "https:"].includes(resultUrl.protocol)) return [];
      } catch {
        return [];
      }
      return [{ title, snippet, url: resultUrl.href }];
    });
    return items.length ? { ok: true, items } : { ok: false, error: "No web results found" };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "Web search timed out" : error?.message || "Web search failed" };
  } finally {
    clearTimeout(timer);
  }
});
let currentCustomColors = { accent: null, bg: null, fg: null };
function broadcastCustomColors(colors) {
  currentCustomColors = colors;
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send("app:custom-colors-changed", colors);
    }
  });
}
ipcMain.handle("app:set-custom-colors", (_event, colors) => {
  broadcastCustomColors(colors);
  return { ok: true, colors };
});
ipcMain.handle("app:get-custom-colors", () => ({ colors: currentCustomColors }));
let currentUiFont = "System default";
function broadcastUiFont(uiFont) {
  currentUiFont = uiFont;
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send("app:ui-font-changed", uiFont);
    }
  });
}
ipcMain.handle("app:set-ui-font", (_event, uiFont) => {
  broadcastUiFont(uiFont);
  return { ok: true, uiFont };
});
ipcMain.handle("app:get-ui-font", () => ({ uiFont: currentUiFont }));
ipcMain.on("app:console-log", (_event, msg) => console.log(msg));
ipcMain.on("app:console-info", (_event, msg) => console.info(msg));
ipcMain.on("app:console-error", (_event, msg) => console.error(msg));
ipcMain.on("app:console-warn", (_event, msg) => console.warn(msg));
ipcMain.handle("app:get-pending-apikey", () => ({ key: consumePendingApiKey() }));
ipcMain.handle("app:get-env-config", () => envConfig);
ipcMain.handle("voice:enumerate-devices", async () => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return { ok: false, error: "No window available" };
  try {
    const devices = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach(t => t.stop())
        } catch {}
        const devices = await navigator.mediaDevices.enumerateDevices()
        return devices.filter(d => d.kind === 'audioinput' && d.label).map(d => ({
          deviceId: d.deviceId,
          label: d.label
        }))
      })()
    `);
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message, devices: [] };
  }
});
function getMemoryFile() {
  return join(app.getPath("userData"), "memory.json");
}
function loadMemoryStore() {
  try {
    const file = getMemoryFile();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8"));
    }
  } catch {
  }
  return { entries: [], lastCleared: null };
}
function saveMemoryStore(store) {
  try {
    writeFileSync(getMemoryFile(), JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save memory store:", err);
  }
}
ipcMain.handle("memory:get", () => {
  try {
    const store = loadMemoryStore();
    const now = Date.now();
    const retentionMs = 7 * 24 * 60 * 60 * 1e3;
    const validEntries = (store.entries || []).filter((e) => {
      if (!e.expiresAt) return true;
      return e.expiresAt > now;
    });
    if (validEntries.length !== (store.entries || []).length) {
      store.entries = validEntries;
      saveMemoryStore(store);
    }
    return {
      ok: true,
      memory: {
        entries: validEntries,
        count: validEntries.length,
        totalTokens: validEntries.reduce((sum, e) => sum + (e.tokens || 0), 0),
        lastCleared: store.lastCleared
      }
    };
  } catch (err) {
    return { ok: false, error: err.message, memory: { entries: [], count: 0, totalTokens: 0 } };
  }
});
ipcMain.handle("memory:add", (_event, entry) => {
  try {
    if (!entry || !entry.content) {
      return { ok: false, error: "Memory entry content is required" };
    }
    const store = loadMemoryStore();
    const retention = entry.retention || "session";
    let expiresAt = null;
    if (retention === "7days") expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1e3;
    else if (retention === "30days") expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1e3;
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      content: String(entry.content).slice(0, 4e3),
      tokens: entry.tokens || 0,
      retention,
      expiresAt,
      createdAt: Date.now()
    };
    store.entries = store.entries || [];
    store.entries.push(newEntry);
    saveMemoryStore(store);
    return { ok: true, entry: newEntry, count: store.entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:remove", (_event, id) => {
  try {
    const store = loadMemoryStore();
    const before = (store.entries || []).length;
    store.entries = (store.entries || []).filter((e) => e.id !== id);
    saveMemoryStore(store);
    return { ok: true, removed: before - store.entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:clear", () => {
  try {
    const store = loadMemoryStore();
    const count = (store.entries || []).length;
    store.entries = [];
    store.lastCleared = Date.now();
    saveMemoryStore(store);
    return { ok: true, cleared: count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:set-context-window", (_event, maxTokens) => {
  try {
    const store = loadMemoryStore();
    store.maxTokens = Math.max(1e3, Math.min(1e6, Number(maxTokens) || 2e5));
    saveMemoryStore(store);
    return { ok: true, maxTokens: store.maxTokens };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:set-enabled", (_event, enabled) => {
  try {
    const store = loadMemoryStore();
    store.enabled = !!enabled;
    saveMemoryStore(store);
    return { ok: true, enabled: store.enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:set-retention", (_event, retention) => {
  try {
    const valid = ["session", "7days", "30days", "forever"];
    const store = loadMemoryStore();
    store.retention = valid.includes(retention) ? retention : "session";
    saveMemoryStore(store);
    return { ok: true, retention: store.retention };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("memory:prune-expired", () => {
  try {
    const store = loadMemoryStore();
    const now = Date.now();
    const before = (store.entries || []).length;
    store.entries = (store.entries || []).filter((e) => {
      if (!e.expiresAt) return true;
      return e.expiresAt > now;
    });
    saveMemoryStore(store);
    return { ok: true, pruned: before - store.entries.length, remaining: store.entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function getNotifSettingsFile() {
  return join(app.getPath("userData"), "notifications.json");
}
function loadNotifSettings() {
  try {
    const file = getNotifSettingsFile();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8"));
    }
  } catch {
  }
  return { enabled: true, sound: false, duration: 6, position: "top-right" };
}
function saveNotifSettings(settings) {
  try {
    writeFileSync(getNotifSettingsFile(), JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save notification settings:", err);
  }
}
ipcMain.handle("notifications:get", () => {
  try {
    return { ok: true, settings: loadNotifSettings() };
  } catch (err) {
    return { ok: false, error: err.message, settings: { enabled: true, sound: false, duration: 6, position: "top-right" } };
  }
});
ipcMain.handle("notifications:set-enabled", (_event, enabled) => {
  try {
    const settings = loadNotifSettings();
    settings.enabled = !!enabled;
    saveNotifSettings(settings);
    return { ok: true, enabled: settings.enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("notifications:set-sound", (_event, sound) => {
  try {
    const settings = loadNotifSettings();
    settings.sound = !!sound;
    saveNotifSettings(settings);
    return { ok: true, sound: settings.sound };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("notifications:set-duration", (_event, duration) => {
  try {
    const settings = loadNotifSettings();
    const dur = Number(duration);
    if (![3, 6, 10].includes(dur)) {
      return { ok: false, error: "Duration must be 3, 6, or 10 seconds" };
    }
    settings.duration = dur;
    saveNotifSettings(settings);
    return { ok: true, duration: settings.duration };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("notifications:set-position", (_event, position) => {
  try {
    const valid = ["top-right", "bottom-right"];
    const settings = loadNotifSettings();
    settings.position = valid.includes(position) ? position : "top-right";
    saveNotifSettings(settings);
    return { ok: true, position: settings.position };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("notifications:show", (_event, { title, message, type }) => {
  try {
    const settings = loadNotifSettings();
    if (!settings.enabled) return { ok: false, error: "Notifications are disabled" };
    const { Notification } = require("electron");
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: title || "CilamAI",
        body: message || "",
        silent: !settings.sound
      });
      notif.show();
      if (settings.sound) playNotificationSound(type || "info");
      return { ok: true };
    }
    return { ok: false, error: "Notifications not supported" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function playNotificationSound(type) {
  try {
    const { spawn } = require("node:child_process");
    if (process.platform === "win32") {
      const soundMap = { info: "Asterisk", error: "Hand", warning: "Exclamation" };
      const sound = soundMap[type] || "Default";
      try {
        spawn("powershell", ["-c", `[System.Media.SystemSounds]::${sound}.Play()`], { detached: true, stdio: "ignore" }).unref();
      } catch {
        spawn("rundll32", ["user32.dll,MessageBeep", type === "error" ? "MB_ICONERROR" : type === "warning" ? "MB_ICONWARNING" : "MB_ICONINFORMATION"], { detached: true, stdio: "ignore" }).unref();
      }
    } else if (process.platform === "darwin") {
      const sounds = { info: "Pop", error: "Basso", warning: "Funk" };
      spawn("afplay", [`/System/Library/Sounds/${sounds[type] || "Pop"}.aiff`], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("paplay", ["/usr/share/sounds/freedesktop/stereo/message.oga"], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
  }
}
ipcMain.handle("app:context-window-boost", async (_event, enabled) => {
  try {
    return {
      ok: true,
      enabled: !!enabled,
      speedMultiplier: enabled ? 100 : 1,
      message: enabled ? "Context Window Speed Boost x100 enabled" : "Context Window Speed Boost disabled"
    };
  } catch (err) {
    return { ok: false, error: err.message, enabled: false, speedMultiplier: 1 };
  }
});
ipcMain.handle("app:get-context-window-info", (_event, model) => {
  try {
    const contextWindows = {
      auto: 2e5,
      "mimo-v2.5-free": 2e5,
      "nemotron-3.5-lightning-free": 2e5,
      "gemma4:26b": 128e3,
      gemma4: 128e3
    };
    return {
      ok: true,
      model: model || "auto",
      maxTokens: contextWindows[model] || 2e5,
      speedBoostAvailable: true,
      speedBoostMultiplier: 100
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("app:get-release-notes", () => {
  try {
    const releaseNotes = loadReleaseNotes();
    const currentVersion = app.getVersion();
    const shouldShow = releaseNotes.lastShownVersion !== currentVersion;
    if (shouldShow) {
      saveReleaseNotes({ lastShownVersion: currentVersion });
    }
    return {
      ok: true,
      shouldShow,
      currentVersion,
      lastShownVersion: releaseNotes.lastShownVersion
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      shouldShow: false,
      currentVersion: app.getVersion()
    };
  }
});
ipcMain.handle("app:check-internet", async () => {
  try {
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: "clients3.google.com", path: "/generate_204", method: "GET", timeout: 3e3 }, (res) => {
        resolve(res.statusCode === 204);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
    return { ok: true, online: true };
  } catch {
    return { ok: true, online: false };
  }
});
ipcMain.handle("sessions:load", () => {
  try {
    const sessions = loadSessionsFromDisk();
    return { ok: true, sessions: sessions || [] };
  } catch (err) {
    return { ok: false, error: err.message, sessions: [] };
  }
});
ipcMain.handle("sessions:save", async (_event, sessions) => {
  if (!Array.isArray(sessions)) {
    return { ok: false, error: "Invalid sessions data" };
  }
  try {
    scheduleSessionWrite(sessions);
    return { ok: true, count: sessions.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("sessions:save-immediate", async (_event, sessions) => {
  if (!Array.isArray(sessions)) {
    return { ok: false, error: "Invalid sessions data" };
  }
  try {
    clearTimeout(sessionWriteTimer);
    await writeFile(getSessionFile(), JSON.stringify(sessions, null, 2), "utf8");
    return { ok: true, count: sessions.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
const creditsFile = () => join(app.getPath("userData"), "credits.json");
function loadCreditsStore() {
  try {
    if (existsSync(creditsFile())) {
      return JSON.parse(readFileSync(creditsFile(), "utf8"));
    }
  } catch {
  }
  return {};
}
function saveCreditsStore(store) {
  try {
    writeFileSync(creditsFile(), JSON.stringify(store, null, 2), "utf8");
  } catch {
  }
}
function currentUserKey() {
  const user = currentAuthUser || loadStoredAuthUser();
  return (user?.email || user?.name || "default").toLowerCase().trim();
}
const SPECIAL_USER_CREDITS = {
  "5852408b65d8bcef0909dec2ca2913680cc67803f9a6a1453fabe3eaee138f6c": { limit: 1e5, resetInterval: 365 * 24 * 60 * 60 * 1e3 },
  "59c1d82bd6fe5879c0b3c453f20d254a090a95af74199dd57aa2677960ec0c0e": { limit: 1e5, resetInterval: 365 * 24 * 60 * 60 * 1e3, grantVersion: 2 },
  "927dc8ad08b61c962a50b2be815a13fc754bfd9f16f333616b30c1b9e7bd5dc3": { limit: 1e5, resetInterval: 365 * 24 * 60 * 60 * 1e3, grantVersion: 2 }
};
function getUserCreditConfig(userOrKey) {
  if (!userOrKey) return { limit: 100, resetInterval: 24 * 60 * 60 * 1e3 };
  let k = typeof userOrKey === "string" ? userOrKey : userOrKey.email || userOrKey.name || "";
  k = createHash("sha256").update(k.toLowerCase().trim()).digest("hex");
  return SPECIAL_USER_CREDITS[k] || { limit: 100, resetInterval: 24 * 60 * 60 * 1e3 };
}
function applyCreditGrant(store, key, config, now) {
  if (!config.grantVersion) return false;
  const saved = store[key] || {};
  if (saved.grantVersion === config.grantVersion) return false;
  store[key] = {
    ...saved,
    used: 0,
    limit: config.limit,
    resetAt: now + config.resetInterval,
    grantVersion: config.grantVersion
  };
  saveCreditsStore(store);
  return true;
}
ipcMain.handle("credits:get", () => {
  const key = currentUserKey();
  const user = currentAuthUser || loadStoredAuthUser();
  const store = loadCreditsStore();
  const now = Date.now();
  const config = getUserCreditConfig(user || key);
  applyCreditGrant(store, key, config, now);
  const saved = store[key] || {};
  let limit = Math.max(1, Number(saved.limit ?? config.limit));
  if (config.limit > 100) limit = config.limit;
  if (limit >= 1e6) limit = config.limit;
  let resetAt = Number(saved.resetAt || now + config.resetInterval);
  if (resetAt <= now || config.limit <= 100 && resetAt > now + 25 * 60 * 60 * 1e3 || config.resetInterval > 24 * 60 * 60 * 1e3 && resetAt < now + 300 * 24 * 60 * 60 * 1e3) {
    resetAt = now + config.resetInterval;
  }
  return {
    ok: true,
    credits: {
      used: Math.min(limit, Math.max(0, Number(saved.used ?? 0))),
      limit,
      resetAt
    }
  };
});
ipcMain.on("credits:get-sync", (event) => {
  const key = currentUserKey();
  const user = currentAuthUser || loadStoredAuthUser();
  const store = loadCreditsStore();
  const now = Date.now();
  const config = getUserCreditConfig(user || key);
  applyCreditGrant(store, key, config, now);
  const saved = store[key] || {};
  let limit = Math.max(1, Number(saved.limit ?? config.limit));
  if (config.limit > 100) limit = config.limit;
  if (limit >= 1e6) limit = config.limit;
  let resetAt = Number(saved.resetAt || now + config.resetInterval);
  if (resetAt <= now || config.limit <= 100 && resetAt > now + 25 * 60 * 60 * 1e3 || config.resetInterval > 24 * 60 * 60 * 1e3 && resetAt < now + 300 * 24 * 60 * 60 * 1e3) {
    resetAt = now + config.resetInterval;
  }
  event.returnValue = {
    ok: true,
    credits: {
      used: Math.min(limit, Math.max(0, Number(saved.used ?? 0))),
      limit,
      resetAt
    }
  };
});
ipcMain.handle("credits:set", (_event, credits) => {
  const key = currentUserKey();
  const user = currentAuthUser || loadStoredAuthUser();
  const store = loadCreditsStore();
  const now = Date.now();
  const config = getUserCreditConfig(user || key);
  const grantApplied = applyCreditGrant(store, key, config, now);
  const cur = store[key] || {};
  let limit = Math.max(1, Number(credits?.limit ?? cur.limit ?? config.limit));
  if (config.limit > 100) limit = config.limit;
  if (limit >= 1e6) limit = config.limit;
  let resetAt = grantApplied ? now + config.resetInterval : Number(credits?.resetAt ?? cur.resetAt ?? now + config.resetInterval);
  if (resetAt <= now || config.limit <= 100 && resetAt > now + 25 * 60 * 60 * 1e3 || config.resetInterval > 24 * 60 * 60 * 1e3 && resetAt < now + 300 * 24 * 60 * 60 * 1e3) {
    resetAt = now + config.resetInterval;
  }
  store[key] = {
    used: grantApplied ? 0 : Math.min(limit, Math.max(0, Number(credits?.used ?? cur.used ?? 0))),
    limit,
    resetAt,
    ...(config.grantVersion ? { grantVersion: config.grantVersion } : {})
  };
  saveCreditsStore(store);
  return { ok: true };
});
ipcMain.on("credits:set-sync", (event, credits) => {
  const key = currentUserKey();
  const user = currentAuthUser || loadStoredAuthUser();
  const store = loadCreditsStore();
  const now = Date.now();
  const config = getUserCreditConfig(user || key);
  const grantApplied = applyCreditGrant(store, key, config, now);
  const cur = store[key] || {};
  let limit = Math.max(1, Number(credits?.limit ?? cur.limit ?? config.limit));
  if (config.limit > 100) limit = config.limit;
  if (limit >= 1e6) limit = config.limit;
  let resetAt = grantApplied ? now + config.resetInterval : Number(credits?.resetAt ?? cur.resetAt ?? now + config.resetInterval);
  if (resetAt <= now || config.limit <= 100 && resetAt > now + 25 * 60 * 60 * 1e3 || config.resetInterval > 24 * 60 * 60 * 1e3 && resetAt < now + 300 * 24 * 60 * 60 * 1e3) {
    resetAt = now + config.resetInterval;
  }
  store[key] = {
    used: grantApplied ? 0 : Math.min(limit, Math.max(0, Number(credits?.used ?? cur.used ?? 0))),
    limit,
    resetAt,
    ...(config.grantVersion ? { grantVersion: config.grantVersion } : {})
  };
  saveCreditsStore(store);
  event.returnValue = { ok: true };
});
ipcMain.handle("file:upload", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "No window" };
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a file",
    properties: ["openFile"]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  const BLOCKED_EXTENSIONS = [".js", ".json", ".html", ".bat", ".cmd"];
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `File type .${ext.slice(1)} is not allowed` };
  }
  try {
    const data = await readFile(filePath);
    return {
      ok: true,
      name: filePath.split(/[\\/]/).pop(),
      path: filePath,
      size: data.length,
      data: data.toString("base64")
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("startup:set", async (_event, enabled) => {
  try {
    const settings = { openAtLogin: !!enabled };
    app.setLoginItemSettings(settings);
    const current = app.getLoginItemSettings();
    return { ok: true, enabled: current.openAtLogin };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("startup:get", () => {
  try {
    const settings = app.getLoginItemSettings();
    return { ok: true, enabled: settings.openAtLogin };
  } catch (err) {
    return { ok: false, error: err.message, enabled: false };
  }
});
ipcMain.handle("window:theme-shot", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "No window to capture" };
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return { ok: false, error: "Empty capture" };
    const scaled = image.resize({ width: 520, quality: "good" });
    return { ok: true, dataUrl: scaled.toDataURL() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("app:capture", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: "No window to capture" };
    const image = await win.webContents.capturePage();
    const pngData = image.toPNG();
    const stamp = ( new Date()).toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = join(app.getPath("pictures"), `chat-${stamp}.png`);
    await writeFile(file, pngData);
    return { ok: true, path: file, data: pngData.toString("base64") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("chat:send", async (_event, { url, model, messages, provider, apiKey, org, reasoningEffort }) => {
  try {
    return await chatSend({ url, model, messages, provider, apiKey, envConfig, org, reasoningEffort });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("chat:send-stream", async (event, { url, model, messages, provider, apiKey, org, reasoningEffort }) => {
  return await sendWithRetry(async () => {
    const controller = new AbortController();
    streamControllers.set(event.sender.id, controller);
    try {
      return await chatSendStream(
        { url, model, messages, provider, apiKey, envConfig, org, reasoningEffort },
        {
          signal: controller.signal,
          onChunk: (text) => event.sender.send("chat:stream-chunk", text),
          onReasoning: (text) => event.sender.send("chat:stream-reasoning", text)
        }
      );
    } catch (err) {
      if (err.name === "AbortError") return { ok: true, aborted: true };
      return { ok: false, error: err.message };
    } finally {
      streamControllers.delete(event.sender.id);
    }
  });
});
ipcMain.on("chat:stop-stream", (event) => {
  streamControllers.get(event.sender.id)?.abort();
});
ipcMain.handle("web:fetch-stream", async (event, { url }) => {
  const controller = new AbortController();
  streamControllers.set(event.sender.id, controller);
  try {
    return await webFetchStream(url, {
      signal: controller.signal,
      onChunk: (text) => event.sender.send("chat:stream-chunk", text),
      onReasoning: (text) => event.sender.send("chat:stream-reasoning", text)
    });
  } finally {
    streamControllers.delete(event.sender.id);
  }
});
ipcMain.handle("window:minimize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.minimize();
    return { ok: true };
  }
  return { ok: false, error: "No window found" };
});
ipcMain.handle("window:maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, maximized: false };
  win.maximize();
  return { ok: true, maximized: true };
});
ipcMain.handle("window:unmaximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, maximized: false };
  win.unmaximize();
  return { ok: true, maximized: false };
});
ipcMain.handle("window:maximize-toggle", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, maximized: false };
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
  return { ok: true, maximized: win.isMaximized() };
});
ipcMain.handle("window:is-maximized", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return { ok: true, maximized: win?.isMaximized() ?? false };
});
ipcMain.handle("window:get-state", () => {
  try {
    const state = loadWindowState();
    return { ok: true, state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("window:save-state", async (_event, state) => {
  try {
    saveWindowState(state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("window:close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
    return { ok: true };
  }
  return { ok: false, error: "No window found" };
});
ipcMain.handle("app:restart", () => {
  app.relaunch();
  app.quit();
  return { ok: true };
});
ipcMain.handle("window:open-devtools", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools();
});
// Taskbar "reply finished" badge: when the AI stream ends while the window is not
// focused (or is minimized), show a small "1" over the app icon. Cleared as soon
// as the user returns to the window.

let streamEndBadge = null;
function getStreamEndBadge() {
  if (streamEndBadge) return streamEndBadge;
  // Real badge artwork (red "1" circle); no system-drawn text when it's present.
  const badge = nativeImage.createFromPath(join(app.getAppPath(), "resources/badge-1.png"));
  if (!badge.isEmpty()) {
    streamEndBadge = { icon: badge.resize({ width: 16, height: 16 }), text: "" };
    return streamEndBadge;
  }
  // Fallback if the badge file is missing: app icon + system text "1".
  const img = nativeImage.createFromPath(join(app.getAppPath(), "resources/icon.png"));
  streamEndBadge = {
    icon: img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }),
    text: "1",
  };
  return streamEndBadge;
}
ipcMain.on("window:stream-end-notify", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isFocused() && !win.isMinimized()) return; // user is already watching
  try {
    const badge = getStreamEndBadge();
    win.setOverlayIcon(badge.icon, badge.text);
    const clear = () => {
      if (win.isDestroyed()) return;
      try { win.setOverlayIcon(null, ""); } catch {}
    };
    win.once("focus", clear);
    win.once("restore", clear);
  } catch {}
});
ipcMain.handle("app:open-external", (_event, url) => {
  if (url && typeof url === "string") shell.openExternal(url);
});
const terminalSessions = new Map();
let terminalSeq = 0;
const TERMINAL_MARK = "__CILAMAI_TERM__";
function terminalSentinel(kind) {
  // Sent by after every interactive command so the renderer can learn the real cwd
  // and completion status. Kept under the console echo width so the shell's echo of
  // these lines is never wrapped into fragments.
  return kind === "powershell"
    ? `$__clmae=if($?){0}else{1} #${TERMINAL_MARK}\nWrite-Output "$__clmac$__clmae__$((Get-Location).Path)" #${TERMINAL_MARK}`
    : `__clmae=$? #${TERMINAL_MARK}\nprintf '${TERMINAL_MARK}%s__%s\\n' "$__clmae" "$(pwd)"`;
}
function emitTerminal(id, event, payload) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send("terminal:event", { id, event, ...payload });
}
function killTerminal(session) {
  try {
    if (process.platform === "win32" && session.child?.pid) {
      spawn("taskkill", ["/pid", String(session.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      session.child?.kill();
    }
  } catch { }
}
ipcMain.handle("terminal:create", (_event, options = {}) => {
  const id = `term-${++terminalSeq}`;
  const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : os.homedir();
  const isWin = process.platform === "win32";
  const kind = isWin ? "powershell" : "sh";
  const shellName = isWin ? "powershell" : process.env.SHELL || "/bin/bash";
  const cols = Number(options.cols) > 0 ? Math.round(Number(options.cols)) : 80;
  const rows = Number(options.rows) > 0 ? Math.round(Number(options.rows)) : 24;
  const boot = `try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }; $env:COLUMNS='${cols}'; $env:LINES='${rows}'; $__clmac='${TERMINAL_MARK}'; function prompt { "PS $((Get-Location).Path)> " }`;
  let child;
  try {
    if (isWin) {
      child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoExit", "-Command", boot],
        { cwd, windowsHide: true, env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) }, stdio: ["pipe", "pipe", "pipe"] }
      );
    } else {
      child = spawn(shellName, ["-i"], { cwd, env: { ...process.env, PS1: "\\w> ", TERM: "dumb", COLUMNS: String(cols), LINES: String(rows) }, stdio: ["pipe", "pipe", "pipe"] });
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const decoder = new TextDecoder("utf8");
  const session = { child, cwd, kind, pending: "", timer: null };
  terminalSessions.set(id, session);
  const flush = () => {
    session.timer = null;
    if (!session.pending) return;
    const chunk = session.pending;
    session.pending = "";
    emitTerminal(id, "data", { chunk });
  };
  const onData = (chunk) => {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) return;
    session.pending += text;
    if (!session.timer) session.timer = setTimeout(flush, 16);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    session.pending += decoder.decode();
    flush();
    emitTerminal(id, "exit", { code });
    terminalSessions.delete(id);
  });
  child.on("error", (err) => emitTerminal(id, "exit", { code: -1, error: err.message }));
  return { ok: true, id, kind, cwd, shell: shellName, marker: TERMINAL_MARK, sentinel: terminalSentinel(kind) };
});
ipcMain.handle("terminal:write", (_event, { id, text }) => {
  const session = terminalSessions.get(id);
  if (!session || !session.child.stdin?.writable) return { ok: false };
  try {
    session.child.stdin.write(String(text ?? ""));
  } catch {
    return { ok: false };
  }
  return { ok: true };
});
ipcMain.handle("terminal:kill", (_event, { id }) => {
  const session = terminalSessions.get(id);
  if (session) {
    killTerminal(session);
    terminalSessions.delete(id);
  }
  return { ok: true };
});
ipcMain.handle("terminal:complete", (_event, { partial }) => {
  let raw = String(partial ?? "");
  if (!raw.trim() && raw !== "~") return { ok: true, dirText: "", prefix: raw, items: [] };
  if (raw.startsWith("~")) raw = os.homedir() + raw.slice(1);
  const isWin = process.platform === "win32";
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const dirText = cut === -1 ? "" : raw.slice(0, cut + 1);
  const prefix = cut === -1 ? raw : raw.slice(cut + 1);
  const dir = dirText ? resolve(dirText) : process.cwd();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { ok: true, dirText, prefix, items: [] };
  }
  const lower = isWin ? prefix.toLowerCase() : prefix;
  const items = names
    .filter((name) => (isWin ? name.toLowerCase().startsWith(lower) : name.startsWith(prefix)))
    .sort((a, b) => (isWin ? a.toLowerCase().localeCompare(b.toLowerCase()) : a.localeCompare(b)))
    .slice(0, 200)
    .map((name) => {
      let isDir = false;
      try { isDir = statSync(join(dir, name)).isDirectory(); } catch { }
      return { name, isDir };
    });
  return { ok: true, dirText, prefix, items };
});
app.on("before-quit", () => {
  for (const session of terminalSessions.values()) {
    if (session.timer) clearTimeout(session.timer);
    killTerminal(session);
  }
  terminalSessions.clear();
});
const panelBrowsers = new Map();
let panelBrowserSeq = 0;
function browserTargetUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "about:blank";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "about:") return "";
  return url.toString();
}
function clampInt(value, min) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.round(n) : min;
  return safe > min ? safe : min;
}
function browserShow(rec) {
  const box = rec.bounds;
  const usable = !!box && Number.isFinite(box.width) && box.width > 40 && Number.isFinite(box.height) && box.height > 40;
  const shouldShow = !!rec.visible && rec.painted && usable && !rec.win.isDestroyed();
  if (!shouldShow) {
    if (rec.attached) {
      try {
        rec.win.contentView.removeChildView(rec.view);
      } catch { }
      rec.attached = false;
    }
    return;
  }
  if (!rec.attached) {
    try {
      rec.win.contentView.addChildView(rec.view);
      rec.attached = true;
    } catch { }
  }
  if (!rec.attached) return;
  try {
    rec.view.setBounds({
      x: clampInt(box.x, 0),
      y: clampInt(box.y, 0),
      width: clampInt(box.width, 1),
      height: clampInt(box.height, 1),
    });
  } catch { }
}
function browserInfo(wc) {
  let back = false;
  let forward = false;
  try {
    back = wc.navigationHistory ? !!wc.navigationHistory.canGoBack() : !!wc.canGoBack();
  } catch { }
  try {
    forward = wc.navigationHistory ? !!wc.navigationHistory.canGoForward() : !!wc.canGoForward();
  } catch { }
  let title = "";
  let url = "";
  try {
    title = wc.getTitle();
    url = wc.getURL();
  } catch { }
  return { url, title, loading: wc.isLoading(), canGoBack: back, canGoForward: forward };
}
function browserEmit(id, payload) {
  const rec = panelBrowsers.get(id);
  if (!rec || rec.win.isDestroyed()) return;
  rec.win.webContents.send("panel-browser:event", { id, ...payload });
}
function browserNavigate(rec, raw) {
  const target = browserTargetUrl(raw);
  if (!target) return { ok: false, error: "unsupported address" };
  rec.view.webContents.loadURL(target).catch(() => { });
  return { ok: true, url: target };
}
function destroyPanelBrowser(id) {
  const rec = panelBrowsers.get(id);
  if (!rec) return;
  panelBrowsers.delete(id);
  try {
    if (!rec.win.isDestroyed()) rec.win.contentView.removeChildView(rec.view);
  } catch { }
  try {
    rec.view.webContents.close();
  } catch { }
}
ipcMain.handle("panel-browser:create", (event, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "no window" };
  const id = `browser-${++panelBrowserSeq}`;
  let view;
  try {
    view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:cilamai-browser",
      },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const rec = { view, win, visible: false, bounds: null, attached: false, painted: false };
  panelBrowsers.set(id, rec);
  try {
    const bg = typeof options.background === "string" && /^#[0-9a-fA-F]{6}$/.test(options.background) ? options.background : "#ffffff";
    view.setBackgroundColor(bg);
  } catch { }
  const wc = view.webContents;
  const push = () => browserEmit(id, { event: "state", ...browserInfo(wc) });
  wc.setWindowOpenHandler((details) => {
    const target = browserTargetUrl(details.url);
    if (target && target !== "about:blank") shell.openExternal(target);
    return { action: "deny" };
  });
  // An attached-but-unpainted view paints black, so the view is only attached to
  // the window once real content exists and the panel slot has a usable box.
  const markPainted = () => {
    let url = "";
    try {
      url = wc.getURL();
    } catch { }
    if (url && !/^about:/i.test(url)) {
      rec.painted = true;
      browserShow(rec);
    }
  };
  wc.on("did-start-loading", push);
  wc.on("did-stop-loading", () => { markPainted(); push(); });
  wc.on("did-navigate", () => { markPainted(); push(); });
  wc.on("did-navigate-in-page", push);
  wc.on("did-fail-load", markPainted);
  wc.on("dom-ready", markPainted);
  wc.on("page-title-updated", (_e, title) => browserEmit(id, { event: "state", ...browserInfo(wc), title }));
  wc.on("render-process-gone", () => browserEmit(id, { event: "state", ...browserInfo(wc), error: "page crashed" }));
  browserNavigate(rec, options.url || "");
  return { ok: true, id };
});
ipcMain.handle("panel-browser:navigate", (_event, { id, url }) => {
  const rec = panelBrowsers.get(id);
  if (!rec) return { ok: false, error: "no browser" };
  return browserNavigate(rec, url);
});
ipcMain.handle("panel-browser:history", (_event, { id, dir }) => {
  const rec = panelBrowsers.get(id);
  if (!rec) return { ok: false };
  const wc = rec.view.webContents;
  try {
    if (wc.navigationHistory) {
      if (dir === "back") wc.navigationHistory.goBack();
      else wc.navigationHistory.goForward();
    } else if (dir === "back") wc.goBack();
    else wc.goForward();
  } catch { }
  return { ok: true };
});
ipcMain.handle("panel-browser:reload", (_event, { id, hard }) => {
  const rec = panelBrowsers.get(id);
  if (!rec) return { ok: false };
  try {
    if (hard) rec.view.webContents.reloadIgnoringCache();
    else rec.view.webContents.reload();
  } catch { }
  return { ok: true };
});
ipcMain.handle("panel-browser:stop", (_event, { id }) => {
  const rec = panelBrowsers.get(id);
  try {
    rec?.view.webContents.stop();
  } catch { }
  return { ok: true };
});
ipcMain.handle("panel-browser:state", (_event, { id }) => {
  const rec = panelBrowsers.get(id);
  if (!rec) return { ok: false };
  return { ok: true, ...browserInfo(rec.view.webContents) };
});
ipcMain.handle("panel-browser:bounds", (_event, { id, bounds }) => {
  const rec = panelBrowsers.get(id);
  if (!rec || !bounds) return { ok: false };
  rec.bounds = bounds;
  browserShow(rec);
  return { ok: true };
});
ipcMain.handle("panel-browser:visible", (_event, { id, visible }) => {
  const rec = panelBrowsers.get(id);
  if (!rec) return { ok: false };
  rec.visible = !!visible;
  try {
    rec.view.setVisible(!!visible);
    if (visible && rec.bounds) {
      rec.view.setBounds({
        x: Math.max(0, Math.round(rec.bounds.x)),
        y: Math.max(0, Math.round(rec.bounds.y)),
        width: Math.max(1, Math.round(rec.bounds.width)),
        height: Math.max(1, Math.round(rec.bounds.height)),
      });
    }
  } catch { }
  return { ok: true };
});
ipcMain.handle("panel-browser:kill", (_event, { id }) => {
  destroyPanelBrowser(id);
  return { ok: true };
});
app.on("before-quit", () => {
  for (const id of [...panelBrowsers.keys()]) destroyPanelBrowser(id);
});
let oauthHttpServer = null;
let currentAuthUser = null;
function parseUserString(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    return {
      name: parts[0] || "",
      email: parts[1] || "",
      picture: parts.slice(2).join(":") || null,
      provider: "ipc"
    };
  }
  if (trimmed.includes("@")) {
    return {
      name: trimmed.split("@")[0],
      email: trimmed,
      picture: null,
      provider: "ipc"
    };
  }
  return {
    name: trimmed,
    email: "",
    picture: null,
    provider: "ipc"
  };
}
function loadStoredAuthUser() {
  try {
    const authPath = join(app.getPath("userData"), "auth_user.json");
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, "utf8"));
    }
  } catch {
  }
  return null;
}
function saveStoredAuthUser(user) {
  try {
    const authPath = join(app.getPath("userData"), "auth_user.json");
    if (user) {
      writeFileSync(authPath, JSON.stringify(user, null, 2), "utf8");
    } else if (existsSync(authPath)) {
      unlinkSync(authPath);
    }
  } catch {
  }
}
function applyAndSaveUser(user) {
  let userObj = null;
  if (user && typeof user === "string") {
    userObj = parseUserString(user);
  } else if (user && typeof user === "object") {
    userObj = {
      name: user.name || "",
      email: user.email || "",
      picture: user.picture || null,
      provider: user.provider || "google"
    };
  }
  currentAuthUser = userObj;
  saveStoredAuthUser(userObj);
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send("auth:user", userObj);
  });
  return userObj;
}
ipcMain.handle("auth:get-user", async () => {
  if (!currentAuthUser) {
    currentAuthUser = loadStoredAuthUser();
  }
  return currentAuthUser;
});
ipcMain.on("auth:get-user-sync", (event) => {
  if (!currentAuthUser) {
    currentAuthUser = loadStoredAuthUser();
  }
  event.returnValue = currentAuthUser;
});
ipcMain.handle("auth:sign-in", async (_event, provider) => {
  try {
    if (provider === "google") {
    const http2 = await import("node:http");
    const crypto = await import("node:crypto");
    if (oauthHttpServer) {
      try {
        oauthHttpServer.close();
      } catch {
      }
      oauthHttpServer = null;
    }
    const base64Url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
    const clientId = getGoogleClientId();
    if (!clientId) {
      console.warn("[OAuth] GOOGLE_CLIENT_ID is not set in .env - Google sign-in is disabled.");
      return {
        ok: false,
        error: "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart CilamAI."
      };
    }
    const callback = resolveOAuthCallback();
    console.log(
      callback.pinned ? `[OAuth] Pinned redirect URI: ${callback.redirectFor()}` : `[OAuth] Scanning ports ${callback.ports[0]}-${callback.ports[callback.ports.length - 1]} for the OAuth callback`
    );
    return await new Promise((_resolve) => {
      let lastRedirectUri = "";
      let redirectUri = null;
      const timeoutId = setTimeout(() => {
        console.error("[OAuth] Timed out waiting for the browser callback");
        try {
          oauthHttpServer?.close();
        } catch {
        }
        oauthHttpServer = null;
        _resolve({
          ok: false,
          error: `Sign-in timed out. Register this exact redirect URI on the OAuth client: ${lastRedirectUri}`
        });
      }, OAUTH_TIMEOUT_MS);
      const resolve = (value) => {
        clearTimeout(timeoutId);
        _resolve(value);
      };
      let oauthPort = 3e3;
      oauthHttpServer = http2.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://127.0.0.1:${oauthPort}`);
        const code = urlObj.searchParams.get("code");
        const error = urlObj.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Sign-In Cancelled</h2><p style="color:#888;">You can close this window and return to CilamAI.</p></div><script>setTimeout(()=>window.close(),1500)<\/script></body></html>`);
          try {
            oauthHttpServer.close();
          } catch {
          }
          oauthHttpServer = null;
          resolve({ ok: false, error });
          return;
        }
        if (code) {
          try {
            console.log("[OAuth] Exchanging code for tokens...");
            const tokenRes = await oauthFetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
              },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
                code,
                code_verifier: codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: redirectUri
              })
            });
            const tokenData = await tokenRes.json();
            console.log("[OAuth] Token data received:", tokenData.error || "SUCCESS");
            if (tokenData.error) {
              console.error("[OAuth] Google token exchange failed:", tokenData.error, tokenData.error_description || "");
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Sign-In Failed</h2><p style="color:#888;">${tokenData.error}</p><p style="color:#888;">Close this tab and check CilamAI for details.</p></div></body></html>`);
              try {
                oauthHttpServer.close();
              } catch {
              }
              oauthHttpServer = null;
              resolve({ ok: false, error: describeOAuthRedirectError(tokenData.error_description || tokenData.error, redirectUri) });
              return;
            }
            let userName = "";
            let userEmail = "";
            let userPicture = null;
            if (tokenData.id_token) {
              try {
                const base64Payload = tokenData.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
                const payload = JSON.parse(Buffer.from(base64Payload, "base64").toString("utf8"));
                userName = payload.name || (payload.given_name ? `${payload.given_name} ${payload.family_name || ""}`.trim() : "") || payload.preferred_username || "";
                userEmail = payload.email || "";
                userPicture = payload.picture || null;
              } catch (e) {
                console.error("[OAuth] ID token decode error:", e);
              }
            }
            if (tokenData.access_token) {
              try {
                const userRes = await oauthFetch("https://www.googleapis.com/oauth2/v3/userinfo", {
                  headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    "User-Agent": "CilamAI/1.0"
                  }
                });
                if (userRes.ok) {
                  const profile = await userRes.json();
                  if (profile.name) userName = profile.name;
                  else if (profile.given_name) userName = `${profile.given_name} ${profile.family_name || ""}`.trim();
                  if (profile.email) userEmail = profile.email;
                  if (profile.picture) userPicture = profile.picture;
                }
              } catch (e) {
                console.error("[OAuth] Userinfo fetch error:", e);
              }
            }
            if (!userName && userEmail) {
              userName = userEmail.split("@")[0];
            }
            const userObj = {
              name: userName || userEmail.split("@")[0],
              email: userEmail,
              picture: userPicture,
              provider: "google"
            };
            currentAuthUser = userObj;
            saveStoredAuthUser(userObj);
            BrowserWindow.getAllWindows().forEach((win) => {
              win.webContents.send("auth:user", userObj);
            });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CilamAI - Sign In Successful</title>
  <style>
    body {
      background: transparent;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: transparent;
      border: none;
      border-radius: 16px;
      padding: 32px 40px;
      text-align: center;
      max-width: 400px;
    }
    .check {
      width: 48px;
      height: 48px;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
    }
    .check svg { width: 28px; height: 28px; stroke: #fff; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    h2 {  margin: 0 0 8px 0; color: #fff; font-size: 20px; }
    p { color: #888899; margin: 0; font-size: 14px; }
    .user { color: #6366f1;  }
  </style>
</head>
<body>
  <div class="card">
    <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
    <h2>Sign in successful!</h2>
    <p>You can now close this tab and return to CilamAI.</p>
  </div>
  <script>setTimeout(() => window.close(), 1500);<\/script>
</body>
</html>`);
            resolve({ ok: true, user: userObj });
          } catch (err) {
            console.error("[OAuth] Token exchange error:", err);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<html><body style="background:#171717;"><script>window.close()<\/script></body></html>`);
            resolve({ ok: false, error: err.message });
          } finally {
            setTimeout(() => {
              try {
                oauthHttpServer?.close();
              } catch {
              }
              oauthHttpServer = null;
            }, 2e3);
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const listenWithRetry = () => {
        const ports = callback.ports;
        let portIndex = 0;
        const tryNextPort = () => {
          if (portIndex >= ports.length) {
            console.error(`[OAuth] No free port found (${ports[0]}-${ports[ports.length - 1]} all in use)`);
            resolve({
              ok: false,
              error: callback.pinned ? `Port ${ports[0]} from OAUTH_REDIRECT_URI is already in use. Free it up or point OAUTH_REDIRECT_URI at a free port.` : "No free port available for OAuth callback"
            });
            return;
          }
          const port = ports[portIndex++];
          oauthPort = port;
          redirectUri = callback.redirectFor(port);
          lastRedirectUri = redirectUri;
          oauthHttpServer.once("error", (err) => {
            if (err.code === "EADDRINUSE" && !callback.pinned && portIndex < ports.length) {
              console.warn(`[OAuth] Port ${port} busy, trying next...`);
              try {
                oauthHttpServer.close();
              } catch {
              }
              tryNextPort();
            } else {
              console.error("[OAuth] Server error:", err);
              resolve({ ok: false, error: err.message });
            }
          });
          oauthHttpServer.listen(port, OAUTH_BIND_HOST, () => {
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent("openid email profile")}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&prompt=select_account%20consent`;
            console.log(`[OAuth] Opening Google sign-in with redirect_uri=${redirectUri}`);
            shell.openExternal(authUrl);
          });
        };
        tryNextPort();
      };
      listenWithRetry();
    });
  } else if (provider === "github") {
    const http2 = await import("node:http");
    if (oauthHttpServer) {
      try {
        oauthHttpServer.close();
      } catch {
      }
      oauthHttpServer = null;
    }
    const clientId = process.env.GITHUB_CLIENT_ID || "";
    if (!clientId) {
      console.warn("[OAuth] GITHUB_CLIENT_ID is not set in .env - GitHub sign-in is disabled.");
      return {
        ok: false,
        error: "GitHub sign-in is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart CilamAI."
      };
    }
    return await new Promise((resolve) => {
      let oauthPort = 3e3;
      let redirectUri = null;
      oauthHttpServer = http2.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://127.0.0.1:${oauthPort}`);
        const code = urlObj.searchParams.get("code");
        const error = urlObj.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Sign-In Cancelled</h2><p style="color:#888;">You can close this window and return to CilamAI.</p></div><script>setTimeout(()=>window.close(),1500)<\/script></body></html>`);
          try {
            oauthHttpServer.close();
          } catch {
          }
          oauthHttpServer = null;
          resolve({ ok: false, error });
          return;
        }
        if (code) {
          try {
            console.log("[OAuth] Exchanging GitHub code for token...");
            const tokenRes = await oauthFetch("https://github.com/login/oauth/access_token", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": "CilamAI/1.0"
              },
              body: JSON.stringify({
                client_id: clientId,
                client_secret: process.env.GITHUB_CLIENT_SECRET || "",
                code,
                redirect_uri: redirectUri
              })
            });
            const tokenData = await tokenRes.json();
            console.log("[OAuth] GitHub token received:", tokenData.error || "SUCCESS");
            if (tokenData.error) {
              console.error("[OAuth] GitHub token exchange failed:", tokenData.error, tokenData.error_description || "");
              resolve({ ok: false, error: describeOAuthRedirectError(tokenData.error_description || tokenData.error, redirectUri) });
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Sign-In Failed</h2><p style="color:#888;">${tokenData.error}</p></div></body></html>`);
              return;
            }
            if (!tokenData.access_token) {
              resolve({ ok: false, error: tokenData.error || "No access token" });
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<html><body style="background:#171717;"><script>window.close()<\/script></body></html>`);
              return;
            }
            const accessToken = tokenData.access_token;
            const userRes = await oauthFetch("https://api.github.com/user", {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "CilamAI/1.0"
              }
            });
            const profile = await userRes.json();
            let userEmail = profile.email || "";
            if (!userEmail) {
              try {
                const emailRes = await oauthFetch("https://api.github.com/user/emails", {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "CilamAI/1.0"
                  }
                });
                const emails = await emailRes.json();
                if (Array.isArray(emails)) {
                  const primary = emails.find((e) => e.primary) || emails[0];
                  if (primary) userEmail = primary.email || "";
                }
              } catch (e) {
                console.error("[OAuth] GitHub emails fetch error:", e);
              }
            }
            const userObj = {
              name: profile.name || profile.login || userEmail.split("@")[0] || "GitHub User",
              email: userEmail,
              picture: profile.avatar_url || null,
              provider: "github"
            };
            currentAuthUser = userObj;
            saveStoredAuthUser(userObj);
            BrowserWindow.getAllWindows().forEach((win) => {
              win.webContents.send("auth:user", userObj);
            });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CilamAI - Sign In Successful</title>
  <style>
    body {
      background: transparent;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card { text-align: center; }
    .check {
      width: 56px; height: 56px; border-radius: 50%;
      background: #10b981; display: flex;
      align-items: center; justify-content: center;
      margin: 0 auto 16px auto;
    }
    .check svg { width: 28px; height: 28px; stroke: #fff; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    h2 {  margin: 0 0 8px 0; color: #fff; font-size: 20px; }
    p { color: #888899; margin: 0; font-size: 14px; }
    .user { color: #6366f1;  }
  </style>
</head>
<body>
  <div class="card">
    <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
    <h2>Sign in successful!</h2>
    <p>You can now close this tab and return to CilamAI.</p>
  </div>
  <script>setTimeout(() => window.close(), 1500);<\/script>
</body>
</html>`);
            resolve({ ok: true, user: userObj });
          } catch (err) {
            console.error("[OAuth] GitHub token exchange error:", err);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<html><body style="background:#171717;"><script>window.close()<\/script></body></html>`);
            resolve({ ok: false, error: err.message });
          } finally {
            setTimeout(() => {
              try {
                oauthHttpServer?.close();
              } catch {
              }
              oauthHttpServer = null;
            }, 2e3);
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const listenWithRetry = () => {
        const ports = Array.from({ length: 11 }, (_, i) => 3011 + i);
        let portIndex = 0;
        const tryNextPort = () => {
          if (portIndex >= ports.length) {
            console.error("[OAuth] No free port found (3011-3021 all in use)");
            resolve({ ok: false, error: "No free port available for OAuth callback" });
            return;
          }
          const port = ports[portIndex++];
          oauthPort = port;
          redirectUri = `http://127.0.0.1:${port}`;
          oauthHttpServer.once("error", (err) => {
            if (err.code === "EADDRINUSE" && portIndex < ports.length) {
              console.warn(`[OAuth] Port ${port} busy, trying next...`);
              try {
                oauthHttpServer.close();
              } catch {
              }
              tryNextPort();
            } else {
              console.error("[OAuth] Server error:", err);
              resolve({ ok: false, error: err.message });
            }
          });
          oauthHttpServer.listen(port, "127.0.0.1", () => {
            const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("read:user user:email")}`;
            shell.openExternal(authUrl);
          });
        };
        tryNextPort();
      };
      listenWithRetry();
    });
    }
    console.warn(`[OAuth] Unsupported sign-in provider: ${provider}`);
    return { ok: false, error: `Unsupported sign-in provider: ${provider}` };
  } catch (err) {
    console.error("[OAuth] Unexpected sign-in error:", err);
    try {
      oauthHttpServer?.close();
    } catch {
    }
    oauthHttpServer = null;
    return {
      ok: false,
      error: "Something went wrong while signing in. Please try again. If the problem continues, restart CilamAI."
    };
  }
});
ipcMain.handle("auth:sign-out", async () => {
  currentAuthUser = null;
  saveStoredAuthUser(null);
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send("auth:user", null);
  });
  return { ok: true };
});
ipcMain.handle("auth:set-user", async (_event, user) => {
  const saved = applyAndSaveUser(user);
  return { ok: true, user: saved };
});
ipcMain.on("auth:set-user", (_event, user) => {
  applyAndSaveUser(user);
});
ipcMain.on("auth:set-user-sync", (event, user) => {
  const saved = applyAndSaveUser(user);
  event.returnValue = { ok: true, user: saved };
});
ipcMain.on("auth:set-avatar", (_event, picture) => {
  if (currentAuthUser) {
    currentAuthUser.picture = picture;
    saveStoredAuthUser(currentAuthUser);
  }
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send("auth:avatar", picture);
  });
});
ipcMain.handle("auth:set-avatar", async (_event, picture) => {
  if (currentAuthUser) {
    currentAuthUser.picture = picture;
    saveStoredAuthUser(currentAuthUser);
  }
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send("auth:avatar", picture);
  });
  return { ok: true, picture };
});
ipcMain.handle("auth:upload-avatar", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "No window" };
  const result = await dialog.showOpenDialog(win, {
    title: "Select Avatar Image",
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] }
    ],
    properties: ["openFile"]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const data = await readFile(filePath);
    const ext = filePath.split(".").pop().toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
    if (currentAuthUser) {
      currentAuthUser.picture = dataUrl;
      saveStoredAuthUser(currentAuthUser);
    }
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send("auth:avatar", dataUrl);
      if (currentAuthUser) {
        w.webContents.send("auth:user", currentAuthUser);
      }
    });
    return { ok: true, picture: dataUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function createWindow() {
  const windowState = loadWindowState();
  const win = new BrowserWindow({
    title: "CilamAI",
    icon: join(app.getAppPath(), "resources/icon.ico"),
    width: windowState.width || 1440,
    height: windowState.height || 900,
    x: windowState.x,
    y: windowState.y,
    minWidth: 1e3,
    minHeight: 700,
    frame: false,
    roundedCorners: true,
    show: false,
    autoHideMenuBar: true,

    backgroundColor: "#0d1117",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
    }
  });
  applyRestoredWindowBounds(win, windowState);
  win.removeMenu();
  win.setMenuBarVisibility(false);
  // DevTools stays available in packaged builds, but it never opens on its own:
  // F12 or Ctrl+Shift+I / Ctrl+Shift+J toggles it on demand.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    const toggle =
      key === "f12" ||
      (input.control && input.shift && (key === "i" || key === "j"));
    if (toggle) {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }
    // Ctrl+R / Ctrl+Shift+R reload: packaged builds only. In dev, electron-vite owns
    // reloads through HMR and a manual reload would drop the dev-server state.
    if (app.isPackaged && input.control && key === "r") {
      event.preventDefault();
      if (input.shift) win.webContents.reloadIgnoringCache();
      else win.webContents.reload();
    }
  });
  setTimeout(() => {
    if (!win.isVisible()) {
      try { win.show(); } catch {}
    }
  }, 8000);
  win.on("ready-to-show", () => {
    win.show();
    if (windowState.maximized) {
      win.maximize();
    }
  });
  setTimeout(() => {
    if (!win.isVisible()) {
      win.show();
    }
  }, 3e3);
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  win.on("close", () => {
    const bounds = win.getContentBounds();
    saveWindowState({
      maximized: win.isMaximized(),
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/signin.html"));
    // Local builds (electron . / npm start) open DevTools automatically so the
    // built app can be debugged. Real installers (app.isPackaged) and the dev
    // server (electron-vite owns reloads) keep their on-demand F12 behavior.
    if (!app.isPackaged) {
      win.webContents.once("did-finish-load", () => {
        try {
          win.webContents.openDevTools({ mode: "detach" });
        } catch {}
      });
    }
  }
}
let feedbackWindow = null;
let signinWindow = null;
function openSigninWindow() {
  if (signinWindow && !signinWindow.isDestroyed()) {
    signinWindow.focus();
    return;
  }
  const mainWin = BrowserWindow.getAllWindows().find((w) => w !== signinWindow && !w.isDestroyed());
  signinWindow = new BrowserWindow({
    title: "Sign in - CilamAI",
    icon: join(app.getAppPath(), "resources/icon.ico"),
    width: 360,
    height: 420,
    minWidth: 360,
    minHeight: 400,
    parent: mainWin || void 0,
    center: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    hasShadow: false,
    thickFrame: false,
    backgroundMaterial: "mica",
    autoHideMenuBar: true,
    backgroundColor: "#0f1015",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
    }
  });
  signinWindow.setMenuBarVisibility(false);
  signinWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    signinWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/signin.html`);
  } else {
    signinWindow.loadFile(join(__dirname, "../renderer/signin.html"));
  }
  signinWindow.webContents.on("did-finish-load", () => {
    signinWindow.webContents.send("app:theme-changed", currentTheme);
    if (currentCustomColors.accent) {
      signinWindow.webContents.send("app:custom-colors-changed", currentCustomColors);
    }
  });
  signinWindow.on("closed", () => {
    signinWindow = null;
  });
}
function openFeedbackWindow() {
  if (feedbackWindow && !feedbackWindow.isDestroyed()) {
    feedbackWindow.focus();
    return;
  }
  const mainWin = BrowserWindow.getAllWindows().find((w) => w !== feedbackWindow && !w.isDestroyed());
  feedbackWindow = new BrowserWindow({
    title: "Provide Feedback - CilamAI",
    icon: join(app.getAppPath(), "resources/icon.ico"),
    width: 580,
    height: 840,
    minWidth: 480,
    minHeight: 600,
    parent: mainWin || void 0,
    center: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    hasShadow: true,
    thickFrame: true,
    backgroundMaterial: "mica",
    autoHideMenuBar: true,
    backgroundColor: "#0f1015",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
    }
  });
  feedbackWindow.setMenuBarVisibility(false);
  feedbackWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    feedbackWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/feedback.html`);
  } else {
    feedbackWindow.loadFile(join(__dirname, "../renderer/feedback.html"));
  }
  feedbackWindow.webContents.on("did-finish-load", () => {
    feedbackWindow.webContents.send("app:theme-changed", currentTheme);
    if (currentCustomColors.accent) {
      feedbackWindow.webContents.send("app:custom-colors-changed", currentCustomColors);
    }
  });
  feedbackWindow.on("closed", () => {
    feedbackWindow = null;
  });
}
ipcMain.handle("app:open-signin-window", () => {
  openSigninWindow();
  return { ok: true };
});
ipcMain.handle("app:open-feedback-window", () => {
  openFeedbackWindow();
  return { ok: true };
});
ipcMain.handle("app:resize-feedback-window", (_event, { width, height } = {}) => {
  if (feedbackWindow && !feedbackWindow.isDestroyed()) {
    const w = Number(width) || 520;
    const h = Number(height) || 340;
    feedbackWindow.setMinimumSize(320, 200);
    feedbackWindow.setSize(w, h, true);
    feedbackWindow.center();
  }
  return { ok: true };
});
function runGit(args, cwd) {
  try {
    const result = execSync(`git ${args}`, { cwd, encoding: "utf8", timeout: 15e3 });
    return { ok: true, output: result.trim() };
  } catch (e) {
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}
ipcMain.handle("worktrees:list", (_event, { cwd } = {}) => {
  const dir = cwd || process.cwd();
  const res = runGit("worktree list --porcelain", dir);
  if (!res.ok) return res;
  const worktrees = [];
  const blocks = res.output.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    const wt = {};
    for (const line of lines) {
      if (line.startsWith("worktree ")) wt.path = line.slice(10);
      else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
      else if (line.startsWith("branch ")) wt.branch = line.slice(7);
      else if (line === "bare") wt.bare = true;
    }
    if (wt.path) worktrees.push(wt);
  }
  return { ok: true, worktrees };
});
ipcMain.handle("worktrees:create", (_event, { branch, cwd } = {}) => {
  const dir = cwd || process.cwd();
  let location = ".worktrees";
  let prefix = "wt/";
  try {
    const cfgPath = join(app.getPath("userData"), "settings.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8") || "{}");
    location = cfg.worktreesLocation || location;
    prefix = cfg.worktreesBranchPrefix || prefix;
  } catch {
  }
  const branchName = branch || `${prefix}${Date.now()}`;
  const worktreeDir = join(dir, location, branchName);
  const res = runGit(`worktree add "${worktreeDir}" -b "${branchName}"`, dir);
  if (!res.ok) return res;
  return { ok: true, path: worktreeDir, branch: branchName };
});
ipcMain.handle("worktrees:remove", (_event, { path: wtPath, cwd } = {}) => {
  const dir = cwd || process.cwd();
  return runGit(`worktree remove "${wtPath}" --force`, dir);
});
ipcMain.handle("worktrees:prune", (_event, { cwd } = {}) => {
  const dir = cwd || process.cwd();
  return runGit("worktree prune", dir);
});
ipcMain.handle("worktrees:info", (_event, { path: wtPath, cwd } = {}) => {
  const dir = wtPath || cwd || process.cwd();
  const res = runGit("status --porcelain", dir);
  if (!res.ok) return res;
  const branchRes = runGit("branch --show-current", dir);
  const commitRes = runGit("rev-parse --short HEAD", dir);
  return {
    ok: true,
    branch: branchRes.output || "detached",
    commit: commitRes.output || "unknown",
    dirty: res.output.length > 0
  };
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (argv.includes("--new-chat")) {
      win?.webContents.send("task:new-chat");
    }
    const apiKey = extractApiKey(argv);
    if (apiKey) {
      pendingApiKey = apiKey;
      win?.webContents.send("task:set-apikey", apiKey);
    }
    const avatarArg = extractAvatar(argv);
    const userArg = extractUser(argv);
    const ipcCommand = extractIpcCommand(argv);
    if (userArg) {
      const parsed = parseUserString(userArg);
      if (parsed) {
        if (avatarArg) parsed.picture = avatarArg;
        applyAndSaveUser(parsed);
      }
      win?.webContents.send("task:ipc", `user:${userArg}`);
    } else if (avatarArg) {
      if (currentAuthUser) {
        currentAuthUser.picture = avatarArg;
        saveStoredAuthUser(currentAuthUser);
        win?.webContents.send("auth:user", currentAuthUser);
      }
      win?.webContents.send("auth:avatar", avatarArg);
    }
    if (ipcCommand) {
      if (ipcCommand.startsWith("user:")) {
        const parsed = parseUserString(ipcCommand.slice(5));
        if (parsed) applyAndSaveUser(parsed);
      }
      win?.webContents.send("task:ipc", ipcCommand);
    }
    if (argv.includes("--settings")) {
      win?.webContents.send("task:show-settings");
    }
    const modelArg = extractModelArg(argv);
    if (modelArg) {
      win?.webContents.send("task:ipc", `model:${modelArg}`);
    } else if (argv.includes("--model")) {
      win?.webContents.send("task:show-model-menu");
    }
    if (argv.includes("--view-logs")) {
      win?.webContents.send("task:view-logs");
    }
    if (argv.includes("--whats-new")) {
      win?.webContents.send("task:show-release-notes");
    }
    if (argv.includes("--quit")) {
      app.quit();
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
  });
  app.whenReady().then(async () => {
    app.setPath("userData", join(app.getPath("appData"), "CilamAI"));
    await applyProxyFromEnv();
    app.setAppUserModelId("com.olinai.app");
    Menu.setApplicationMenu(null);
    app.setUserTasks([]);
    createWindow();
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.once("did-finish-load", () => {
        if (process.argv.includes("--whats-new")) {
          win.webContents.send("task:show-release-notes");
          return;
        }
        const releaseNotes = loadReleaseNotes();
        const currentVersion = app.getVersion();
        if (releaseNotes.lastShownVersion !== currentVersion) {
          saveReleaseNotes({ lastShownVersion: currentVersion });
          win.webContents.send("task:show-release-notes");
          return;
        }
        const apiKey = extractApiKey(process.argv);
        if (apiKey) {
          pendingApiKey = apiKey;
          win.webContents.send("task:set-apikey", apiKey);
        }
        const avatarArg = extractAvatar(process.argv);
        const userArg = extractUser(process.argv);
        const ipcCommand = extractIpcCommand(process.argv);
        let initialUser = loadStoredAuthUser();
        if (userArg) {
          const parsed = parseUserString(userArg);
          if (parsed) {
            if (avatarArg) parsed.picture = avatarArg;
            initialUser = parsed;
            currentAuthUser = initialUser;
            saveStoredAuthUser(initialUser);
          }
        } else if (ipcCommand && ipcCommand.startsWith("user:")) {
          const parsed = parseUserString(ipcCommand.slice(5));
          if (parsed) {
            if (avatarArg) parsed.picture = avatarArg;
            initialUser = parsed;
            currentAuthUser = initialUser;
            saveStoredAuthUser(initialUser);
          }
        } else if (avatarArg && initialUser) {
          initialUser.picture = avatarArg;
          currentAuthUser = initialUser;
          saveStoredAuthUser(initialUser);
        } else if (initialUser) {
          currentAuthUser = initialUser;
        }
        if (initialUser) {
          win.webContents.send("auth:user", initialUser);
        }
        if (avatarArg) {
          win.webContents.send("auth:avatar", avatarArg);
        }
        if (userArg) {
          win.webContents.send("task:ipc", `user:${userArg}`);
        }
        if (ipcCommand) {
          win.webContents.send("task:ipc", ipcCommand);
        }
        const modelArg = extractModelArg(process.argv);
        if (modelArg) {
          win.webContents.send("task:ipc", `model:${modelArg}`);
        } else if (process.argv.includes("--model")) {
          win.webContents.send("task:show-model-menu");
        }
      });
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}
app.on("window-all-closed", () => {
  clearTimeout(sessionWriteTimer);
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  clearTimeout(sessionWriteTimer);
});
