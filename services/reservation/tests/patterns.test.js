import { readFile } from "node:fs/promises";
import { jest } from "@jest/globals";
import { createEventBus, createOutbox, getBroker } from "../events.js";
import { createServiceHttp, withInternalToken, withRetry, withTimeout } from "../http-client.js";
import { restoreMemento, saveMemento } from "../memento.js";
import { refundPlan } from "../refund-plan.js";
import { stateOf, stayOf } from "../reservation-state.js";
import { pool } from "../db.js";

beforeAll(async () => {
  await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE event_outbox, reservation_payments, reservations CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("State: reservation lifecycle rules", () => {
  const context = (overrides = {}) => ({
    reservation: { checkIn: "2027-03-10", checkOut: "2027-03-12" },
    today: "2027-03-01",
    role: "guest",
    ...overrides,
  });

  it("lets a guest change a pending booking but not a confirmed one", () => {
    expect(stateOf({ status: "pending" }).modify(context())).toBeNull();
    expect(stateOf({ status: "confirmed" }).modify(context())[0]).toBe(403);
    expect(stateOf({ status: "confirmed" }).modify(context({ role: "agent" }))).toBeNull();
  });

  it("allows check-in only for paid bookings inside the stay dates", () => {
    expect(stateOf({ status: "pending" }).checkIn(context())[2]).toMatch(/payment/);
    expect(stateOf({ status: "confirmed" }).checkIn(context())[2]).toBe("Check-in opens on 2027-03-10.");
    expect(stateOf({ status: "confirmed" }).checkIn(context({ today: "2027-03-10" }))).toBeNull();
  });

  it("moves through checked in, checked out and cancelled", () => {
    const checkedIn = stateOf({ status: "confirmed", checked_in_at: new Date() });
    expect(checkedIn.name).toBe("checked-in");
    expect(checkedIn.cancel(context({ role: "manager" }))[0]).toBe(409);
    expect(checkedIn.checkOut(context())).toBeNull();
    expect(stateOf({ status: "confirmed", checkedInAt: "x", checkedOutAt: "y" }).name).toBe("checked-out");
    expect(stateOf({ status: "cancelled" }).approvePayment().error[0]).toBe(409);
    expect(stateOf({ status: "pending" }).approvePayment()).toEqual({ next: "confirmed" });
    expect(stayOf({ checkInDate: "2027-01-01", checkOutDate: "2027-01-02" })).toEqual({ checkIn: "2027-01-01", checkOut: "2027-01-02" });
  });
});

describe("Iterator: refund plan", () => {
  it("takes from the newest payments first and stops when the amount is covered", () => {
    const sources = [
      { billingPaymentId: "topup", amount: 30, refunded: 10 },
      { billingPaymentId: "deposit", amount: 60, refunded: 0 },
    ];

    expect([...refundPlan(sources, 50)]).toEqual([
      { source: sources[0], amount: 20 },
      { source: sources[1], amount: 30 },
    ]);
    expect(() => [...refundPlan(sources, 100)]).toThrow("inconsistent");
  });
});

describe("Decorator: service HTTP client", () => {
  const base = () => ({
    get: jest.fn().mockResolvedValue({ data: "ok" }),
    post: jest.fn().mockResolvedValue({ data: "ok" }),
    delete: jest.fn().mockResolvedValue({ data: "ok" }),
  });

  it("adds the internal token and a timeout without changing the interface", async () => {
    const client = base();
    const decorated = withTimeout(withInternalToken(client, () => "secret"), 1500);

    await decorated.post("/x", { a: 1 });

    expect(client.post).toHaveBeenCalledWith("/x", { a: 1 }, {
      timeout: 1500,
      headers: { "x-internal-token": "secret" },
    });
  });

  it("retries reads on transient failures but never retries writes", async () => {
    const client = base();
    client.get
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ data: "second try" });
    client.post.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));
    const decorated = withRetry(client, { sleep: async () => {} });

    expect((await decorated.get("/read")).data).toBe("second try");
    await expect(decorated.post("/write", {})).rejects.toThrow("boom");
    expect(client.post).toHaveBeenCalledTimes(1);

    client.get.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    await expect(decorated.get("/missing")).rejects.toThrow("not found");
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it("composes all decorators by default", () => {
    expect(Object.keys(createServiceHttp(base()))).toEqual(expect.arrayContaining(["get", "post", "delete"]));
  });
});

describe("Memento: undo a failed multi-step operation", () => {
  it("restores the exact fields a cancellation changed", async () => {
    await pool.query(
      `INSERT INTO reservations (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, deposit_net, currency, status)
       VALUES ('R-MEM', 'g', 'standard', 'h', '2027-03-10', '2027-03-12', 200, 60, 60, 'USD', 'confirmed')`,
    );
    const memento = await saveMemento(pool, "R-MEM");
    await pool.query(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = NOW(), refund_amount = 60,
         cancellation_fee = 0, deposit_net = 0 WHERE reservation_no = 'R-MEM'`,
    );

    await restoreMemento(pool, memento);

    const row = await pool.query(
      "SELECT status, cancelled_at, refund_amount, deposit_net::float AS held FROM reservations WHERE reservation_no = 'R-MEM'",
    );
    expect(row.rows[0]).toEqual({ status: "confirmed", cancelled_at: null, refund_amount: null, held: 60 });
    expect(Object.isFrozen(memento.state)).toBe(true);
  });
});

describe("Observer and outbox: reliable events", () => {
  it("notifies every subscriber and isolates a failing one", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    const unsubscribe = bus.subscribe((topic, payload) => seen.push([topic, payload.id]));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await bus.publish("ReservationCancelled", { id: 1 });
    unsubscribe();
    await bus.publish("ReservationCancelled", { id: 2 });

    expect(seen).toEqual([["ReservationCancelled", 1]]);
  });

  it("keeps events while the broker is down and delivers them later, in order", async () => {
    const delivered = [];
    let brokerUp = false;
    const broker = {
      publish: jest.fn(async (queue, payload) => {
        if (!brokerUp) throw new Error("ECONNREFUSED");
        delivered.push([queue, payload.reservationNo]);
      }),
    };
    const outbox = createOutbox({ db: pool, broker });

    await outbox.record("ReservationConfirmed", { reservationNo: "R-1" });
    await outbox.record("ReservationModified", { reservationNo: "R-1" });
    expect(await outbox.dispatch()).toBe(0);

    const waiting = await pool.query("SELECT attempts, last_error FROM event_outbox ORDER BY id");
    expect(waiting.rows[0]).toEqual({ attempts: 1, last_error: "ECONNREFUSED" });

    brokerUp = true;
    expect(await outbox.dispatch()).toBe(2);
    expect(delivered).toEqual([["ReservationConfirmed", "R-1"], ["ReservationModified", "R-1"]]);
    expect(await outbox.dispatch()).toBe(0);
  });

  it("uses a single broker connection per process", () => {
    expect(getBroker()).toBe(getBroker());
  });
});
