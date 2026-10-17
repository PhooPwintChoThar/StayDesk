const API_BASE_URL = (
    import.meta.env.VITE_API_BASE_URL || "http://localhost:3010"
).replace(/\/$/, "");

const DEV_ROLE_SWITCH = import.meta.env.VITE_DEV_ROLE_SWITCH === "true";

let session = null;
let devRole = null;
let tokenPromise;
const listeners = new Set();

function decodeToken(token) {
  const payload = token.split(".")[1];
  if (!payload) return {};
  const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function notifySessionChange() {
  for (const listener of listeners) listener(session);
}

function setSession(nextSession) {
  session = nextSession;
  notifySessionChange();
}

function clearSession({ clearDevRole = false } = {}) {
  session = null;
  tokenPromise = undefined;
  if (clearDevRole || !DEV_ROLE_SWITCH) devRole = null;
  notifySessionChange();
}

export function setRole(nextRole) {
  devRole = nextRole || null;
  tokenPromise = undefined;
}

export function getDevRole() {
  return devRole;
}

export function getSession() {
  return session;
}

export function subscribeSession(listener) {
  listeners.add(listener);
  listener(session);
  return () => listeners.delete(listener);
}

export function logout() {
  devRole = null;
  clearSession({ clearDevRole: true });
}

async function requestLogin(body) {
  const response = await fetch(`${API_BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Login failed");

  const claims = decodeToken(data.token);
  setSession({ token: data.token, claims });
  return session;
}

export async function login(username, password) {
  devRole = null;
  return requestLogin({ username, password });
}

export async function loginWithRole(role) {
  if (!DEV_ROLE_SWITCH) {
    throw new Error("Dev role switch is disabled.");
  }
  devRole = role;
  return requestLogin({ role });
}

export async function registerGuestAccount(details) {
  const response = await fetch(`${API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || "Registration failed");
  }
  await login(details.email, details.password);
  return data;
}

async function getToken() {
  if (session?.token) return session.token;
  if (!DEV_ROLE_SWITCH || !devRole) {
    throw new Error("Unauthorized");
  }

  tokenPromise ??= loginWithRole(devRole)
      .then(() => session?.token)
      .catch((err) => {
        tokenPromise = undefined;
        throw err;
      });
  return tokenPromise;
}

export const FORBIDDEN_MESSAGE = "You do not have permission to do that.";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function errorMessage(response, data) {
  if (response.status === 403) return FORBIDDEN_MESSAGE;
  return data?.message || data?.error || `Request failed (${response.status})`;
}

function isFormData(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

export async function apiRequest(path, options = {}) {
  const token = import.meta.env.VITE_API_TOKEN || (await getToken());
  const formBody = isFormData(options.body);
  const headers = {
    ...(options.body &&
    !formBody &&
    !options.headers?.["Content-Type"] &&
    !options.headers?.["content-type"]
        ? { "Content-Type": "application/json" }
        : {}),
    Authorization: `Bearer ${token}`,
    ...options.headers,
  };
  if (formBody) {
    // Let the browser set "multipart/form-data; boundary=..." itself.
    delete headers["Content-Type"];
    delete headers["content-type"];
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearSession({ clearDevRole: true });
  }
  if (!response.ok) {
    throw new ApiError(errorMessage(response, data), response.status);
  }
  return data;
}

// Authenticated GET that returns a Blob (for proof files). The token is sent
// in the Authorization header only, never in the URL.
export async function apiBlob(path) {
  const token = import.meta.env.VITE_API_TOKEN || (await getToken());
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    clearSession({ clearDevRole: true });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(errorMessage(response, data), response.status);
  }
  return response.blob();
}