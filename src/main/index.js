import { app, ipcMain, shell, BrowserWindow, WebContentsView, dialog, Menu, net, session, clipboard, nativeImage, screen, nativeTheme, safeStorage } from "electron";
import { join, resolve } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, createWriteStream, openSync, readSync, closeSync, rmSync } from "node:fs";
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
const TRANSIENT_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
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
    // Ask OpenAI-compatible endpoints for the real usage block so token counts
    // and timings come from the API instead of being estimated locally.
    if (stream && !/claude/i.test(String(model))) {
      body.stream_options = { include_usage: true };
    }
  }
  return body;
}

function extractChatUsage(data) {
  if (!data || typeof data !== "object") return null;
  const src = data.usage && typeof data.usage === "object" ? data.usage : {};
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const completion = num(src.completion_tokens) ?? num(src.output_tokens) ?? num(data.eval_count);
  const prompt = num(src.prompt_tokens) ?? num(src.input_tokens) ?? num(data.prompt_eval_count);
  const total = num(src.total_tokens) ?? (completion && prompt ? completion + prompt : undefined);
  const cost = num(src.total_cost) ?? num(src.cost) ?? num(data.cost);
  const usage = {};
  if (completion) usage.completion_tokens = completion;
  if (prompt) usage.prompt_tokens = prompt;
  if (total) usage.total_tokens = total;
  if (cost) usage.cost = cost;
  const evalDuration = num(data.eval_duration);
  if (evalDuration) usage.eval_duration_ms = Math.round(evalDuration / 1e6);
  const loadDuration = num(data.load_duration);
  if (loadDuration) usage.load_duration_ms = Math.round(loadDuration / 1e6);
  const totalDuration = num(data.total_duration);
  if (totalDuration) usage.total_duration_ms = Math.round(totalDuration / 1e6);
  return Object.keys(usage).length ? usage : null;
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
        usage: extractChatUsage(data),
        finish_reason: data?.choices?.[0]?.finish_reason || data?.done_reason
      }
    };
  }
}
async function chatSendStream({ url, model, messages, provider, apiKey, org, reasoningEffort, envConfig: envConfig2 }, { signal, onChunk, onReasoning }) {
  const requestStartedAt = Date.now();
  const headers = buildHeaders({ model, apiKey, envConfig: envConfig2 });
  const isOpenAI = isOpenAiCompat(provider);
  const body = buildChatBody({ model, messages, stream: true, provider, reasoningEffort });
  let attempt = 0;
  const maxAttempts = 5;
  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  let res;
  while (true) {
    try {
      res = await doFetch();
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
      // Some OpenAI-compatible servers reject stream_options; retry without it
      // so the request still succeeds (usage simply stays unavailable).
      if (res.status === 400 && body.stream_options) {
        delete body.stream_options;
        try {
          res = await doFetch();
          if (res.ok) break;
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
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
  let streamUsage = null;
  const noteUsage = (chunk) => {
    const usage = extractChatUsage(chunk);
    if (usage) streamUsage = { ...(streamUsage || {}), ...usage };
  };
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
          noteUsage(chunk);
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
        noteUsage(chunk);
      }
    }
  }
  contentRouter.flush();
  const diagnostics = {
    usage: streamUsage,
    totalMs: Date.now() - requestStartedAt
  };
  return aborted ? { ok: true, aborted: true, diagnostics } : { ok: true, diagnostics };
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

function refreshEnvFromFile(keys) {
  try {
    const envPath = join(app.getAppPath(), ".env");
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && keys.includes(m[1])) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
  }
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
// How long a single redirect URI candidate is given before the sign-up falls
// back to the other loopback form (Google shows a mismatch error page instead
// of redirecting, so a silent fallback is the only way to recover).
const OAUTH_CANDIDATE_TIMEOUT_MS = 30e3;
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
// Google compares the redirect URI literally: "http://localhost:3000" and
// "http://127.0.0.1:3000" are two different URIs. The loopback callback server
// answers to both, so the sign-up tries the configured URI first and falls back
// to the other form instead of dying on "Error 400: redirect_uri_mismatch".
function redirectUriCandidates(port, configured = "") {
  const list = [];
  const push = (value) => {
    const uri = (value || "").trim();
    if (uri && !list.includes(uri)) list.push(uri);
  };
  push(configured);
  push(`http://${OAUTH_BIND_HOST}:${port}`);
  push(`http://localhost:${port}`);
  return list;
}
function resolveOAuthCallback() {
  const configured = (process.env.OAUTH_REDIRECT_URI || "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (!/^https?:$/.test(url.protocol)) throw new Error("must be an http(s) URI");
      if (!url.port) throw new Error("must include an explicit port");
      return {
        ports: [Number(url.port)],
        pinned: true,
        redirectFor: () => configured,
        candidatesFor: (port) => redirectUriCandidates(port, configured)
      };
    } catch (err) {
      console.warn(`[OAuth] Ignoring invalid OAUTH_REDIRECT_URI (${err.message}): ${configured}`);
    }
  }
  // Google requires an EXACT redirect URI registered in the OAuth client.
  // Use one fixed port so it is registerable (register http://127.0.0.1:3000 in Google Cloud).
  const port = 3000;
  console.log(
    `[OAuth] Google redirect URI: http://${OAUTH_BIND_HOST}:${port} (register this exact value in Google Cloud, or set OAUTH_REDIRECT_URI to use a different port)`
  );
  return {
    ports: [port],
    pinned: true,
    redirectFor: () => `http://${OAUTH_BIND_HOST}:${port}`,
    candidatesFor: (port) => redirectUriCandidates(port)
  };
}
const streamControllers = new Map();
const TRANSIENT_STATUSES_MAIN = new Set([408, 425, 429, 502, 503, 504]);
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
    const fitW = Math.min(width, area.width);
    const fitH = Math.min(height, area.height);
    const clampedX = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - fitW));
    const clampedY = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - fitH));
    win.setContentBounds({ x: clampedX, y: clampedY, width: fitW, height: fitH });
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
ipcMain.handle("app:copy-image-to-clipboard", async (_event, source) => {
  try {
    let image;
    if (typeof source === "string" && /^https?:\/\//i.test(source)) {
      const response = await net.fetch(source);
      if (!response.ok) return { ok: false, error: `Image download failed (HTTP ${response.status})` };
      image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    } else {
      image = nativeImage.createFromDataURL(source);
    }
    if (image.isEmpty()) return { ok: false, error: "Image is empty" };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
const UPDATE_CHECK_TIMEOUT_MS = 10e3;

const runUpdateCheck = async () => {
  const fallbackVersion = app.getVersion();
            const defaultDownloadUrl = "https://github.com/XDev127/CilamAI/releases/latest/download/CilamAI-Setup.exe";
            const tagFromUrl = (url) => {
              const match = String(url || "").match(/\/releases\/tag\/([^/?#]+)/i);
              return match ? decodeURIComponent(match[1]) : "";
            };
            try {
              const deadline = Date.now() + UPDATE_CHECK_TIMEOUT_MS;
              const getJson = (url) => new Promise((resolve, reject) => {
                const remaining = deadline - Date.now();
                if (remaining <= 0) return reject(new Error("Update check timed out"));
                const parsed = new URL(url);
                const client = parsed.protocol === "http:" ? http : https;
                const request = client.get(url, {
                  timeout: Math.max(1, remaining),
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
                request.on("timeout", () => request.destroy(new Error("Update check timed out")));
              });
              let release = null;
              try {
                release = await getJson("https://api.github.com/repos/XDev127/CilamAI/releases/latest");
              } catch {
                try {
                  const tags = await getJson("https://api.github.com/repos/XDev127/CilamAI/tags");
                  if(Array.isArray(tags) && tags.length > 0) {
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
  return { ok: false, error: err?.message || "Update check failed", current: app.getVersion() };
}
};

ipcMain.handle("app:check-updates", async () => {
  const current = app.getVersion();
  const fallback = {
    ok: false,
    error: `Update check timed out after ${UPDATE_CHECK_TIMEOUT_MS / 1e3}s`,
    current
  };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), UPDATE_CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([runUpdateCheck(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  });

  const NSIS_SETUP_URL = "https://github.com/XDev127/CilamAI/releases/latest/download/CilamAI-Setup.exe";
  // electron-builder ships the updates as an NSIS setup executable:
  // /S installs silently, --updated skips the wizard pages and keeps the user
  // data, --force-run starts the freshly installed app when the install is done.
  const NSIS_INSTALLER_ARGS = ["/S", "--updated", "--force-run"];
  const NSIS_INSTALLER_MIN_SIZE = 256 * 1024;
  const UPDATE_QUIT_DELAY_MS = 400;
  const HELPER_EXIT_TIMEOUT_MS = 60e3;

  const escapePowerShell = (value) => String(value).replace(/'/g, "''");

  // Waits until this process is gone so the helper never touches the files of
  // a still running app.
  const waitForExitScript = (pid) => [
    `$deadline = (Get-Date).AddSeconds(${Math.round(HELPER_EXIT_TIMEOUT_MS / 1000)})`,
    `while ((Get-Date) -lt $deadline) {`,
    `if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }`,
    `Start-Sleep -Milliseconds 200`,
    `}`
  ].join(" ");

  // Runs a PowerShell snippet in a detached helper process so it survives the
  // shutdown of the app.
  const spawnDetachedHelper = (script) => {
    try {
      const helper = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      helper.unref();
      return true;
    } catch {
      return false;
    }
  };

  // Restarts the app once this process is gone.
  const spawnRelaunchHelper = () => {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      waitForExitScript(process.pid),
      `Start-Process -FilePath '${escapePowerShell(process.execPath)}'`
    ].join("; ");
    return spawnDetachedHelper(script);
  };

  // Installs the update with the NSIS installer and lets the installer start
  // the new build. The installer is only started after this process exited so
  // the installed files can be replaced without killing the app mid write.
  const spawnInstallerHelper = (installerPath) => {
    const args = NSIS_INSTALLER_ARGS.map((arg) => `'${escapePowerShell(arg)}'`).join(",");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      waitForExitScript(process.pid),
      `Start-Process -FilePath '${escapePowerShell(installerPath)}' -ArgumentList ${args} -Wait`
    ].join("; ");
    if (spawnDetachedHelper(script)) return true;
    // No PowerShell available: run the installer right away. It waits for the
    // running app to exit on its own and replaces the files itself.
    try {
      const installer = spawn(installerPath, NSIS_INSTALLER_ARGS, { detached: true, stdio: "ignore", windowsHide: true });
      installer.unref();
      return true;
    } catch {
      return false;
    }
  };

  const isWindowsExecutable = (filePath) => {
    try {
      if (statSync(filePath).size < NSIS_INSTALLER_MIN_SIZE) return false;
      const fd = openSync(filePath, "r");
      try {
        const header = Buffer.alloc(2);
        readSync(fd, header, 0, 2, 0);
        return header.toString("latin1") === "MZ";
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  };

  // Downloads the NSIS setup executable of the latest release and returns the
  // path of the installer, or null when the download failed.
  const downloadNsisInstaller = async (downloadUrl) => {
    const filePath = join(app.getPath("temp"), `CilamAI-Setup-${Date.now()}.exe`);
    const candidateUrls = [
      downloadUrl,
      NSIS_SETUP_URL,
      `https://github.com/XDev127/CilamAI/releases/download/v${app.getVersion()}/CilamAI-Setup.exe`
    ].filter(Boolean);
    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3 * 60e3);
        try {
          const response = await net.fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CilamAI" },
            redirect: "follow",
            signal: controller.signal
          });
          if (!response.ok || !response.body) continue;
          await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
        } finally {
          clearTimeout(timer);
        }
        // A failed download can leave an error page behind, never run
        // something that is not a Windows executable.
        if (!isWindowsExecutable(filePath)) {
          rmSync(filePath, { force: true });
          continue;
        }
        return filePath;
      } catch {
        // try the next mirror
      }
    }
    rmSync(filePath, { force: true });
    return null;
  };

  const quitForUpdate = () => {
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.hide();
      });
    } catch {
      // the window is already gone
    }
    // Give the renderer a moment to flush its state before the app goes away.
    setTimeout(() => app.quit(), UPDATE_QUIT_DELAY_MS);
  };

  // Downloads the latest release, installs it with the NSIS installer and
  // restarts the app afterwards.
  const installUpdateAndRelaunch = async (downloadUrl) => {
    if (process.platform !== "win32") {
      return { ok: false, error: "Automatic updates are only available on Windows" };
    }
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      // The portable build is not installed through NSIS, it cannot be updated
      // in place.
      return { ok: false, error: "The portable build cannot be updated in place" };
    }
    const installerPath = await downloadNsisInstaller(downloadUrl);
    if (!installerPath) {
      return { ok: false, error: "Could not download the update" };
    }
    if (!spawnInstallerHelper(installerPath)) {
      return { ok: false, error: "Could not start the installer" };
    }
    quitForUpdate();
    return { ok: true, restarting: true };
  };

  ipcMain.handle("app:download-and-install", async (_event, downloadUrl) => {
    const result = await installUpdateAndRelaunch(downloadUrl);
    if (result.ok) return result;
    const targetUrl = downloadUrl || "https://github.com/XDev127/CilamAI/releases/latest";
    shell.openExternal(targetUrl);
    return { ok: true, openedInBrowser: true };
  });

  ipcMain.handle("app:update-and-relaunch", async (_event, downloadUrl) => {
    return await installUpdateAndRelaunch(downloadUrl);
  });
  let currentTheme = "system";
  const themeFile = () => join(app.getPath("userData"), "theme.json");
  try {
    const savedTheme = readFileSync(themeFile(), "utf8");
    if (savedTheme) currentTheme = savedTheme.trim();
  } catch {
  }
  const LIGHT_THEMES = new Set(["light", "github-light", "opencode-light", "vercel-light"]);
  function windowBackgroundColor(theme = currentTheme) {
    const effective = theme === "system"
      ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
      : theme;
    return LIGHT_THEMES.has(effective) ? "#f6f8fa" : "#0d1117";
  }
  function broadcastTheme(theme) {
    currentTheme = theme;
    try {
      writeFileSync(themeFile(), theme);
    } catch {
    }
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) {
        try { w.setBackgroundColor(windowBackgroundColor(theme)); } catch { }
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
  ipcMain.handle("voice:transcribe", async (_event, { url, apiKey, model, mimeType, filename, data }) => {
    if (!url) return { ok: false, error: "Missing transcription endpoint." };
    try {
      const buf = Buffer.from(data);
      const form = new FormData();
      const blob = new Blob([buf], { type: mimeType || "audio/webm" });
      form.append("file", blob, filename || "voice.webm");
      form.append("model", model || "whisper-1");
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, { method: "POST", headers, body: form });
      const raw = await res.text().catch(() => "");
      let json = null;
      try { json = raw ? JSON.parse(raw) : null } catch { json = null }
      if (!res.ok) {
        const detail = json?.error?.message || (typeof json?.error === "string" ? json.error : null) || raw || `HTTP ${res.status}`;
        return { ok: false, error: `${res.status}: ${detail}`.slice(0, 500) };
      }
      const text = json?.text ?? (typeof json === "string" ? json : "");
      return { ok: true, text: String(text || "") };
    } catch (err) {
      return { ok: false, error: err.message };
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
  function resetUsageForCurrentUser() {
    try {
      const key = currentUserKey();
      const user = currentAuthUser || loadStoredAuthUser();
      const config = getUserCreditConfig(user || key);
      const store = loadCreditsStore();
      const saved = store[key] || {};
      store[key] = {
        ...saved,
        used: 0,
        limit: config.limit,
        resetAt: Date.now() + config.resetInterval
      };
      saveCreditsStore(store);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  ipcMain.handle("credits:reset", () => resetUsageForCurrentUser());
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
      const stamp = (new Date()).toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const file = join(app.getPath("pictures"), `chat-${stamp}.png`);
      await writeFile(file, pngData);
      return { ok: true, path: file, data: pngData.toString("base64") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  function apiLogHost(url) {
    try { return new URL(url).host; } catch { return String(url || "unknown"); }
  }
  function logApiResult(label, host, result, started) {
    const took = Date.now() - started;
    if (result && result.ok) {
      console.log(`[Done] api ${label} @ ${host} (${took}ms)`);
    } else {
      console.error(`[Error] api ${label} @ ${host}: ${result?.error || "unknown error"} (${took}ms)`);
    }
  }
  ipcMain.handle("chat:send", async (_event, { url, model, messages, provider, apiKey, org, reasoningEffort }) => {
    const started = Date.now();
    let result;
    try {
      result = await chatSend({ url, model, messages, provider, apiKey, envConfig, org, reasoningEffort });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    logApiResult(`chat:send ${model}`, apiLogHost(url), result, started);
    return result;
  });
  ipcMain.handle("chat:send-stream", async (event, { url, model, messages, provider, apiKey, org, reasoningEffort }) => {
    const started = Date.now();
    const result = await sendWithRetry(async () => {
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
    logApiResult(`chat:send-stream ${model}`, apiLogHost(url), result, started);
    return result;
  });
  ipcMain.on("chat:stop-stream", (event) => {
    streamControllers.get(event.sender.id)?.abort();
  });
  ipcMain.handle("web:fetch-stream", async (event, { url }) => {
    const started = Date.now();
    const controller = new AbortController();
    streamControllers.set(event.sender.id, controller);
    let result;
    try {
      result = await webFetchStream(url, {
        signal: controller.signal,
        onChunk: (text) => event.sender.send("chat:stream-chunk", text),
        onReasoning: (text) => event.sender.send("chat:stream-reasoning", text)
      });
    } finally {
      streamControllers.delete(event.sender.id);
    }
    logApiResult("web:fetch-stream", apiLogHost(url), result, started);
    return result;
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
  // Restarts the app. A detached helper takes over the relaunch so the app
  // really comes back, even when the graceful quit is delayed.
  const restartApp = () => {
    if (app.isPackaged && process.platform === "win32" && spawnRelaunchHelper()) {
      app.quit();
      return;
    }
    app.relaunch();
    app.quit();
  };
  ipcMain.handle("app:restart", () => {
    restartApp();
    return { ok: true };
  });
  ipcMain.handle("window:open-devtools", (event) => {
    if (app.isPackaged) return { ok: false };
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools();
    return { ok: true };
  });

  let streamEndBadge = null;
  function getStreamEndBadge() {
    if (streamEndBadge) return streamEndBadge;
    const badge = nativeImage.createFromPath(join(app.getAppPath(), "resources/badge-1.png"));
    if (!badge.isEmpty()) {
      streamEndBadge = { icon: badge.resize({ width: 16, height: 16 }), text: "" };
      return streamEndBadge;
    }
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
    if (win.isFocused() && !win.isMinimized()) return;
    try {
      const badge = getStreamEndBadge();
      win.setOverlayIcon(badge.icon, badge.text);
      const clear = () => {
        if (win.isDestroyed()) return;
        try { win.setOverlayIcon(null, ""); } catch { }
      };
      win.once("focus", clear);
      win.once("restore", clear);
    } catch { }
  });
  ipcMain.handle("app:open-external", (_event, url) => {
    if (url && typeof url === "string") shell.openExternal(url);
  });
  const terminalSessions = new Map();
  let terminalSeq = 0;
  const TERMINAL_MARK = "__CILAMAI_TERM__";
  function terminalSentinel(kind) {
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
  // Real OAuth token session storage (encrypted with safeStorage when available)
  let currentAuthTokens = null;
  let signedIn = false;
  // A session is active when OAuth tokens are on disk. Deriving this (instead of
  // relying on a per-process flag) keeps the account alive across app restarts.
  const isSessionActive = () => signedIn || Boolean(getStoredTokens());
  function tokenStorePath() {
    return join(app.getPath("userData"), "auth_tokens.bin");
  }
  function saveStoredTokens(tokens) {
    try {
      const p = tokenStorePath();
      if (!tokens) {
        if (existsSync(p)) unlinkSync(p);
        currentAuthTokens = null;
        return;
      }
      const json = JSON.stringify(tokens);
      if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
        writeFileSync(p, safeStorage.encryptString(json));
      } else {
        writeFileSync(p, json, "utf8");
      }
      currentAuthTokens = tokens;
    } catch (err) {
      console.error("[OAuth] Failed to save tokens:", err);
    }
  }
  function loadStoredTokens() {
    try {
      const p = tokenStorePath();
      if (!existsSync(p)) return null;
      const raw = readFileSync(p);
      try {
        const text = raw.toString("utf8");
        if (text.trim().startsWith("{")) return JSON.parse(text);
      } catch {
      }
      if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(raw).toString("utf8"));
      }
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  }
  function getStoredTokens() {
    if (!currentAuthTokens) currentAuthTokens = loadStoredTokens();
    return currentAuthTokens;
  }
  const TOKEN_EXPIRY_SKEW_MS = 60e3;
  function isTokenExpired(tokens) {
    if (!tokens) return true;
    if (!tokens.expires_at) return false;
    return Date.now() >= Number(tokens.expires_at) - TOKEN_EXPIRY_SKEW_MS;
  }
  // Google access tokens live for about an hour. The stored refresh token keeps
  // the signed-in account alive, so the session is renewed through the API
  // instead of forcing the user through the consent screen again.
  async function refreshStoredTokens() {
    const tokens = getStoredTokens();
    if (!tokens?.refresh_token || tokens.provider !== "google") return null;
    const clientId = getGoogleClientId();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    if (!clientId || !clientSecret) return null;
    try {
      const tokenRes = await oauthFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token"
        })
      });
      const data = await tokenRes.json();
      if (data?.error || !data?.access_token) {
        console.error("[OAuth] Token refresh failed:", data?.error || "no access token");
        if (/invalid_grant|invalid_client|unauthorized_client/i.test(String(data?.error || ""))) {
          // The stored grant is dead: drop the refresh token so the next sign-up
          // asks for consent again instead of failing silently later on.
          saveStoredTokens({ ...tokens, refresh_token: null });
        }
        return null;
      }
      const refreshed = {
        ...tokens,
        access_token: data.access_token,
        scope: data.scope || tokens.scope || "",
        id_token: data.id_token || tokens.id_token || null,
        expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null
      };
      saveStoredTokens(refreshed);
      return refreshed;
    } catch (err) {
      console.warn("[OAuth] Token refresh failed:", err?.message || err);
      return null;
    }
  }
  async function ensureFreshTokens() {
    const tokens = getStoredTokens();
    if (!tokens) return null;
    if (!isTokenExpired(tokens)) return tokens;
    return (await refreshStoredTokens()) || tokens;
  }
  // Restore the previous session instead of clearing it: the signed-in account
  // and its profile must survive app restarts.
  function restoreStoredSession() {
    const tokens = getStoredTokens();
    const user = loadStoredAuthUser();
    if (tokens) {
      currentAuthTokens = tokens;
      signedIn = true;
    }
    if (user) currentAuthUser = user;
    return { tokens, user };
  }
  // Pull the account data straight from the provider API. Only missing fields
  // are filled in, so local edits (custom display name, uploaded avatar) and
  // already stored data are never removed.
  let accountSyncInFlight = null;
  function syncAccountProfileFromApi() {
    if (accountSyncInFlight) return accountSyncInFlight;
    accountSyncInFlight = performAccountProfileSync().finally(() => {
      accountSyncInFlight = null;
    });
    return accountSyncInFlight;
  }
  async function performAccountProfileSync() {
    const tokens = await ensureFreshTokens();
    if (!tokens?.access_token) return null;
    let profile = null;
    try {
      if (tokens.provider === "google") {
        const res = await oauthFetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "User-Agent": "CilamAI/1.0"
          }
        });
        if (res.ok) profile = await res.json();
      } else if (tokens.provider === "github") {
        const res = await oauthFetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "CilamAI/1.0"
          }
        });
        if (res.ok) profile = await res.json();
      }
    } catch (err) {
      console.warn("[Auth] Account data sync failed:", err?.message || err);
      return null;
    }
    if (!profile) return null;
    const existing = currentAuthUser || loadStoredAuthUser() || {};
    const incoming = { provider: tokens.provider || existing.provider || "google" };
    if (profile.name) incoming.name = profile.name;
    else if (profile.given_name) incoming.name = `${profile.given_name} ${profile.family_name || ""}`.trim();
    else if (profile.login) incoming.name = profile.login;
    if (profile.email) incoming.email = profile.email;
    if (profile.picture) incoming.picture = profile.picture;
    else if (profile.avatar_url) incoming.picture = profile.avatar_url;
    if (profile.sub) incoming.providerId = profile.sub;
    else if (profile.id) incoming.providerId = String(profile.id);
    if (!incoming.email && tokens.provider === "github" && tokens.access_token) {
      try {
        const emailRes = await oauthFetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "CilamAI/1.0"
          }
        });
        const emails = await emailRes.json();
        if (Array.isArray(emails)) {
          const primary = emails.find((e) => e.primary) || emails[0];
          if (primary?.email) incoming.email = primary.email;
        }
      } catch (err) {
        console.warn("[Auth] Account data sync failed:", err?.message || err);
      }
    }
    const merged = { ...existing };
    for (const key of Object.keys(incoming)) {
      const value = incoming[key];
      if (value === undefined || value === null || value === "") continue;
      if (!merged[key]) merged[key] = value;
    }
    if (!merged.name && merged.email) merged.name = merged.email.split("@")[0];
    return applyAndSaveUser(merged);
  }
  function applyAndSaveUser(user) {
    let incoming = null;
    if (user && typeof user === "string") {
      incoming = parseUserString(user);
    } else if (user && typeof user === "object") {
      incoming = user;
    } else {
      return currentAuthUser;
    }
    // Merge over the existing stored profile so partial updates never reset saved data
    // and any extra profile fields are preserved (not just name/email/picture/provider).
    const existing = currentAuthUser || loadStoredAuthUser() || {};
    const merged = { ...existing };
    for (const key of Object.keys(incoming)) {
      if (incoming[key] === undefined) continue;
      merged[key] = incoming[key];
    }
    if (merged.provider === undefined) merged.provider = "google";
    currentAuthUser = merged;
    saveStoredAuthUser(currentAuthUser);
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send("auth:user", currentAuthUser);
    });
    return currentAuthUser;
  }
  ipcMain.handle("auth:get-user", async () => {
    if (!isSessionActive()) return null;
    if (!currentAuthUser) {
      currentAuthUser = loadStoredAuthUser();
    }
    // Re-add the account data from the provider API in the background. The
    // stored account itself is never removed.
    syncAccountProfileFromApi().catch(() => {});
    return currentAuthUser;
  });
  ipcMain.on("auth:get-user-sync", (event) => {
    if (!isSessionActive()) { event.returnValue = null; return; }
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
        refreshEnvFromFile(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "OAUTH_REDIRECT_URI"]);
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
          let candidateIndex = 0;
          let candidates = [];
          const candidateStates = new Map();
          let candidateTimer = null;
          const clearCandidateTimer = () => {
            if (candidateTimer) {
              clearTimeout(candidateTimer);
              candidateTimer = null;
            }
          };
          const timeoutId = setTimeout(() => {
            console.error("[OAuth] Timed out waiting for the browser callback");
            clearCandidateTimer();
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
            clearCandidateTimer();
            _resolve(value);
          };
          let oauthPort = 3e3;
          // Google refuses a redirect URI that is not registered exactly. When
          // that happens the browser only shows an "Error 400" page, so the
          // sign-up retries with the other loopback form on its own.
          const advanceCandidate = (reason) => {
            clearCandidateTimer();
            if (candidateIndex + 1 >= candidates.length) return false;
            candidateIndex += 1;
            redirectUri = candidates[candidateIndex];
            lastRedirectUri = redirectUri;
            console.warn(`[OAuth] ${reason}. Retrying sign-in with redirect_uri=${redirectUri}`);
            openAuthUrl();
            return true;
          };
          const openAuthUrl = () => {
            const state = crypto.randomBytes(16).toString("hex");
            candidateStates.set(state, redirectUri);
            // access_type=offline makes Google hand back a refresh token so the
            // account session can be renewed through the API instead of being
            // dropped and signed up again. The consent screen is only forced
            // while no refresh token is stored.
            const needsConsent = !getStoredTokens()?.refresh_token;
            const prompt = needsConsent ? "select_account%20consent" : "select_account";
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent("openid email profile")}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&access_type=offline&include_granted_scopes=true&state=${encodeURIComponent(state)}&prompt=${prompt}`;
            console.log(`[OAuth] Opening Google sign-in with redirect_uri=${redirectUri}`);
            shell.openExternal(authUrl);
            clearCandidateTimer();
            candidateTimer = setTimeout(() => {
              candidateTimer = null;
              advanceCandidate("No callback received for the current redirect URI");
            }, OAUTH_CANDIDATE_TIMEOUT_MS);
          };
          oauthHttpServer = http2.createServer(async (req, res) => {
            const urlObj = new URL(req.url, `http://127.0.0.1:${oauthPort}`);
            const code = urlObj.searchParams.get("code");
            const error = urlObj.searchParams.get("error");
            const state = urlObj.searchParams.get("state");
            // The code is bound to the redirect URI that produced it, so a
            // fallback attempt never invalidates the code that just arrived.
            const codeRedirectUri = (state && candidateStates.get(state)) || redirectUri;
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
              let retrying = false;
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
                    redirect_uri: codeRedirectUri
                  })
                });
                const tokenData = await tokenRes.json();
                console.log("[OAuth] Token data received:", tokenData.error || "SUCCESS");
                if (tokenData.error) {
                  console.error("[OAuth] Google token exchange failed:", tokenData.error, tokenData.error_description || "");
                  const rawError = `${tokenData.error} ${tokenData.error_description || ""}`;
                  if (/redirect_uri_mismatch|invalid_grant|incorrect_redirect_uri/i.test(rawError) && advanceCandidate("Google rejected the redirect URI")) {
                    // The callback server stays up: the retry reuses it.
                    retrying = true;
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Retrying sign-in...</h2><p style="color:#888;">A new tab was opened in your browser. You can close this one.</p></div></body></html>`);
                    return;
                  }
                  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                  res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Sign-In Failed</h2><p style="color:#888;">${tokenData.error}</p><p style="color:#888;">Close this tab and check CilamAI for details.</p></div></body></html>`);
                  try {
                    oauthHttpServer.close();
                  } catch {
                  }
                  oauthHttpServer = null;
                  resolve({ ok: false, error: describeOAuthRedirectError(tokenData.error_description || tokenData.error, codeRedirectUri) });
                  return;
                }
                let userName = "";
                let userEmail = "";
                let userPicture = null;
                let userProviderId = null;
                if (tokenData.id_token) {
                  try {
                    const base64Payload = tokenData.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
                    const payload = JSON.parse(Buffer.from(base64Payload, "base64").toString("utf8"));
                    userName = payload.name || (payload.given_name ? `${payload.given_name} ${payload.family_name || ""}`.trim() : "") || payload.preferred_username || "";
                    userEmail = payload.email || "";
                    userPicture = payload.picture || null;
                    userProviderId = payload.sub || null;
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
                      if (profile.sub) userProviderId = profile.sub;
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
                  provider: "google",
                  providerId: userProviderId
                };
                currentAuthUser = userObj;
                saveStoredAuthUser(userObj);
                signedIn = true;
                // Keep a refresh token that is already stored: Google only sends a
                // new one when the consent screen was shown, and dropping it would
                // end the session an hour later.
                const storedRefreshToken = getStoredTokens()?.refresh_token || null;
                saveStoredTokens({
                  provider: "google",
                  access_token: tokenData.access_token || null,
                  refresh_token: tokenData.refresh_token || storedRefreshToken,
                  scope: tokenData.scope || "",
                  id_token: tokenData.id_token || null,
                  expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null
                });
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
                if (!retrying) {
                  setTimeout(() => {
                    try {
                      oauthHttpServer?.close();
                    } catch {
                    }
                    oauthHttpServer = null;
                  }, 2e3);
                }
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
                candidates = callback.candidatesFor ? callback.candidatesFor(port) : [redirectUri];
                candidateIndex = 0;
                redirectUri = candidates[0] || redirectUri;
                lastRedirectUri = redirectUri;
                openAuthUrl();
              });
            };
            tryNextPort();
          };
          listenWithRetry();
        });
      } else if (provider === "github") {
        const http2 = await import("node:http");
        const crypto = await import("node:crypto");
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
        // An explicit callback URL is registered as-is in the GitHub OAuth app,
        // so the sign-up lands on the exact URI that was allowed.
        let pinnedRedirect = null;
        let pinnedPort = null;
        const configuredRedirect = (process.env.GITHUB_REDIRECT_URI || "").trim();
        if (configuredRedirect) {
          try {
            const url = new URL(configuredRedirect);
            if (/^https?:$/.test(url.protocol) && url.port) {
              pinnedRedirect = configuredRedirect;
              pinnedPort = Number(url.port);
            }
          } catch {
          }
        }
        return await new Promise((rawResolve) => {
          let settled = false;
          let oauthPort = 3e3;
          let redirectUri = null;
          let candidateIndex = 0;
          let candidates = [];
          const candidateStates = new Map();
          let candidateTimer = null;
          let lastRedirectUri = "";
          const clearCandidateTimer = () => {
            if (candidateTimer) {
              clearTimeout(candidateTimer);
              candidateTimer = null;
            }
          };
          // Every exit goes through this helper, so the pending timers are
          // always cleared and no extra browser tab is opened afterwards.
          const resolve = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            clearCandidateTimer();
            rawResolve(value);
          };
          const timeoutId = setTimeout(() => {
            console.error("[OAuth] Timed out waiting for the browser callback");
            try {
              oauthHttpServer?.close();
            } catch {
            }
            oauthHttpServer = null;
            resolve({
              ok: false,
              error: `Sign-in timed out. Register this exact redirect URI on the OAuth client: ${lastRedirectUri}`
            });
          }, OAUTH_TIMEOUT_MS);
          // GitHub compares the callback URL literally, so the other loopback
          // form is tried as well when the first one is not registered.
          const advanceCandidate = (reason) => {
            clearCandidateTimer();
            if (candidateIndex + 1 >= candidates.length) return false;
            candidateIndex += 1;
            redirectUri = candidates[candidateIndex];
            lastRedirectUri = redirectUri;
            console.warn(`[OAuth] ${reason}. Retrying sign-in with redirect_uri=${redirectUri}`);
            openAuthUrl();
            return true;
          };
          const openAuthUrl = () => {
            const state = crypto.randomBytes(16).toString("hex");
            candidateStates.set(state, redirectUri);
            const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("read:user user:email")}&state=${encodeURIComponent(state)}`;
            console.log(`[OAuth] Opening GitHub sign-in with redirect_uri=${redirectUri}`);
            shell.openExternal(authUrl);
            clearCandidateTimer();
            candidateTimer = setTimeout(() => {
              candidateTimer = null;
              advanceCandidate("No callback received for the current redirect URI");
            }, OAUTH_CANDIDATE_TIMEOUT_MS);
          };
          oauthHttpServer = http2.createServer(async (req, res) => {
            const urlObj = new URL(req.url, `http://127.0.0.1:${oauthPort}`);
            const code = urlObj.searchParams.get("code");
            const error = urlObj.searchParams.get("error");
            const state = urlObj.searchParams.get("state");
            // The code is bound to the redirect URI that produced it.
            const codeRedirectUri = (state && candidateStates.get(state)) || redirectUri;
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
              let retrying = false;
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
                    redirect_uri: codeRedirectUri
                  })
                });
                const tokenData = await tokenRes.json();
                console.log("[OAuth] GitHub token received:", tokenData.error || "SUCCESS");
                if (tokenData.error) {
                  console.error("[OAuth] GitHub token exchange failed:", tokenData.error, tokenData.error_description || "");
                  const rawError = `${tokenData.error} ${tokenData.error_description || ""}`;
                  if (/redirect_uri_mismatch|incorrect_redirect_uri/i.test(rawError) && advanceCandidate("GitHub rejected the redirect URI")) {
                    // The callback server stays up: the retry reuses it.
                    retrying = true;
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Retrying sign-in...</h2><p style="color:#888;">A new tab was opened in your browser. You can close this one.</p></div></body></html>`);
                    return;
                  }
                  resolve({ ok: false, error: describeOAuthRedirectError(tokenData.error_description || tokenData.error, codeRedirectUri) });
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
                  provider: "github",
                  providerId: profile.id ? String(profile.id) : null
                };
                currentAuthUser = userObj;
                saveStoredAuthUser(userObj);
                signedIn = true;
                saveStoredTokens({
                  provider: "github",
                  access_token: accessToken || null
                });
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
                if (!retrying) {
                  setTimeout(() => {
                    try {
                      oauthHttpServer?.close();
                    } catch {
                    }
                    oauthHttpServer = null;
                  }, 2e3);
                }
              }
              return;
            }
            res.writeHead(404);
            res.end();
          });
          const listenWithRetry = () => {
            const ports = pinnedPort ? [pinnedPort] : Array.from({ length: 11 }, (_, i) => 3011 + i);
            let portIndex = 0;
            const tryNextPort = () => {
              if (portIndex >= ports.length) {
                console.error("[OAuth] No free port found (3011-3021 all in use)");
                resolve({ ok: false, error: "No free port available for OAuth callback" });
                return;
              }
              const port = ports[portIndex++];
              oauthPort = port;
              redirectUri = pinnedRedirect || `http://127.0.0.1:${port}`;
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
                // Both loopback forms reach this server, so the sign-up can fall
                // back to the other form when only one of them is registered.
                candidates = [redirectUri];
                const alternate = `http://localhost:${port}`;
                if (alternate !== redirectUri) candidates.push(alternate);
                candidateIndex = 0;
                redirectUri = candidates[0];
                lastRedirectUri = redirectUri;
                openAuthUrl();
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
    const tokens = getStoredTokens();
    let revoked = false;
    try {
      if (tokens?.access_token && (tokens.provider === "google" || currentAuthUser?.provider === "google")) {
        const res = await oauthFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.access_token)}`, {
          method: "POST",
          headers: { "User-Agent": "CilamAI/1.0" }
        });
        revoked = Boolean(res && res.ok);
      }
    } catch (err) {
      console.warn("[OAuth] Token revocation failed (continuing local sign-out):", err && err.message ? err.message : err);
    }
    // Signing out starts a fresh usage cycle: reset this account's credits first.
    resetUsageForCurrentUser();
    currentAuthUser = null;
    currentAuthTokens = null;
    signedIn = false;
    saveStoredTokens(null);
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send("auth:user", null);
    });
    return { ok: true, revoked };
  });
  ipcMain.handle("auth:get-token", async () => {
    const tokens = await ensureFreshTokens();
    if (!tokens) return { ok: false };
    return {
      ok: true,
      provider: tokens.provider || null,
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      idToken: tokens.id_token || null,
      scope: tokens.scope || "",
      expiresAt: tokens.expires_at || null
    };
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
      titleBarStyle: "hidden",
      titleBarOverlay: false,
      roundedCorners: true,
      show: false,
      autoHideMenuBar: true,

      backgroundColor: windowBackgroundColor(),
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"),
        sandbox: false,
        devTools: !app.isPackaged
      }
    });
    applyRestoredWindowBounds(win, windowState);
    win.removeMenu();
    win.setMenuBarVisibility(false);
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const key = String(input.key || "").toLowerCase();
      const toggle =
        key === "f12" ||
        (input.control && input.shift && (key === "i" || key === "j"));
      if (toggle) {
        event.preventDefault();
        if (!app.isPackaged) win.webContents.toggleDevTools();
        return;
      }
      if (!app.isPackaged && input.control && key === "r") {
        event.preventDefault();
        if (input.shift) win.webContents.reloadIgnoringCache();
        else win.webContents.reload();
      }
    });
    setTimeout(() => {
      if (!win.isVisible()) {
        try { win.show(); } catch { }
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
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/signin.html`);
    } else {
      win.loadFile(join(__dirname, "../renderer/signin.html"));
      if (!app.isPackaged) {
        win.webContents.once("did-finish-load", () => {
          try {
            win.webContents.openDevTools({ mode: "detach" });
          } catch { }
        });
      }
    }
  }
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
        sandbox: false,
        devTools: !app.isPackaged
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
  ipcMain.handle("app:open-signin-window", () => {
    openSigninWindow();
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
      // Restore the previous session: the signed-in account and its profile stay
      // on disk, they must never be removed when the app starts.
      restoreStoredSession();
      app.setAppUserModelId("com.olinai.app");
      Menu.setApplicationMenu(null);
      app.setUserTasks([]);
      createWindow();
      // Re-add the account data from the provider API (background, non-blocking).
      setTimeout(() => {
        syncAccountProfileFromApi().catch(() => {});
      }, 1500);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.once("did-finish-load", () => {
          setTimeout(() => {
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
          }, 3200);
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
          if (initialUser && isSessionActive()) {
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
