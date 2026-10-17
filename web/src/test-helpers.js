import { createElement, Fragment } from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import Toaster from "./Toaster.jsx";

export const reply = (status, body, extra = {}) => ({
  ok: status < 400,
  status,
  json: async () => body,
  ...extra,
});

export function makeToken(payload) {
  const encode = (value) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encode(payload)}.signature`;
}

export const GUEST_ID = "guest-1";

const claimsFor = (role) =>
  role === "guest"
    ? { role, sub: "guest@example.com", guestId: GUEST_ID }
    : { role, sub: role };

// Routes look like "GET /reservations/R-1/payment-summary". The longest
// matching prefix for the method wins, so specific routes beat generic ones.
export function mockApi(routes) {
  fetch.mockImplementation(async (url, options = {}) => {
    const method = options.method || "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/login") {
      const body = JSON.parse(options.body);
      const role =
        body.role ||
        (body.username === "reception" && body.password === "reception123" ? "agent" : null) ||
        (body.username === "agent" && body.password === "agent123" ? "agent" : null) ||
        (body.username === "guest@example.com" && body.password === "secret123" ? "guest" : null);
      if (!role) return reply(401, { error: "Unauthorized" });
      return reply(200, { token: makeToken(claimsFor(role)) });
    }
    if (path === "/room-types") {
      return reply(200, {
        roomTypes: [
          { id: "standard", name: "Standard" },
          { id: "suite", name: "Suite" },
        ],
      });
    }
    let best = null;
    for (const [key, handler] of Object.entries(routes)) {
      const [routeMethod, prefix] = key.split(" ");
      if (routeMethod === method && path.startsWith(prefix)) {
        if (!best || prefix.length > best.prefix.length) best = { prefix, handler };
      }
    }
    return best ? best.handler(path, options) : reply(404, { error: "NotFound" });
  });
}

export const calls = (method, prefix) =>
  fetch.mock.calls.filter(
    ([url, options = {}]) =>
      (options.method || "GET") === method &&
      url.replace(/^https?:\/\/[^/]+/, "").startsWith(prefix),
  );

export const headerOf = (headers, name) =>
  Object.entries(headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

export function stubConfirm(...answers) {
  const confirm = vi.fn();
  answers.forEach((answer) => confirm.mockReturnValueOnce(answer));
  confirm.mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  return confirm;
}

// Screens tested on their own need the app's pop-up area to show notifications.
export const renderWithToaster = (ui) => render(createElement(Fragment, null, ui, createElement(Toaster)));
