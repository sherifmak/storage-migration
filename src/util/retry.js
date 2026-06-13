'use strict';

// Network resilience helpers. Large migrations run for hours or days across
// flaky connections, sleeping laptops and rate limits, so almost every remote
// call goes through `withRetry`.

class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
    this.aborted = true;
  }
}

// Sleep that rejects promptly if the shared abort signal fires.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Decide whether an error is worth retrying. Network errors and 5xx/429 are
// transient; most 4xx are permanent (and shouldn't burn retries).
function isRetryable(err) {
  if (!err) return false;
  if (err.aborted) return false;
  if (err.permanent) return false;
  if (err.retryable === true) return true;
  // fetch() network failures, DNS, resets, timeouts.
  const code = err.code || (err.cause && err.cause.code);
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
    return true;
  }
  if (err.name === 'AbortError') return false;
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  const status = err.status;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Run `fn` with exponential backoff + jitter.
 * @param {Function} fn  async function; receives the attempt number (1-based)
 * @param {object} opts
 *   retries     max attempts (default 8)
 *   minDelay    base delay ms (default 1000)
 *   maxDelay    cap ms (default 60000)
 *   signal      AbortSignal to cancel waits
 *   onRetry     (err, attempt, delayMs) => void
 *   shouldRetry (err) => bool override
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 8,
    minDelay = 1000,
    maxDelay = 60000,
    signal,
    onRetry,
    shouldRetry = isRetryable,
  } = opts;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal && signal.aborted) throw new AbortError();
      if (attempt > retries || !shouldRetry(err)) throw err;

      // Honour Retry-After when the server provides it (seconds or HTTP date).
      let delay;
      if (err.retryAfterMs != null) {
        delay = err.retryAfterMs;
      } else {
        const base = Math.min(maxDelay, minDelay * Math.pow(2, attempt - 1));
        delay = Math.floor(base / 2 + Math.random() * (base / 2));
      }
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay, signal);
    }
  }
}

module.exports = { withRetry, isRetryable, sleep, AbortError };
