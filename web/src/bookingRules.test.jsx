import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { setRole } from "./api.js";
import { calls, mockApi, reply, stubConfirm } from "./test-helpers.js";

const booking = {
  reservationNo: "R-RULES",
  guestId: "11111111-2222-3333-4444-555555555555",
  roomTypeId: "standard",
  roomNumber: "102",
  checkIn: "2099-03-10",
  checkOut: "2099-03-13",
  totalAmount: 450,
  depositAmount: 135,
  depositHeld: 135,
  currency: "USD",
  status: "confirmed",
  guests: 2,
  createdAt: "2099-01-01T10:00:00Z",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  stubConfirm(true);
});

describe("booking for several guests", () => {
  it("asks for the name and passport of every guest and sends them", async () => {
    setRole("guest");
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [] }),
      "GET /availability": () =>
        reply(200, { availability: [{ roomTypeId: "suite", name: "Suite", available: true, roomsAvailable: 2, nightlyRate: 200, currency: "USD", maxOccupancy: 4, photos: [] }] }),
      "POST /reservations": () => reply(201, { ...booking, reservationNo: "R-NEW", status: "pending" }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "+ New Reservation" }));
    await userEvent.type(screen.getByLabelText("Check-in"), "2099-04-01");
    await userEvent.type(screen.getByLabelText("Check-out"), "2099-04-03");
    await userEvent.clear(screen.getByLabelText("Guests"));
    await userEvent.type(screen.getByLabelText("Guests"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Search availability" }));
    await userEvent.click(await screen.findByRole("button", { name: "Select Suite" }));

    expect(screen.getByLabelText("Passport or ID number")).toBeRequired();
    expect(screen.getByLabelText("Guest 3 passport or ID number")).toBeRequired();
    await userEvent.type(screen.getByLabelText("First name"), "Ada");
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace");
    await userEvent.type(screen.getByLabelText("Passport or ID number"), "P1");
    await userEvent.type(screen.getByLabelText("Guest 2 full name"), "Grace Hopper");
    await userEvent.type(screen.getByLabelText("Guest 2 passport or ID number"), "P2");
    await userEvent.type(screen.getByLabelText("Guest 3 full name"), "Alan Turing");
    await userEvent.type(screen.getByLabelText("Guest 3 passport or ID number"), "P3");
    await userEvent.click(screen.getByRole("button", { name: "Book room" }));

    await waitFor(() => expect(calls("POST", "/reservations")).toHaveLength(1));
    const body = JSON.parse(calls("POST", "/reservations")[0][1].body);
    expect(body.guests).toBe(3);
    expect(body.guest.idDocument).toBe("P1");
    expect(body.additionalGuests).toEqual([
      { name: "Grace Hopper", idDocument: "P2" },
      { name: "Alan Turing", idDocument: "P3" },
    ]);
    expect(await screen.findByText("Booking received")).toBeInTheDocument();
  });
});

describe("who may modify", () => {
  it("does not let a guest modify a confirmed booking", async () => {
    setRole("guest");
    mockApi({ "GET /reservations": () => reply(200, { reservations: [booking] }) });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Actions for R-RULES" }));

    expect(screen.getByRole("menuitem", { name: "Modify" })).toBeDisabled();
  });

  it("lets the front desk change only the dates", async () => {
    setRole("agent");
    mockApi({
      "GET /reservations": () => reply(200, { reservations: [booking] }),
      "PUT /reservations/R-RULES": () => reply(200, booking),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Actions for R-RULES" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Modify" }));

    expect(screen.getByRole("heading", { name: "Change dates for R-RULES" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Room type", { selector: "select" })).not.toBeInTheDocument();
    const checkOut = screen.getByLabelText("New check-out");
    await userEvent.clear(checkOut);
    await userEvent.type(checkOut, "2099-03-15");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls("PUT", "/reservations/R-RULES")).toHaveLength(1));
    expect(JSON.parse(calls("PUT", "/reservations/R-RULES")[0][1].body)).toEqual({
      roomTypeId: "standard", checkIn: "2099-03-10", checkOut: "2099-03-15",
    });
  });
});

