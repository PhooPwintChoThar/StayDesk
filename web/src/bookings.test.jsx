import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { setRole } from "./api.js";
import { GUEST_ID, calls, mockApi, reply, stubConfirm } from "./test-helpers.js";

const stored = {
  reservationNo: "R-STORED",
  guestId: GUEST_ID,
  roomTypeId: "standard",
  checkIn: "2027-03-10",
  checkOut: "2027-03-13",
  totalAmount: 450,
  currency: "USD",
  status: "confirmed",
};

const quote = { refundAmount: 135, feeAmount: 15, currency: "USD", rule: "partial", hoursBeforeCheckIn: 72 };

const guestRecord = {
  id: GUEST_ID,
  firstName: "Test",
  lastName: "Guest",
  email: "guest@example.com",
  phone: "+66 81 000 0000",
  address: "1 Sukhumvit Rd",
  preferences: "High floor, quiet room",
  idDocument: "P123456789",
  loyaltyTier: "gold",
  loyaltyNumber: "L-42",
};

function routes(extra = {}) {
  return {
    "GET /reservations": () => reply(200, { reservations: [stored] }),
    "GET /reservations/R-STORED/cancellation-quote": () => reply(200, quote),
    "DELETE /reservations/R-STORED": () => reply(204),
    ...extra,
  };
}

const openCancel = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Actions for R-STORED" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
};

