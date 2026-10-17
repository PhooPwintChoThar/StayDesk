import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaymentsScreen from "./PaymentsScreen.jsx";
import { setRole } from "./api.js";
import { GUEST_ID, calls, headerOf, mockApi, reply } from "./test-helpers.js";

// The file input restricts choices through `accept`; a user can still pick any
// file ("All files"), so the tests bypass that filter to exercise our checks.
const user = () => userEvent.setup({ applyAccept: false });

const guestSession = { token: "t", claims: { role: "guest", guestId: GUEST_ID } };
const agentSession = { token: "t", claims: { role: "agent", sub: "agent" } };

const mine = [
  { reservationNo: "R-OWN-1", guestId: GUEST_ID, checkIn: "2027-03-10", checkOut: "2027-03-12", status: "confirmed", currency: "USD" },
  { reservationNo: "R-OWN-2", guestId: GUEST_ID, checkIn: "2027-05-01", checkOut: "2027-05-03", status: "confirmed", currency: "USD" },
];
const someoneElses = {
  reservationNo: "R-OTHER", guestId: "guest-2", checkIn: "2027-04-01", checkOut: "2027-04-02", status: "confirmed", currency: "USD",
};

const summaries = {
  "R-OWN-1": { totalAmount: 300, depositHeld: 90, approvedPayments: 60, balanceDue: 150, currency: "USD" },
  "R-OWN-2": { totalAmount: 200, depositHeld: 60, approvedPayments: 200, balanceDue: 0, currency: "USD" },
};

const proof = (overrides = {}) => ({
  id: "p1", reservationNo: "R-OWN-1", guestId: GUEST_ID, amount: 60, currency: "USD",
  note: null, fileName: "slip.png", fileType: "image/png", fileSize: 1234, status: "pending",
  reviewedBy: null, reviewedAt: null, reviewNote: null, createdAt: "2027-03-01T10:00:00Z", ...overrides,
});

function guestRoutes(extra = {}) {
  return {
    // The mock deliberately leaks another guest's booking to prove the UI ignores it.
    "GET /reservations?": () => reply(200, { reservations: [...mine, someoneElses] }),
    "GET /reservations/R-OWN-1/payment-summary": () => reply(200, summaries["R-OWN-1"]),
    "GET /reservations/R-OWN-2/payment-summary": () => reply(200, summaries["R-OWN-2"]),
    "GET /payments/proofs?reservationNo=R-OWN-1": () => reply(200, { proofs: [proof()] }),
    "GET /payments/proofs?reservationNo=R-OWN-2": () => reply(200, { proofs: [] }),
    ...extra,
  };
}

