import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { setRole } from "./api.js";
import { mockApi, reply } from "./test-helpers.js";

const REMOVED = ["Dashboard", "Rooms", "Housekeeping", "Billing", "Reports", "Settings"];

const navNames = () =>
  Array.from(
    screen.getByRole("navigation", { name: "Sidebar navigation" }).querySelectorAll("button"),
  ).map((button) => button.textContent.trim());

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("confirm", vi.fn(() => true));
  mockApi({ "GET /reservations": () => reply(200, { reservations: [] }) });
});

describe("sidebar per role", () => {
  it.each(["agent", "manager"])("shows Reservations, Guests and Payments for %s", async (role) => {
    setRole(role);
    render(<App />);
    await screen.findByRole("button", { name: /Guests$/ });

    expect(navNames()).toEqual(["Reservations", "Guests", "Payments"]);
    expect(screen.queryByRole("button", { name: "My profile" })).not.toBeInTheDocument();
    for (const name of REMOVED) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }
  });

  it("shows Reservations, Payments and My profile for a guest, and no Guests", async () => {
    setRole("guest");
    render(<App />);
    await screen.findByRole("button", { name: "My profile" });

    expect(navNames()).toEqual(["Reservations", "Payments", "My profile"]);
    expect(screen.queryByRole("button", { name: /Guests$/ })).not.toBeInTheDocument();
    expect(screen.getByText("Book a room / My bookings")).toBeInTheDocument();
    expect(screen.queryByText("Find a guest")).not.toBeInTheDocument();
  });
});

describe("view guard", () => {
  it("falls back to reservations when the role changes to one that cannot open the current view", async () => {
    setRole("guest");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "My profile" }));
    expect(await screen.findByRole("heading", { name: "My profile" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Signed in as"), "agent");

    expect(await screen.findByText("Reservations Management")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "My profile" })).not.toBeInTheDocument();
  });

  it("never renders the Guests view for a guest after a role change from the Guests view", async () => {
    setRole("agent");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Guests$/ }));
    expect(await screen.findByText("Find a guest")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Signed in as"), "guest");

    await waitFor(() => expect(screen.queryByText("Find a guest")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Guests$/ })).not.toBeInTheDocument();
    expect(await screen.findByText("Book a room / My bookings")).toBeInTheDocument();
  });

  it("returns to reservations after logout and a different login", async () => {
    setRole("agent");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Payments" }));
    expect(await screen.findByRole("heading", { name: "Payment proof review" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Logout" }));

    await userEvent.type(await screen.findByLabelText("Username or email"), "guest@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Book a room / My bookings")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payment proof review" })).not.toBeInTheDocument();
  });
});

describe("403 handling", () => {
  it("shows a friendly message instead of the raw server error", async () => {
    mockApi({
      "GET /reservations": () => reply(403, { error: "Forbidden", message: "raw gateway text" }),
    });
    setRole("agent");
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not have permission to do that.",
    );
    expect(screen.queryByText(/raw gateway text/)).not.toBeInTheDocument();
  });
});
