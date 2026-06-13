'use strict';

// Thin wrapper around the global fetch() that adds: per-request timeouts,
// structured errors (with .status / .retryable / .retryAfterMs), and a
// combined abort signal so an in-flight request is cancelled when the whole
// migration is paused.

class HttpError extends Error {
  constructor(message, { status, body, headers, retryable, retryAfterMs, permanent } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
    if (retryable !== undefined) this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (permanent !== undefined) this.permanent = permanent;
  }
}

function parseRetryAfter(headers) {
  const v = headers && headers.get && headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// Combine an optional external AbortSignal with a per-request timeout.
function combinedSignal(externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(externalSignal ? externalSignal.reason : undefined);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  if (timeoutMs) {
    timer = setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    if (timer.unref) timer.unref();
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  };
  return { signal: ctrl.signal, cleanup };
}

/**
 * Perform a fetch with timeout + structured error handling.
 * @returns the Response object (caller decides how to read the body).
 *   opts.timeoutMs   default 120000 (long, because uploads stream through here)
 *   opts.signal      external AbortSignal
 *   opts.expectOk    when true (default), non-2xx throws HttpError
 */
async function request(url, opts = {}) {
  const { timeoutMs = 120000, signal, expectOk = true, ...init } = opts;
  const { signal: sig, cleanup } = combinedSignal(signal, timeoutMs);

  let res;
  try {
    res = await fetch(url, { ...init, signal: sig });
  } catch (err) {
    cleanup();
    // Distinguish a deliberate pause from a network failure.
    if (signal && signal.aborted) {
      err.aborted = true;
      throw err;
    }
    err.retryable = true; // fetch-level failures are transient
    throw err;
  }
  cleanup();

  if (expectOk && !res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfterMs = parseRetryAfter(res.headers);
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    throw new HttpError(`HTTP ${res.status} for ${shortUrl(url)}: ${truncate(text, 500)}`, {
      status: res.status,
      body: text,
      headers: res.headers,
      retryable,
      retryAfterMs,
      permanent: !retryable && res.status >= 400 && res.status < 500 && res.status !== 408,
    });
  }
  return res;
}

async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  if (!text) return { res, json: null };
  try {
    return { res, json: JSON.parse(text) };
  } catch {
    return { res, json: null, text };
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url);
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { request, requestJson, HttpError };