const pdf = (name = "slip.pdf") => new File(["%PDF"], name, { type: "application/pdf" });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guest payments", () => {
  beforeEach(() => setRole("guest"));

  it("lists only the guest's own reservations and loads summary and proofs", async () => {
    mockApi(guestRoutes());
    render(<PaymentsScreen session={guestSession} />);

    const select = await screen.findByLabelText("Reservation");
    const options = within(select).getAllByRole("option").map((o) => o.value);
    expect(options).toEqual(["R-OWN-1", "R-OWN-2"]);
    expect(options).not.toContain("R-OTHER");

    const summary = await screen.findByLabelText("Payment summary");
    expect(summary).toHaveTextContent("300.00");
    expect(summary).toHaveTextContent("90.00");
    expect(summary).toHaveTextContent("60.00");
    expect(summary).toHaveTextContent("150.00");
    expect(summary).toHaveTextContent("USD");
    expect(await screen.findByLabelText(/^Amount/)).toHaveValue(150);
    expect(calls("GET", "/payments/proofs?reservationNo=R-OWN-1")).toHaveLength(1);
  });

  it("loads the other reservation when the guest switches", async () => {
    mockApi(guestRoutes());
    render(<PaymentsScreen session={guestSession} />);
    await screen.findByLabelText("Payment summary");

    await userEvent.selectOptions(screen.getByLabelText("Reservation"), "R-OWN-2");

    await waitFor(() =>
      expect(calls("GET", "/reservations/R-OWN-2/payment-summary")).toHaveLength(1),
    );
    expect(await screen.findByText("No payment proofs uploaded for this reservation yet.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(null); // balance 0: no default
  });

  it("shows status badges and the reviewer note for rejected proofs", async () => {
    mockApi(
      guestRoutes({
        "GET /payments/proofs?reservationNo=R-OWN-1": () =>
          reply(200, {
            proofs: [
              proof({ id: "p1", status: "approved", fileName: "ok.pdf" }),
              proof({ id: "p2", status: "rejected", fileName: "bad.png", reviewNote: "Image is blurry" }),
              proof({ id: "p3", status: "pending", fileName: "wait.png" }),
              proof({ id: "p4", guestId: "guest-2", fileName: "other-guest.pdf" }),
            ],
          }),
      }),
    );
    render(<PaymentsScreen session={guestSession} />);

    const list = await screen.findByRole("list", { name: "Payment proofs" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("approved");
    expect(items[1]).toHaveTextContent("rejected");
    expect(items[1]).toHaveTextContent("Reviewer note: Image is blurry");
    expect(items[2]).toHaveTextContent("pending");
    expect(items[0]).not.toHaveTextContent("Reviewer note");
    expect(within(list).queryByText("other-guest.pdf")).not.toBeInTheDocument();
  });

  it("shows an empty state when the guest has no reservations", async () => {
    mockApi({ "GET /reservations": () => reply(200, { reservations: [] }) });
    render(<PaymentsScreen session={guestSession} />);

    expect(await screen.findByText(/You have no reservations yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload proof" })).not.toBeInTheDocument();
  });

  it("shows an error state when reservations cannot be loaded", async () => {
    mockApi({ "GET /reservations": () => reply(500, { error: "Boom", message: "Server is down" }) });
    render(<PaymentsScreen session={guestSession} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Server is down");
  });

  describe("upload validation", () => {
    async function setup() {
      mockApi(guestRoutes({ "POST /payments/proofs": () => reply(201, { id: "new", status: "pending" }) }));
      render(<PaymentsScreen session={guestSession} />);
      await screen.findByLabelText("Payment summary");
      await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toHaveValue(150));
    }

    it("rejects a file of the wrong type", async () => {
      await setup();
      const u = user();
      await u.upload(screen.getByLabelText(/^Proof file/), new File(["x"], "notes.txt", { type: "text/plain" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Only PNG, JPEG or PDF files are allowed.");
      await u.click(screen.getByRole("button", { name: "Upload proof" }));
      expect(calls("POST", "/payments/proofs")).toHaveLength(0);
    });

    it("rejects a file over 5 MB", async () => {
      await setup();
      const big = pdf("big.pdf");
      Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
      await user().upload(screen.getByLabelText(/^Proof file/), big);

      expect(await screen.findByRole("alert")).toHaveTextContent("The file is too large. The maximum size is 5 MB.");
      expect(calls("POST", "/payments/proofs")).toHaveLength(0);
    });

    it("requires a file", async () => {
      await setup();
      await user().click(screen.getByRole("button", { name: "Upload proof" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Choose a proof file to upload.");
      expect(calls("POST", "/payments/proofs")).toHaveLength(0);
    });

    it("requires an amount greater than 0", async () => {
      await setup();
      const u = user();
      await u.upload(screen.getByLabelText(/^Proof file/), pdf());
      await u.clear(screen.getByLabelText(/^Amount/));
      await u.type(screen.getByLabelText(/^Amount/), "0");
      await u.click(screen.getByRole("button", { name: "Upload proof" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount greater than 0");
      expect(calls("POST", "/payments/proofs")).toHaveLength(0);
    });
  });

  it("uploads with FormData, clears the form, reloads and shows one status message", async () => {
    let proofs = [proof()];
    mockApi(
      guestRoutes({
        "GET /payments/proofs?reservationNo=R-OWN-1": () => reply(200, { proofs }),
        "POST /payments/proofs": () => {
          proofs = [proof({ id: "p9", fileName: "new.pdf", amount: 150 }), ...proofs];
          return reply(201, { id: "p9", status: "pending" });
        },
      }),
    );
    render(<PaymentsScreen session={guestSession} />);
    await screen.findByLabelText("Payment summary");
    await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toHaveValue(150));

    const u = user();
    await u.upload(screen.getByLabelText(/^Proof file/), pdf("new.pdf"));
    await u.type(screen.getByLabelText("Note (optional)"), "Paid by bank transfer");
    await u.click(screen.getByRole("button", { name: "Upload proof" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Payment proof uploaded");
    expect(screen.getAllByRole("status")).toHaveLength(1);

    const [, options] = calls("POST", "/payments/proofs")[0];
    expect(options.body).toBeInstanceOf(FormData);
    expect(headerOf(options.headers, "Content-Type")).toBeUndefined();
    expect(options.body.get("reservationNo")).toBe("R-OWN-1");
    expect(options.body.get("amount")).toBe("150");
    expect(options.body.get("currency")).toBe("USD");
    expect(options.body.get("note")).toBe("Paid by bank transfer");
    expect(options.body.get("file").name).toBe("new.pdf");

    // proofs reloaded, form cleared (note and file), amount back to the balance due
    await waitFor(() =>
      expect(calls("GET", "/payments/proofs?reservationNo=R-OWN-1").length).toBeGreaterThanOrEqual(2),
    );
    expect(await screen.findByText("new.pdf")).toBeInTheDocument();
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("");
    expect(screen.getByLabelText(/^Proof file/).files).toHaveLength(0);
  });

  it("shows the server error when an upload fails", async () => {
    mockApi(guestRoutes({ "POST /payments/proofs": () => reply(413, { message: "The uploaded file must be 5 MB or smaller." }) }));
    render(<PaymentsScreen session={guestSession} />);
    await screen.findByLabelText("Payment summary");
    await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toHaveValue(150));

    const u = user();
    await u.upload(screen.getByLabelText(/^Proof file/), pdf());
    await u.click(screen.getByRole("button", { name: "Upload proof" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The uploaded file must be 5 MB or smaller.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("staff payments", () => {
  beforeEach(() => setRole("agent"));

  const queue = [
    proof({ id: "p1", reservationNo: "R-100", fileName: "slip-a.png", guestId: "guest-7" }),
    proof({ id: "p2", reservationNo: "R-200", fileName: "slip-b.pdf", fileType: "application/pdf" }),
  ];

  function staffRoutes(extra = {}) {
    return { "GET /payments/proofs": () => reply(200, { proofs: queue }), ...extra };
  }

  it("loads the pending queue by default and renders no guest controls", async () => {
    mockApi(staffRoutes());
    render(<PaymentsScreen session={agentSession} />);

    const table = await screen.findByRole("table", { name: "Payment proofs" });
    expect(within(table).getByText("R-100")).toBeInTheDocument();
    expect(within(table).getByText("R-200")).toBeInTheDocument();
    expect(calls("GET", "/payments/proofs?status=pending")).toHaveLength(1);
    expect(screen.queryByLabelText("Reservation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload proof" })).not.toBeInTheDocument();
  });

  it("filters by status and confirmation number", async () => {
    mockApi(staffRoutes());
    render(<PaymentsScreen session={agentSession} />);
    await screen.findByRole("table", { name: "Payment proofs" });

    await userEvent.selectOptions(screen.getByLabelText("Proof status"), "rejected");
    await waitFor(() => expect(calls("GET", "/payments/proofs?status=rejected")).toHaveLength(1));

    await userEvent.selectOptions(screen.getByLabelText("Proof status"), "all");
    await waitFor(() => expect(calls("GET", "/payments/proofs").some(([u]) => u.endsWith("/payments/proofs"))).toBe(true));

    await userEvent.type(screen.getByLabelText("Confirmation number"), " R-200 ");
    await userEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await waitFor(() =>
      expect(calls("GET", "/payments/proofs?reservationNo=R-200")).toHaveLength(1),
    );
  });

  it("shows an empty state", async () => {
    mockApi({ "GET /payments/proofs": () => reply(200, { proofs: [] }) });
    render(<PaymentsScreen session={agentSession} />);

    expect(await screen.findByText("No payment proofs match this filter.")).toBeInTheDocument();
  });

  it("opens a file through an authenticated blob in a new tab and revokes the URL", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} };
    vi.spyOn(window, "open").mockReturnValue(tab);
    URL.createObjectURL = vi.fn(() => "blob:proof-1");
    URL.revokeObjectURL = vi.fn();
    mockApi(
      staffRoutes({
        "GET /payments/proofs/p1/file": () =>
          reply(200, null, { blob: async () => new Blob(["x"], { type: "image/png" }) }),
      }),
    );
    const { unmount } = render(<PaymentsScreen session={agentSession} />);
    const row = (await screen.findByText("R-100")).closest("tr");

    await userEvent.click(within(row).getByRole("button", { name: "View file" }));

    await waitFor(() => expect(tab.location.href).toBe("blob:proof-1"));
    const [url, options] = calls("GET", "/payments/proofs/p1/file")[0];
    expect(url).not.toMatch(/token|Bearer/i);
    expect(headerOf(options.headers, "Authorization")).toMatch(/^Bearer /);
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();

    unmount(); // pending object URLs are revoked on unmount
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:proof-1");
  });

  it("approves a proof and reloads the queue", async () => {
    let list = queue;
    mockApi(
      staffRoutes({
        "GET /payments/proofs": () => reply(200, { proofs: list }),
        "PUT /payments/proofs/p1/review": () => {
          list = queue.slice(1);
          return reply(200, { proof: { ...queue[0], status: "approved" } });
        },
      }),
    );
    render(<PaymentsScreen session={agentSession} />);
    const row = (await screen.findByText("R-100")).closest("tr");

    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Payment proof approved.");
    await waitFor(() => expect(screen.queryByText("R-100")).not.toBeInTheDocument());
    expect(JSON.parse(calls("PUT", "/payments/proofs/p1/review")[0][1].body)).toEqual({ decision: "approved" });
  });

  it("requires a note to reject and sends it", async () => {
    mockApi(
      staffRoutes({
        "PUT /payments/proofs/p2/review": () => reply(200, { proof: { ...queue[1], status: "rejected" } }),
      }),
    );
    render(<PaymentsScreen session={agentSession} />);
    const row = (await screen.findByText("R-200")).closest("tr");

    await userEvent.click(within(row).getByRole("button", { name: "Reject" }));
    const submit = screen.getByRole("button", { name: "Submit rejection" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Rejection note"), "   ");
    expect(submit).toBeDisabled(); // whitespace is not a note

    await userEvent.type(screen.getByLabelText("Rejection note"), "Amount does not match");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(calls("PUT", "/payments/proofs/p2/review")).toHaveLength(1));
    expect(JSON.parse(calls("PUT", "/payments/proofs/p2/review")[0][1].body)).toEqual({
      decision: "rejected",
      note: "Amount does not match",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Payment proof rejected.");
  });

  it("shows a friendly message on 403", async () => {
    mockApi({ "GET /payments/proofs": () => reply(403, { error: "Forbidden", message: "raw" }) });
    render(<PaymentsScreen session={agentSession} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to do that.");
  });
});

describe("per-role rendering", () => {
  it("renders the guest screen for guests and the review queue for managers", async () => {
    setRole("guest");
    mockApi(guestRoutes());
    const guest = render(<PaymentsScreen session={guestSession} />);
    expect(await screen.findByRole("heading", { name: "My payments" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payment proof review" })).not.toBeInTheDocument();
    guest.unmount();

    setRole("manager");
    mockApi({ "GET /payments/proofs": () => reply(200, { proofs: [] }) });
    render(<PaymentsScreen session={{ token: "t", claims: { role: "manager", sub: "manager" } }} />);
    expect(await screen.findByRole("heading", { name: "Payment proof review" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My payments" })).not.toBeInTheDocument();
  });

  it("renders neither for an unknown role", () => {
    render(<PaymentsScreen session={{ token: "t", claims: { role: "intern" } }} />);
    expect(screen.getByText("Payments are not available for this account.")).toBeInTheDocument();
  });
});
