// Decorator: each wrapper adds one cross-cutting concern to an HTTP client
// (security, timeouts, retries) without changing its get/post/delete interface,
// so the concerns can be combined freely and tested on their own (NFR-3, NFR-5).
import axios from "axios";

const withConfig = (client, extend) => ({
  get: (url, config) => client.get(url, extend(config)),
  post: (url, data, config) => client.post(url, data, extend(config)),
  delete: (url, config) => client.delete(url, extend(config)),
});

// Every service-to-service call proves it comes from inside the system.
export function withInternalToken(client, token = () => process.env.INTERNAL_TOKEN) {
  return withConfig(client, (config = {}) =>
    token() ? { ...config, headers: { ...config.headers, "x-internal-token": token() } } : config,
  );
}

// A slow or hung service fails fast instead of freezing the booking saga.
export function withTimeout(client, timeoutMs) {
  return withConfig(client, (config = {}) => ({ ...config, timeout: config.timeout ?? timeoutMs }));
}

const transient = (error) => !error.response || error.response.status >= 500;

// Reads are idempotent, so a brief network or server hiccup is retried.
// Writes are never retried here: the saga decides how to compensate them.
export function withRetry(client, { retries = 2, delayMs = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return {
    ...client,
    async get(url, config) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await client.get(url, config);
        } catch (error) {
          if (attempt >= retries || !transient(error)) throw error;
          await sleep(delayMs * (attempt + 1));
        }
      }
    },
  };
}

export function createServiceHttp(base = axios, { timeoutMs = Number(process.env.SERVICE_TIMEOUT_MS || 5000) } = {}) {
  return withRetry(withTimeout(withInternalToken(base), timeoutMs));
}