const deleteBody = () => {
  const [, options] = calls("DELETE", "/reservations/R-STORED")[0];
  return options.body ? JSON.parse(options.body) : undefined;
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("guest bookings", () => {
  it("lists the guest's own reservations with Modify and Cancel", async () => {
    setRole("guest");
    mockApi(routes());
    render(<App />);

    const table = await screen.findByRole("table");
    expect(await within(table).findByText("R-STORED")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 entries")).toBeInTheDocument();
    expect(screen.getByText("My bookings")).toBeInTheDocument();
    expect(screen.queryByText(/cannot view the booking register/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Confirmation number")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("From date")).not.toBeInTheDocument();
    expect(within(table).getByText("2027-03-10")).toBeInTheDocument();
    expect(within(table).getByText("2027-03-13")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New Reservation" })).toBeInTheDocument();
    expect(screen.queryByText("Total bookings")).not.toBeInTheDocument(); // staff KPIs stay hidden
    const listRequest = calls("GET", "/reservations")[0][0];
    expect(new URL(listRequest, "http://localhost").search).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Actions for R-STORED" }));
    expect(screen.getByRole("menuitem", { name: "Modify" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Cancel" })).toBeEnabled();
  });

  it("books under the signed-in guest and refreshes the complete booking list", async () => {
    setRole("guest");
    let reservations = [stored];
    mockApi({
      "GET /reservations": () => reply(200, { reservations }),
      "GET /availability": () =>
        reply(200, {
          availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
        }),
      "POST /reservations": (_path, options) => {
        const body = JSON.parse(options.body);
        const created = {
          ...stored,
          reservationNo: "R-GUEST-NEW",
          guestId: GUEST_ID,
          checkIn: body.checkIn,
          checkOut: body.checkOut,
        };
        reservations = [...reservations, created];
        return reply(201, created);
      },
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "+ New Reservation" }));
    await userEvent.type(screen.getByLabelText("Check-in"), "2027-04-01");
    await userEvent.type(screen.getByLabelText("Check-out"), "2027-04-03");
    await userEvent.click(screen.getByRole("button", { name: "Search availability" }));
    await userEvent.click(await screen.findByRole("button", { name: "Select" }));

    const email = screen.getByLabelText("Email");
    expect(email).toHaveValue("guest@example.com");
    expect(email).toHaveAttribute("readonly");
    await userEvent.type(screen.getByLabelText("First name"), "Test");
    await userEvent.type(screen.getByLabelText("Last name"), "Guest");
    await userEvent.click(screen.getByRole("button", { name: "Book room" }));

    const table = screen.getByRole("table");
    expect(await within(table).findByText("R-GUEST-NEW")).toBeInTheDocument();
    expect(within(table).getByText("2027-04-01")).toBeInTheDocument();
    expect(within(table).getByText("2027-04-03")).toBeInTheDocument();
    expect(calls("GET", "/reservations")).toHaveLength(2);
    expect(JSON.parse(calls("POST", "/reservations")[0][1].body).guest.email).toBe("guest@example.com");
  });

  it("lets a guest cancel and sends no waiver", async () => {
    setRole("guest");
    const confirm = stubConfirm();
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteBody()).toBeUndefined();
  });
});

describe("cancel flow", () => {
  it("puts the cancellation quote into the confirm message", async () => {
    setRole("agent");
    const confirm = stubConfirm();
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(calls("GET", "/reservations/R-STORED/cancellation-quote")).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "Refund 135 USD, fee 15 USD (rule partial). Cancel reservation R-STORED?",
    );
  });

  it("falls back to the plain message when the quote call fails", async () => {
    setRole("agent");
    const confirm = stubConfirm();
    mockApi(routes({ "GET /reservations/R-STORED/cancellation-quote": () => reply(500, { error: "x" }) }));
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith("Cancel reservation R-STORED?");
  });

  it("does not delete when the user declines the confirmation", async () => {
    setRole("agent");
    stubConfirm(false);
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("GET", "/reservations/R-STORED/cancellation-quote")).toHaveLength(1));
    expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(0);
  });

  it("asks a manager whether to waive a fee and sends waiveFee when accepted", async () => {
    setRole("manager");
    const confirm = stubConfirm(true, true);
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(2, "Waive the cancellation fee?");
    expect(deleteBody()).toEqual({ waiveFee: true });
  });

  it("cancels without a waiver when the manager declines the second prompt", async () => {
    setRole("manager");
    stubConfirm(true, false);
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(deleteBody()).toBeUndefined();
  });

  it("does not offer a waiver to a manager when the fee is 0", async () => {
    setRole("manager");
    const confirm = stubConfirm();
    mockApi(routes({ "GET /reservations/R-STORED/cancellation-quote": () => reply(200, { ...quote, refundAmount: 150, feeAmount: 0, rule: "full" }) }));
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["agent", "guest"])("never shows the waiver prompt to a %s", async (role) => {
    setRole(role);
    const confirm = stubConfirm();
    mockApi(routes());
    render(<App />);
    await openCancel();

    await waitFor(() => expect(calls("DELETE", "/reservations/R-STORED")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalledWith("Waive the cancellation fee?");
    expect(deleteBody()).toBeUndefined();
  });
});

describe("room search and guest records", () => {
  const bookingRoutes = () =>
    routes({
      "GET /availability": () =>
        reply(200, {
          availability: [
            { roomTypeId: "standard", name: "Standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" },
            { roomTypeId: "sold-out", name: "Sold out", available: false, roomsAvailable: 0, nightlyRate: 150, currency: "USD" },
          ],
        }),
    });

  async function reachGuestForm() {
    await userEvent.click(await screen.findByRole("button", { name: "+ New Reservation" }));
    await screen.findByLabelText("Room type (optional)");
    await userEvent.type(screen.getByLabelText("Check-in"), "2027-03-10");
    await userEvent.type(screen.getByLabelText("Check-out"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "Search availability" }));
    await userEvent.click(await screen.findByRole("button", { name: "Select" }));
    await screen.findByLabelText("First name");
  }

  it("selects room types from the database catalog and shows available rooms only", async () => {
    setRole("agent");
    mockApi(bookingRoutes());
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "+ New Reservation" }));
    const typeSelect = await screen.findByLabelText("Room type (optional)");
    expect(within(typeSelect).getByRole("option", { name: "Standard" })).toBeInTheDocument();
    expect(within(typeSelect).getByRole("option", { name: "Suite" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Hotel (optional)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Room type ID (optional)")).not.toBeInTheDocument();
    await userEvent.selectOptions(typeSelect, "standard");
    await userEvent.type(screen.getByLabelText("Check-in"), "2027-03-10");
    await userEvent.type(screen.getByLabelText("Check-out"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "Search availability" }));

    const available = await screen.findByRole("list", { name: "Available rooms" });
    expect(within(available).getByText(/Standard/)).toBeInTheDocument();
    expect(within(available).queryByText(/Sold out/)).not.toBeInTheDocument();
    expect(calls("GET", "/availability?checkIn=2027-03-10&checkOut=2027-03-12&roomTypeId=standard")).toHaveLength(1);
  });

  it.each(["guest", "agent", "manager"])("shows no loyalty controls or data for %s", async (role) => {
    setRole(role);
    mockApi(bookingRoutes());
    render(<App />);
    await reachGuestForm();

    expect(screen.queryByText(/loyalty/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/loyalty/i)).not.toBeInTheDocument();
  });

  async function openGuestProfile() {
    await userEvent.click(await screen.findByRole("button", { name: /Guests$/ }));
    await userEvent.type(screen.getByLabelText("Name, email or phone"), "test");
    await userEvent.click(screen.getByRole("button", { name: "Search guests" }));
    await userEvent.click(await screen.findByRole("button", { name: "View stays" }));
    await screen.findByText(/Stay history:/);
  }

  const guestRoutes = (extra = {}) =>
    routes({
      "GET /guests/search": () => reply(200, { guests: [guestRecord] }),
      ...extra,
    });

  it.each(["agent", "manager"])("shows guest records without loyalty data to a %s", async (role) => {
    setRole(role);
    mockApi(guestRoutes());
    render(<App />);
    await openGuestProfile();

    expect(screen.queryByText(/loyalty/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/loyalty/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export profile" })).toBeInTheDocument();
    if (role === "manager") {
      expect(screen.getByRole("button", { name: "Delete profile" })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("button", { name: "Delete profile" })).not.toBeInTheDocument();
    }
  });

  it("does not show loyalty fields on the sign-up form", () => {
    setRole(null);
    mockApi({});
    render(<App />);
    expect(screen.queryByText(/loyalty/i)).not.toBeInTheDocument();
  });

});

describe("guest My profile", () => {
  it("lets the guest edit profile details but keeps email read-only", async () => {
    setRole("guest");
    let updated = guestRecord;
    mockApi(
      routes({
        "GET /guests/guest-1": () => reply(200, updated),
        "PUT /guests/guest-1": (_path, options) => {
          updated = { ...updated, ...JSON.parse(options.body) };
          return reply(200, updated);
        },
      }),
    );
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "My profile" }));

    const email = await screen.findByLabelText("Email");
    expect(email).toHaveValue("guest@example.com");
    expect(email).toHaveAttribute("readonly");
    const documentNumber = screen.getByLabelText("Passport or ID number");
    await userEvent.clear(documentNumber);
    await userEvent.type(documentNumber, "PASSPORT-UPDATED");
    await userEvent.clear(screen.getByLabelText("Phone"));
    await userEvent.type(screen.getByLabelText("Phone"), "+66 81 999 0000");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Profile updated.");
    expect(calls("PUT", "/guests/guest-1")).toHaveLength(1);
    expect(JSON.parse(calls("PUT", "/guests/guest-1")[0][1].body)).toMatchObject({
      email: "guest@example.com",
      phone: "+66 81 999 0000",
      idDocument: "PASSPORT-UPDATED",
    });
    expect(updated.idDocument).toBe("PASSPORT-UPDATED");
    expect(screen.queryByText(/loyalty/i)).not.toBeInTheDocument();
  });

  it("shows an error state when the profile cannot be loaded", async () => {
    setRole("guest");
    mockApi(routes({ "GET /guests/guest-1": () => reply(500, { message: "Profile service down" }) }));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "My profile" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile service down");
  });
});
