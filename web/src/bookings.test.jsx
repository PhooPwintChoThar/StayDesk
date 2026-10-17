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
  idDocument: "P*****789",
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

describe("loyalty tier", () => {
  const bookingRoutes = () =>
    routes({
      "GET /availability": () =>
        reply(200, {
          availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
        }),
    });

  async function reachGuestForm() {
    await userEvent.click(await screen.findByRole("button", { name: "+ New Reservation" }));
    await userEvent.type(screen.getByLabelText("Check-in"), "2027-03-10");
    await userEvent.type(screen.getByLabelText("Check-out"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "Search availability" }));
    await userEvent.click(await screen.findByRole("button", { name: "Select" }));
    await screen.findByLabelText("First name");
  }

  it.each(["guest", "agent", "manager"])("has no loyalty tier input in the booking form for %s", async (role) => {
    setRole(role);
    mockApi(bookingRoutes());
    render(<App />);
    await reachGuestForm();

    expect(screen.queryByLabelText("Loyalty tier")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /loyalty tier/i })).not.toBeInTheDocument();
  });

  it("does not send loyaltyTier when booking", async () => {
    setRole("agent");
    mockApi({
      ...bookingRoutes(),
      "POST /reservations": () => reply(201, { ...stored, reservationNo: "R-1", depositAmount: 30 }),
    });
    render(<App />);
    await reachGuestForm();
    await userEvent.type(screen.getByLabelText("Email"), "g@example.com");
    await userEvent.type(screen.getByLabelText("First name"), "T");
    await userEvent.type(screen.getByLabelText("Last name"), "G");
    await userEvent.click(screen.getByRole("button", { name: "Book room" }));

    await screen.findByRole("status");
    expect(JSON.parse(calls("POST", "/reservations")[0][1].body).guest).not.toHaveProperty("loyaltyTier");
  });

  it("has no loyalty tier input on the sign-up form", () => {
    setRole(null);
    mockApi({});
    render(<App />);

    expect(screen.queryByLabelText("Loyalty tier")).not.toBeInTheDocument();
  });

  async function openGuestProfile() {
    await userEvent.click(await screen.findByRole("button", { name: /Guests$/ }));
    await userEvent.type(screen.getByLabelText("Name, email, phone or loyalty number"), "test");
    await userEvent.click(screen.getByRole("button", { name: "Search guests" }));
    await userEvent.click(await screen.findByRole("button", { name: "View stays" }));
    await screen.findByText(/Stay history:/);
  }

  const guestRoutes = (extra = {}) =>
    routes({
      "GET /guests/search": () => reply(200, { guests: [guestRecord] }),
      ...extra,
    });

  it("shows the tier read-only to an agent and hides Delete profile", async () => {
    setRole("agent");
    mockApi(guestRoutes());
    render(<App />);
    await openGuestProfile();

    expect(screen.getByText(/Loyalty tier: gold/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Loyalty tier")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save tier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete profile" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export profile" })).toBeInTheDocument();
  });

  it("lets a manager edit the tier and delete the profile", async () => {
    setRole("manager");
    mockApi(
      guestRoutes({
        "PUT /guests/guest-1": (_path, options) => reply(200, { ...guestRecord, ...JSON.parse(options.body) }),
      }),
    );
    render(<App />);
    await openGuestProfile();

    expect(screen.getByRole("button", { name: "Delete profile" })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save tier" });
    expect(save).toBeDisabled(); // unchanged

    await userEvent.selectOptions(screen.getByLabelText("Loyalty tier"), "platinum");
    await userEvent.click(save);

    await waitFor(() => expect(calls("PUT", "/guests/guest-1")).toHaveLength(1));
    const body = JSON.parse(calls("PUT", "/guests/guest-1")[0][1].body);
    expect(body).toMatchObject({ loyaltyTier: "platinum", email: "guest@example.com", firstName: "Test" });
    expect(await screen.findByText(/Loyalty tier: platinum/)).toBeInTheDocument();
  });
});

describe("guest My profile", () => {
  it("shows contact details, preferences, ID document and a read-only tier", async () => {
    setRole("guest");
    mockApi(routes({ "GET /guests/guest-1": () => reply(200, guestRecord) }));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "My profile" }));

    const contact = await screen.findByLabelText("Contact details");
    expect(contact).toHaveTextContent("Test Guest");
    expect(contact).toHaveTextContent("guest@example.com");
    expect(contact).toHaveTextContent("+66 81 000 0000");
    expect(contact).toHaveTextContent("1 Sukhumvit Rd");
    expect(screen.getByLabelText("Preferences and documents")).toHaveTextContent("High floor, quiet room");
    expect(screen.getByLabelText("Preferences and documents")).toHaveTextContent("P*****789"); // as returned
    expect(screen.getByLabelText("Loyalty")).toHaveTextContent("gold");
    expect(screen.queryByLabelText("Loyalty tier")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("shows an error state when the profile cannot be loaded", async () => {
    setRole("guest");
    mockApi(routes({ "GET /guests/guest-1": () => reply(500, { message: "Profile service down" }) }));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "My profile" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile service down");
  });
});
