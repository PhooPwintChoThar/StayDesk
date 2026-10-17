import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { setRole } from "./api.js";

const reply = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const stored = {
  reservationNo: "R-STORED",
  guestId: "guest-1",
  roomTypeId: "standard",
  checkIn: "2027-03-10",
  checkOut: "2027-03-13",
  totalAmount: 450,
  currency: "USD",
  status: "confirmed",
};

function makeToken(payload) {
  const encode = (value) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encode(payload)}.signature`;
}

function mockApi(routes) {
  fetch.mockImplementation(async (url, options = {}) => {
    const method = options.method || "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/login") {
      const body = JSON.parse(options.body);
      if (body.role) {
        return reply(200, { token: makeToken({ role: body.role, sub: body.role }) });
      }
      if (body.username === "agent" && body.password === "agent123") {
        return reply(200, { token: makeToken({ sub: "agent", role: "agent" }) });
      }
      if (body.username === "guest@example.com" && body.password === "secret123") {
        return reply(200, { token: makeToken({ sub: body.username, role: "guest", guestId: "guest-1" }) });
      }
      return reply(401, { error: "Unauthorized" });
    }
    if (path === "/auth/register") {
      return reply(201, { guestId: "guest-1", email: JSON.parse(options.body).email });
    }
    for (const [key, handler] of Object.entries(routes)) {
      const [routeMethod, prefix] = key.split(" ");
      if (routeMethod === method && path.startsWith(prefix))
        return handler(path, options);
    }
    return reply(404, { error: "NotFound" });
  });
}

const calls = (method, prefix) =>
  fetch.mock.calls.filter(
    ([url, options = {}]) =>
      (options.method || "GET") === method &&
      url.replace(/^https?:\/\/[^/]+/, "").startsWith(prefix),
  );

function roleFromAuthHeader(header) {
  const token = header?.replace(/^Bearer\s+/, "");
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role;
  } catch {
    return null;
  }
}

beforeEach(() => {
  setRole("agent");
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

describe("reservations management", () => {
  it("loads the booking register from the API instead of sample data", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [stored] }),
    });

    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });

    const table = screen.getByRole("table");
    expect(await within(table).findByText("R-STORED")).toBeInTheDocument();
    expect(within(table).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Tony Stark")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 entries")).toBeInTheDocument();
  });

  it("passes the status filter to the API", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [stored] }),
    });

    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });
    await userEvent.selectOptions(screen.getByLabelText("Status"), "cancelled");

    await waitFor(() =>
      expect(calls("GET", "/reservations?status=cancelled")).toHaveLength(1),
    );
  });

  it("opens New Reservation, books a room and shows the full confirmation number", async () => {
    let reservations = [];
    mockApi({
      "GET /reservations": () => reply(200, { reservations }),
      "GET /availability": () =>
        reply(200, {
          availability: [
            {
              roomTypeId: "standard",
              available: true,
              roomsAvailable: 1,
              nightlyRate: 100,
              currency: "USD",
            },
          ],
        }),
      "POST /reservations": () => {
        const created = {
          ...stored,
          reservationNo: "R-10001",
          checkOut: "2027-03-12",
          totalAmount: 200,
          depositAmount: 60,
        };
        reservations = [created];
        return reply(201, created);
      },
    });

    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });
    await userEvent.click(
      screen.getByRole("button", { name: "+ New Reservation" }),
    );
    await userEvent.type(screen.getByLabelText("Check-in"), "2027-03-10");
    await userEvent.type(screen.getByLabelText("Check-out"), "2027-03-12");
    await userEvent.click(
      screen.getByRole("button", { name: "Search availability" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Select" }),
    );

    await userEvent.type(screen.getByLabelText("Email"), "guest@example.com");
    await userEvent.type(screen.getByLabelText("First name"), "Test");
    await userEvent.type(screen.getByLabelText("Last name"), "Guest");
    await userEvent.click(screen.getByRole("button", { name: "Book room" }));

    const confirmation = await screen.findByRole("status");
    expect(within(confirmation).getByText("R-10001")).toBeInTheDocument();
    const requestBody = JSON.parse(calls("POST", "/reservations")[0][1].body);
    expect(requestBody).toMatchObject({
      roomTypeId: "standard",
      guest: {
        email: "guest@example.com",
        firstName: "Test",
        lastName: "Guest",
      },
    });
    expect(requestBody).not.toHaveProperty("depositAmount");
    expect(requestBody).not.toHaveProperty("currency");
    expect(confirmation).toHaveTextContent("Deposit: 60 USD");
    expect(
      await within(screen.getByRole("table")).findByText("R-10001"),
    ).toBeInTheDocument();
  });

  it("cancels a reservation from the actions menu", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [stored] }),
      "DELETE /reservations/R-STORED": () => reply(204),
    });

    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for R-STORED" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));

    await waitFor(() =>
      expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1),
    );
    expect(confirm).toHaveBeenCalled();
  });

  it("modifies a reservation from the actions menu", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [stored] }),
      "PUT /reservations/R-STORED": () =>
        reply(200, { ...stored, checkOut: "2027-03-14" }),
    });

    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for R-STORED" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Modify" }));

    const checkOut = screen.getByLabelText("New check-out");
    await userEvent.clear(checkOut);
    await userEvent.type(checkOut, "2027-03-14");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(calls("PUT", "/reservations/R-STORED")).toHaveLength(1),
    );
    expect(
      JSON.parse(calls("PUT", "/reservations/R-STORED")[0][1].body),
    ).toEqual({
      roomTypeId: "standard",
      checkIn: "2027-03-10",
      checkOut: "2027-03-14",
    });
  });
});

describe("role switcher and guests page", () => {
  it("logs in with the selected role and shows the guest restriction", async () => {
    mockApi({
      "GET /reservations": (_path, options) =>
        roleFromAuthHeader(options.headers.Authorization) === "guest"
          ? reply(403, { error: "Forbidden" })
          : reply(200, { reservations: [stored] }),
    });

    render(<App />);
    await screen.findByText("R-STORED");
    await userEvent.selectOptions(
      screen.getByLabelText("Signed in as"),
      "guest",
    );

    expect(await screen.findByLabelText("Confirmation number")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("R-STORED")).not.toBeInTheDocument(),
    );
    const logins = calls("POST", "/login").map(
      ([, options]) => JSON.parse(options.body).role,
    );
    expect(logins).toEqual(["agent", "guest"]);
  });

  it("searches guests and shows their stay history", async () => {
    mockApi({
      "GET /reservations?guestId=guest-1": () =>
        reply(200, { reservations: [stored] }),
      "GET /reservations": () => reply(200, { reservations: [] }),
      "GET /guests/search": () =>
        reply(200, {
          guests: [
            {
              id: "guest-1",
              firstName: "Test",
              lastName: "Guest",
              email: "guest@example.com",
              phone: null,
            },
          ],
        }),
    });

    render(<App />);
  await screen.findByRole("button", { name: /Guests$/ });
    await userEvent.click(screen.getByRole("button", { name: /Guests$/ }));
    await userEvent.type(
      screen.getByLabelText("Name, email, phone or loyalty number"),
      "test",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Search guests" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "View stays" }),
    );

    const history = await screen.findByRole("list", { name: "Stay history" });
    expect(within(history).getByText(/R-STORED/)).toBeInTheDocument();
    expect(calls("GET", "/guests/search?q=test")).toHaveLength(1);
  });
});

describe("authentication screen", () => {
  beforeEach(() => {
    setRole(null);
  });

  it("lets a user sign in with credentials", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [] }),
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText("Username or email"), "agent");
    await userEvent.type(screen.getByLabelText("Password"), "agent123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
  });

  it("shows an error when login fails", async () => {
    mockApi({});

    render(<App />);
    await userEvent.type(screen.getByLabelText("Username or email"), "agent");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unauthorized");
  });

  it("logs out back to the sign-in screen", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [] }),
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText("Username or email"), "agent");
    await userEvent.type(screen.getByLabelText("Password"), "agent123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button", { name: "Logout" });

    await userEvent.click(screen.getByRole("button", { name: "Logout" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("returns to login when an authenticated request gets 401", async () => {
    mockApi({
      "GET /reservations": () => reply(401, { error: "Unauthorized" }),
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText("Username or email"), "agent");
    await userEvent.type(screen.getByLabelText("Password"), "agent123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("creates and signs in a guest account", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [] }),
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText("First name"), "Guest");
    await userEvent.type(screen.getByLabelText("Last name"), "User");
    await userEvent.type(screen.getByLabelText("Email"), "guest@example.com");
    await userEvent.type(screen.getByLabelText("Guest password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: "Create guest account" }));

    expect(await screen.findByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.getByText("Guest", { selector: ".role-chip" })).toBeInTheDocument();
  });
});
