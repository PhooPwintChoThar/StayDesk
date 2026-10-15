const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3010"
).replace(/\/$/, "");

let role = "agent";
let tokenPromise;

export function setRole(nextRole) {
  role = nextRole;
  tokenPromise = undefined;
}

function getToken() {
  tokenPromise ??= fetch(`${API_BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Login failed");
      return data.token;
    })
    .catch((err) => {
      tokenPromise = undefined;
      throw err;
    });
  return tokenPromise;
}

export async function apiRequest(path, options = {}) {
  const token = import.meta.env.VITE_API_TOKEN || (await getToken());
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data.message || data.error || `Request failed (${response.status})`,
    );
  }
  return data;
}
