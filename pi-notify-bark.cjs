#!/usr/bin/env node

/**
 * Local Bark companion for pi-notify `js:` actions.
 *
 * The secret stays in pi-notify-bark.secret as an HTTP(S) push URL whose final
 * path segment is the Bark device key. Retractable notifications are removed
 * when the next interactive user input is received.
 */

const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const SECRET_PATH = path.join(__dirname, "pi-notify-bark.secret");
const states = new WeakMap();

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseTarget(raw) {
  const value = raw.trim();
  if (!value) throw new Error("Bark secret is empty");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bark secret must be a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Bark secret URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Bark secret URL must not contain credentials, query, or fragment");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("Bark secret URL is missing the device key");

  const encodedKey = segments.pop();
  let deviceKey;
  try {
    deviceKey = decodeURIComponent(encodedKey);
  } catch {
    throw new Error("Bark secret URL contains an invalid device key");
  }
  if (!deviceKey || deviceKey === "push") {
    throw new Error("Bark secret URL is missing the device key");
  }

  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  const endpoint = new URL(`${prefix}/push`, url.origin).toString();
  return Object.freeze({ endpoint, deviceKey });
}

async function readTarget() {
  try {
    return parseTarget(await readFile(SECRET_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Bark secret file is missing: ${SECRET_PATH}`);
    }
    throw error;
  }
}

async function post(target, payload) {
  let response;
  try {
    response = await fetch(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ device_key: target.deviceKey, ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Bark request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) throw new Error(`Bark request failed: HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Bark request failed: invalid JSON response");
    }
    if (typeof result?.code === "number" && result.code !== 200) {
      throw new Error(`Bark request failed: code ${result.code}`);
    }
  } else {
    await response.body?.cancel();
  }
}

function enqueueWithdrawals(state, predicate = () => true) {
  const receipts = [...state.pending.values()].filter(predicate);
  if (receipts.length === 0) return;

  state.withdrawalQueue = state.withdrawalQueue.then(async () => {
    for (const receipt of receipts) {
      if (state.pending.get(receipt.id) !== receipt) continue;
      try {
        await post(receipt.target, { id: receipt.id, delete: "1" });
        if (state.pending.get(receipt.id) === receipt) state.pending.delete(receipt.id);
        const timer = state.withdrawalTimers.get(receipt.id);
        if (timer) clearTimeout(timer);
        state.withdrawalTimers.delete(receipt.id);
      } catch (error) {
        console.warn(`[pi-notify-bark] Withdrawal failed: ${errorMessage(error)}`);
      }
    }
  });
}

function scheduleWithdrawal(state, receipt) {
  const delayMs = Math.max(0, receipt.retractNotBefore - Date.now());
  if (delayMs === 0) {
    enqueueWithdrawals(state, (candidate) => candidate === receipt);
    return;
  }
  if (state.withdrawalTimers.has(receipt.id)) return;

  const timer = setTimeout(() => {
    state.withdrawalTimers.delete(receipt.id);
    enqueueWithdrawals(state, (candidate) => candidate === receipt);
  }, delayMs);
  timer.unref?.();
  state.withdrawalTimers.set(receipt.id, timer);
}

function stateFor(pi) {
  const existing = states.get(pi);
  if (existing) return existing;

  const state = {
    inputGeneration: 0,
    pending: new Map(),
    armedToolCalls: new Set(),
    completedToolCalls: new Set(),
    withdrawalTimers: new Map(),
    withdrawalQueue: Promise.resolve(),
    closed: false,
  };
  states.set(pi, state);

  pi.on("input", (event) => {
    if (event.source !== "interactive") return { action: "continue" };
    state.inputGeneration += 1;
    enqueueWithdrawals(state);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", (event) => {
    if (typeof event.toolCallId !== "string") return;
    if (state.armedToolCalls.has(event.toolCallId)) state.completedToolCalls.add(event.toolCallId);
    for (const receipt of state.pending.values()) {
      if (receipt.retractOnToolEnd === event.toolCallId) scheduleWithdrawal(state, receipt);
    }
  });

  pi.on("session_shutdown", () => {
    state.closed = true;
    state.inputGeneration += 1;
    states.delete(pi);
    for (const timer of state.withdrawalTimers.values()) clearTimeout(timer);
    state.withdrawalTimers.clear();
    enqueueWithdrawals(state);
  });

  return state;
}

async function notify(pi, _notification, title, body, options = {}) {
  if (!pi || typeof pi.on !== "function") throw new Error("Bark companion requires Pi ExtensionAPI");

  const state = stateFor(pi);
  if (state.closed) return;

  const retractable = options.retractable === true;
  const retractOnToolEnd =
    typeof options.retractOnToolEnd === "string" && options.retractOnToolEnd
      ? options.retractOnToolEnd
      : undefined;
  const retractDelayMs =
    Number.isFinite(options.retractDelayMs) && options.retractDelayMs >= 0
      ? options.retractDelayMs
      : 0;
  const generation = state.inputGeneration;
  const id = retractable ? randomUUID() : undefined;
  if (id && retractOnToolEnd) state.armedToolCalls.add(retractOnToolEnd);

  let target;
  try {
    target = await readTarget();
    const payload = {
      title: String(title ?? ""),
      body: String(body ?? ""),
      group: "pi-notify",
      ...(id ? { id } : {}),
    };
    await post(target, payload);
  } catch (error) {
    if (id && retractOnToolEnd) {
      state.armedToolCalls.delete(retractOnToolEnd);
      state.completedToolCalls.delete(retractOnToolEnd);
    }
    throw error;
  }

  if (!id) return;
  if (retractOnToolEnd) state.armedToolCalls.delete(retractOnToolEnd);
  const toolAlreadyEnded =
    !!retractOnToolEnd && state.completedToolCalls.delete(retractOnToolEnd);
  const receipt = Object.freeze({
    id,
    target,
    retractOnToolEnd,
    retractNotBefore: Date.now() + retractDelayMs,
  });
  state.pending.set(id, receipt);

  // Explicit interactive input and shutdown can retract immediately. A tool
  // completion uses its configured grace period so a fast answer cannot race
  // the original push off the device before it is displayed.
  if (state.closed || state.inputGeneration !== generation) {
    enqueueWithdrawals(state, (candidate) => candidate === receipt);
  } else if (toolAlreadyEnded) {
    scheduleWithdrawal(state, receipt);
  }
}

module.exports = Object.freeze({
  notify,
  __test: Object.freeze({ parseTarget }),
});
