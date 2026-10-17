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
      if (body.username === "reception" && body.password === "reception123") {
        return reply(200, { token: makeToken({ sub: "reception", role: "agent" }) });
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
    if (path === "/room-types") {
      return reply(200, {
        roomTypes: [
          { id: "standard", name: "Standard" },
          { id: "suite", name: "Suite" },
        ],
      });
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
    expect(screen.queryByText("Look up a reservation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find reservation" })).not.toBeInTheDocument();
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
      await screen.findByRole("button", { name: /^Select/ }),
    );

    await userEvent.type(screen.getByLabelText("Email"), "guest@example.com");
    await userEvent.type(screen.getByLabelText("First name"), "Test");
    await userEvent.type(screen.getByLabelText("Last name"), "Guest");
    await userEvent.type(screen.getByLabelText("Passport or ID number"), "P1234567");
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
  it("logs in with the selected role and lets guests view their bookings", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [stored] }),
    });

    render(<App />);
    await screen.findByText("R-STORED");
    await userEvent.selectOptions(
      screen.getByLabelText("Signed in as"),
      "guest",
    );

    expect(await screen.findByText("My bookings")).toBeInTheDocument();
    expect(await screen.findByText("R-STORED")).toBeInTheDocument();
    expect(screen.queryByText("Look up a reservation")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const logins = calls("POST", "/login").map(
      ([, options]) => JSON.parse(options.body).role,
    );
    expect(logins).toEqual(["agent", "guest"]);
  });

  it("lists every guest with booking counts, their bookings, and booking details", async () => {
    mockApi({
      "GET /reservations?guestId=guest-1": () => reply(200, { reservations: [stored] }),
      "GET /reservations?": () => reply(200, { reservations: [] }),
      "GET /reservations/guest-counts": () =>
        reply(200, { counts: [{ guestId: "guest-1", total: 1, active: 1, completed: 0, cancelled: 0 }] }),
      "GET /reservations/R-STORED": () => reply(200, { ...stored, additionalGuests: [] }),
      "GET /guests": () =>
        reply(200, {
          guests: [
            { id: "guest-1", firstName: "Test", lastName: "Guest", email: "guest@example.com", phone: "0812345678", idDocument: "****4567", hasAccount: true, createdAt: "2026-10-01T00:00:00Z" },
            { id: "guest-2", firstName: "Walk", lastName: "In", email: "walkin@example.com", phone: null, hasAccount: false, createdAt: "2026-10-02T00:00:00Z" },
          ],
        }),
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Guests$/ }));

    const directory = await screen.findByRole("table", { name: "Guest results" });
    expect(within(directory).getByText("guest@example.com")).toBeInTheDocument();
    expect(within(directory).getByText("walkin@example.com")).toBeInTheDocument();
    expect(within(directory).getByText("****4567")).toBeInTheDocument();
    expect(within(directory).getByText("Online account")).toBeInTheDocument();
    expect(within(directory).getByRole("button", { name: "0 bookings for Walk In" })).toBeInTheDocument();

    await userEvent.click(within(directory).getByRole("button", { name: "1 bookings for Test Guest" }));
    const bookings = await screen.findByRole("table", { name: "Guest bookings" });
    expect(await within(bookings).findByText("R-STORED")).toBeInTheDocument();
    expect(within(bookings).getByText("2027-03-10 → 2027-03-13")).toBeInTheDocument();

    await userEvent.click(within(bookings).getByRole("row", { name: "Open booking R-STORED" }));
    expect(await screen.findByRole("dialog", { name: "Booking R-STORED" })).toBeInTheDocument();
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

  it("lets reception sign in with the demo credentials", async () => {
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [] }),
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText("Username or email"), "reception");
    await userEvent.type(screen.getByLabelText("Password"), "reception123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.getByText("reception")).toBeInTheDocument();
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
    expect(screen.getByLabelText("Username or email")).toBeInTheDocument();
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(screen.queryByLabelText("Username or email")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("First name"), "Guest");
    await userEvent.type(screen.getByLabelText("Last name"), "User");
    await userEvent.type(screen.getByLabelText("Email"), "guest@example.com");
    await userEvent.type(screen.getByLabelText("Guest password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: "Create guest account" }));

    expect(await screen.findByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.getByText("Guest", { selector: ".role-chip" })).toBeInTheDocument();
  });

  it("switches from sign up back to sign in only when its button is clicked", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(screen.getByLabelText("First name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create guest account" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByLabelText("Username or email")).toBeInTheDocument();
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
  });
});

describe("front desk stay handling", () => {
  it("checks a paid booking in and out and then shows Succeeded", async () => {
    let current = { ...stored, checkIn: "2020-01-01", checkOut: "2099-01-01", checkedInAt: null, checkedOutAt: null };
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [current] }),
      "POST /reservations/R-STORED/check-in": () => {
        current = { ...current, checkedInAt: "2026-10-17T14:05:00Z" };
        return reply(200, current);
      },
      "POST /reservations/R-STORED/check-out": () => {
        current = { ...current, checkedOutAt: "2026-10-19T10:30:00Z" };
        return reply(200, current);
      },
    });
    render(<App />);

    const table = await screen.findByRole("table");
    await userEvent.click(await within(table).findByRole("button", { name: "Check in" }));
    await userEvent.click(await within(table).findByRole("button", { name: "Check out" }));

    expect(await within(table).findByText("Succeeded")).toBeInTheDocument();
    expect(calls("POST", "/reservations/R-STORED/check-in")).toHaveLength(1);
    expect(calls("POST", "/reservations/R-STORED/check-out")).toHaveLength(1);
    expect(within(table).queryByRole("button", { name: /Check (in|out)/ })).not.toBeInTheDocument();
  });

  it("does not allow check-in until the payment is approved", async () => {
    mockApi({
      "GET /reservations": () =>
        reply(200, { reservations: [{ ...stored, status: "pending", checkIn: "2020-01-01", checkOut: "2099-01-01" }] }),
    });
    render(<App />);

    const table = await screen.findByRole("table");
    expect(await within(table).findByRole("button", { name: "Check in" })).toBeDisabled();
  });
});
