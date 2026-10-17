import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  FORBIDDEN_MESSAGE,
  apiBlob,
  apiRequest,
  getSession,
  login,
} from "./api.js";

const encode = (value) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const TOKEN = `header.${encode({ sub: "agent", role: "agent" })}.signature`;

const reply = (status, body, extra = {}) => ({
  ok: status < 400,
  status,
  json: async () => body,
  ...extra,
});

const headerOf = (headers, name) =>
  Object.entries(headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

async function signIn() {
  fetch.mockResolvedValueOnce(reply(200, { token: TOKEN }));
  await login("agent", "agent123");
  fetch.mockClear();
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("apiRequest", () => {
  it("sends FormData without a JSON content-type", async () => {
    await signIn();
    fetch.mockResolvedValueOnce(reply(201, { id: "p1" }));
    const form = new FormData();
    form.append("reservationNo", "R-1");

    await apiRequest("/payments/proofs", { method: "POST", body: form });

    const [, options] = fetch.mock.calls[0];
    expect(options.body).toBe(form);
    expect(headerOf(options.headers, "Content-Type")).toBeUndefined();
    expect(headerOf(options.headers, "Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("still sends JSON bodies as application/json", async () => {
    await signIn();
    fetch.mockResolvedValueOnce(reply(200, {}));

    await apiRequest("/reservations/R-1", {
      method: "DELETE",
      body: JSON.stringify({ waiveFee: true }),
    });

    const [, options] = fetch.mock.calls[0];
    expect(headerOf(options.headers, "Content-Type")).toBe("application/json");
  });

  it("returns null for 204 and turns 403 into a friendly message", async () => {
    await signIn();
    fetch.mockResolvedValueOnce(reply(204));
    expect(await apiRequest("/x", { method: "DELETE" })).toBeNull();

    fetch.mockResolvedValueOnce(reply(403, { error: "Forbidden", message: "raw server text" }));
    await expect(apiRequest("/x")).rejects.toMatchObject({
      message: FORBIDDEN_MESSAGE,
      status: 403,
    });
  });

  it("clears the session on 401", async () => {
    await signIn();
    expect(getSession()).not.toBeNull();
    fetch.mockResolvedValueOnce(reply(401, { error: "Unauthorized" }));
    await expect(apiRequest("/x")).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
  });
});

describe("apiBlob", () => {
  it("sends the Authorization header and returns the blob", async () => {
    await signIn();
    const blob = new Blob(["pdf-bytes"], { type: "application/pdf" });
    fetch.mockResolvedValueOnce(reply(200, null, { blob: async () => blob }));

    const result = await apiBlob("/payments/proofs/p1/file");

    const [url, options] = fetch.mock.calls[0];
    expect(url).toMatch(/\/payments\/proofs\/p1\/file$/);
    expect(url).not.toContain(TOKEN);
    expect(options.method).toBe("GET");
    expect(headerOf(options.headers, "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result).toBe(blob);
  });

  it("clears the session on 401 and throws the server message on errors", async () => {
    await signIn();
    fetch.mockResolvedValueOnce(reply(401, { error: "Unauthorized" }));
    await expect(apiBlob("/payments/proofs/p1/file")).rejects.toThrow("Unauthorized");
    expect(getSession()).toBeNull();

    await signIn();
    fetch.mockResolvedValueOnce(reply(404, { message: "Payment proof not found." }));
    await expect(apiBlob("/payments/proofs/nope/file")).rejects.toThrow(
      "Payment proof not found.",
    );
  });
});