describe("booking details for staff", () => {
  it("shows guests, dates, money and every payment when the booking id is clicked", async () => {
    setRole("manager");
    mockApi({
      "GET /reservations?": () => reply(200, { reservations: [booking] }),
      "GET /reservations/R-RULES": () =>
        reply(200, { ...booking, additionalGuests: [{ position: 2, name: "Grace Hopper", idDocument: "P2" }] }),
      "GET /reservations/R-RULES/payment-summary": () =>
        reply(200, { totalAmount: 450, depositHeld: 135, approvedProofsTotal: 315, settledAtDesk: 0, balanceDue: 0, currency: "USD" }),
      "GET /guests/": () =>
        reply(200, { id: booking.guestId, firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", idDocument: "P1" }),
      "GET /guests?ids": () => reply(200, { guests: [] }),
      "GET /payments/proofs": () =>
        reply(200, { proofs: [{ id: "p1", paymentNo: "PMT-000007", reservationNo: "R-RULES", amount: 315, currency: "USD", status: "approved", reviewedBy: "reception", reviewedByRole: "agent", reviewedAt: "2099-01-02T09:00:00Z", fileName: "slip.png", fileType: "image/png" }] }),
      "GET /payments/transactions": () =>
        reply(200, { transactions: [{ id: "t1", paymentNo: "TXN-000003", type: "deposit", amount: 135, currency: "USD", status: "authorized", createdAt: "2099-01-01T10:00:00Z" }] }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "R-RULES" }));

    const dialog = await screen.findByRole("dialog", { name: "Booking R-RULES" });
    expect(await within(dialog).findByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(dialog).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(dialog).getByText("2099-03-10 to 2099-03-13 (3 nights)")).toBeInTheDocument();
    expect(within(dialog).getByText("450.00 USD")).toBeInTheDocument();
    expect(within(dialog).getByText("PMT-000007")).toBeInTheDocument();
    expect(within(dialog).getByText("reception (Front desk)")).toBeInTheDocument();
    expect(within(dialog).getByText("TXN-000003")).toBeInTheDocument();
  });
});

describe("check-out", () => {
  it("asks the desk to collect an open balance and shows the final bill", async () => {
    setRole("agent");
    const confirm = stubConfirm(true);
    const stay = { ...booking, checkIn: "2020-01-01", checkOut: "2099-01-01", checkedInAt: "2026-10-17T10:00:00Z" };
    mockApi({
      "GET /reservations?": () => reply(200, { reservations: [stay] }),
      "GET /reservations/R-RULES/payment-summary": () => reply(200, { balanceDue: 40, currency: "USD" }),
      "POST /reservations/R-RULES/check-out": () =>
        reply(200, {
          ...stay,
          checkedOutAt: "2026-10-18T10:00:00Z",
          statement: { totalAmount: 450, depositApplied: 135, approvedPayments: 275, collectedAtDesk: 40, balanceDue: 0, currency: "USD" },
        }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Check out" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("still owes 40.00 USD"));
    await waitFor(() => expect(calls("POST", "/reservations/R-RULES/check-out")).toHaveLength(1));
    expect(JSON.parse(calls("POST", "/reservations/R-RULES/check-out")[0][1].body)).toEqual({ collectBalance: true });
    expect(await screen.findByText(/deposit applied 135.00/)).toBeInTheDocument();
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
  });
});

describe("guest booking details", () => {
  const pendingStay = { ...booking, guestId: "guest-1", status: "pending" };
  const guestRoutes = (stay) => ({
    "GET /reservations?": () => reply(200, { reservations: [stay] }),
    "GET /reservations/R-RULES": () =>
      reply(200, { ...stay, additionalGuests: [{ position: 2, name: "Grace Hopper", idDocument: "P2" }] }),
    "GET /reservations/R-RULES/payment-summary": () =>
      reply(200, { totalAmount: 450, depositHeld: 135, approvedProofsTotal: 0, settledAtDesk: 0, balanceDue: 315, currency: "USD" }),
    "GET /guests/guest-1": () =>
      reply(200, { id: "guest-1", firstName: "Ada", lastName: "Lovelace", email: "guest@example.com", idDocument: "P1" }),
    "GET /payments/proofs": () =>
      reply(200, { proofs: [{ id: "p1", paymentNo: "PMT-000009", reservationNo: "R-RULES", amount: 100, currency: "USD", status: "approved", reviewedAt: "2099-01-02T09:00:00Z", fileName: "slip.png", fileType: "image/png" }] }),
  });

  it("shows the guest all booking and guest details and lets them modify while pending", async () => {
    setRole("guest");
    mockApi(guestRoutes(pendingStay));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "R-RULES" }));
    const dialog = await screen.findByRole("dialog", { name: "Booking R-RULES" });

    expect(await within(dialog).findByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(dialog).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(dialog).getByText("PMT-000009")).toBeInTheDocument();
    expect(within(dialog).queryByText(/REVIEWED BY/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Card transactions")).not.toBeInTheDocument();
    expect(calls("GET", "/payments/transactions")).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Modify booking" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Modify R-RULES" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Grace Hopper")).toBeInTheDocument();
  });

  it("offers no Modify or Cancel once the booking is confirmed", async () => {
    setRole("guest");
    mockApi(guestRoutes({ ...pendingStay, status: "confirmed" }));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "R-RULES" }));
    const dialog = await screen.findByRole("dialog", { name: "Booking R-RULES" });
    await within(dialog).findByText("Ada Lovelace");

    expect(within(dialog).queryByRole("button", { name: "Modify booking" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel booking" })).not.toBeInTheDocument();
  });
});
