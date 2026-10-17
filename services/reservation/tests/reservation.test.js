import { readFile } from "node:fs/promises";
import nock from "nock";
import request from "supertest";
import { createApp } from "../app.js";
import { createCancellationPolicy } from "../cancellation-policy.js";
import { pool } from "../db.js";
import { jest } from "@jest/globals";

const roomRate = "http://room-rate.test";
const guestService = "http://guest.test";
const billing = "http://billing.test";
const dates = { checkIn: "2027-03-10", checkOut: "2027-03-12" };

const reservationPayload = {
  guest: { email: "guest@example.com", firstName: "Test", lastName: "Guest", idDocument: "P1234567" },
  roomTypeId: "standard",
  ...dates,
};

beforeAll(async () => {
  process.env.ROOM_RATE_URL = roomRate;
  process.env.GUEST_URL = guestService;
  process.env.BILLING_URL = billing;
  await pool.query(
    await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
  );
});

beforeEach(async () => {
  await pool.query("TRUNCATE reservation_payments, reservations CASCADE");
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
});

afterAll(async () => {
  nock.restore();
  await pool.end();
});

describe("reservation endpoints", () => {
  it("creates, confirms, and publishes a reservation", async () => {
    const publishEvent = jest.fn().mockResolvedValue(undefined);
    const app = createApp({ db: pool, publishEvent });

    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [
          {
            roomTypeId: "standard",
            available: true,
            roomsAvailable: 1,
            nightlyRate: 100,
            currency: "USD",
          },
        ],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-1" });
    nock(guestService)
      .post("/guests/get-or-create")
      .reply(201, { id: "guest-1" });
    nock(billing)
      .post("/deposits", (body) =>
        body.reservationNo &&
        body.guestId === "guest-1" &&
        body.amount === 60 &&
        body.currency === "USD",
      )
      .reply(201, { id: "deposit-1", status: "authorized" });
    nock(roomRate)
      .post("/holds/hold-1/confirm")
      .reply(200, { status: "confirmed" });

    const response = await request(app)
      .post("/reservations")
      .send({ ...reservationPayload, depositAmount: 999, currency: "THB" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      guestId: "guest-1",
      roomTypeId: "standard",
      totalAmount: 200,
      depositAmount: 60,
      currency: "USD",
      status: "pending",
    });
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationNo: response.body.reservationNo,
        guestId: "guest-1",
      }),
    );
    const stored = await pool.query(
      "SELECT deposit_amount::float AS \"depositAmount\", deposit_net::float AS \"depositHeld\", currency FROM reservations WHERE reservation_no = $1",
      [response.body.reservationNo],
    );
    expect(stored.rows[0]).toEqual({ depositAmount: 60, depositHeld: 60, currency: "USD" });

    const ledger = await pool.query(
      "SELECT type, billing_payment_id AS \"billingPaymentId\", amount::float AS amount FROM reservation_payments WHERE reservation_no = $1 ORDER BY created_at",
      [response.body.reservationNo],
    );
    expect(ledger.rows).toEqual([
      {
        type: 'deposit',
        billingPaymentId: 'deposit-1',
        amount: 60,
      },
    ]);
  });

  it("releases the hold and returns 402 when billing declines", async () => {
    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [
          {
            roomTypeId: "standard",
            available: true,
            roomsAvailable: 1,
            nightlyRate: 100,
            currency: "USD",
          },
        ],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-declined" });
    nock(guestService)
      .post("/guests/get-or-create")
      .reply(201, { id: "guest-1" });
    nock(billing).post("/deposits").reply(402, { error: "PaymentDeclined" });
    const release = nock(roomRate).delete("/holds/hold-declined").reply(204);

    const response = await request(
      createApp({ db: pool, publishEvent: jest.fn() }),
    )
      .post("/reservations")
      .send(reservationPayload);

    expect(response.status).toBe(402);
    expect(release.isDone()).toBe(true);
    expect((await pool.query("SELECT * FROM reservations")).rowCount).toBe(0);
  });

  it("releases inventory and refunds when cancelling", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, currency, status)
       VALUES ('R-CANCEL', 'guest-1', 'standard', 'hold-cancel', $1, $2,
               200, 'deposit-cancel', 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const release = nock(roomRate).delete("/holds/hold-cancel").reply(204);
    const refund = nock(billing)
      .post("/refunds", {
        depositId: "deposit-cancel",
        amount: 50,
        currency: "USD",
      })
      .reply(201, { id: "refund-1", status: "refunded" });

    const response = await request(
      createApp({ db: pool, publishEvent: jest.fn() }),
    ).delete("/reservations/R-CANCEL");

    expect(response.status).toBe(204);
    expect(release.isDone()).toBe(true);
    expect(refund.isDone()).toBe(true);

    const row = await pool.query(
      "SELECT status FROM reservations WHERE reservation_no = $1",
      ["R-CANCEL"],
    );
    expect(row.rows[0].status).toBe("cancelled");
  });

  it("returns a cancellation quote without calling billing", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, deposit_net, currency, status)
       VALUES ('R-QUOTE', 'guest-1', 'standard', 'hold-quote', $1, $2,
               200, 'deposit-quote', 50, 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const response = await request(createApp({
      db: pool,
      publishEvent: jest.fn(),
      cancellationPolicy: createCancellationPolicy({ name: "full", refundPercent: 100 }),
    }))
      .get('/reservations/R-QUOTE/cancellation-quote');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      refundAmount: 50,
      feeAmount: 0,
      currency: 'USD',
    });
  });

  it('returns a payment summary that includes approved proof totals', async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, deposit_net, currency, status)
       VALUES ('R-SUMMARY', 'guest-1', 'standard', 'hold-summary', $1, $2,
               200, 'deposit-summary', 50, 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    nock(billing)
      .get('/payments/reservations/R-SUMMARY/totals')
      .reply(200, { approvedTotal: 17.5, pendingTotal: 5 });

    const response = await request(createApp({ db: pool, publishEvent: jest.fn() }))
      .get('/reservations/R-SUMMARY/payment-summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalAmount: 200,
      depositHeld: 50,
      approvedProofsTotal: 17.5,
      balanceDue: 132.5,
      currency: 'USD',
    });
  });

  it("skips the refund when the none cancellation policy is configured", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, currency, status)
       VALUES ('R-NO-REFUND', 'guest-1', 'standard', 'hold-none', $1, $2,
               200, 'deposit-none', 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const release = nock(roomRate).delete("/holds/hold-none").reply(204);

    const response = await request(
      createApp({
        db: pool,
        publishEvent: jest.fn(),
        cancellationPolicy: createCancellationPolicy({ name: "none" }),
      }),
    ).delete("/reservations/R-NO-REFUND");

    expect(response.status).toBe(204);
    expect(release.isDone()).toBe(true);
    expect(
      (await pool.query("SELECT status FROM reservations WHERE reservation_no = 'R-NO-REFUND'"))
        .rows[0].status,
    ).toBe("cancelled");
  });

  it("continues cancellation and refunds when the hold is not found", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, currency, status)
       VALUES ('R-MISSING-HOLD', 'guest-1', 'standard', 'missing-hold', $1, $2,
               200, 'deposit-missing-hold', 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const release = nock(roomRate)
      .delete("/holds/missing-hold")
      .reply(404, { error: "NotFound" });
    const refund = nock(billing)
      .post("/refunds", {
        depositId: "deposit-missing-hold",
        amount: 50,
        currency: "USD",
      })
      .reply(201, { id: "refund-missing-hold", status: "refunded" });

    const response = await request(
      createApp({ db: pool, publishEvent: jest.fn() }),
    ).delete("/reservations/R-MISSING-HOLD");

    expect(response.status).toBe(204);
    expect(release.isDone()).toBe(true);
    expect(refund.isDone()).toBe(true);

    const row = await pool.query(
      "SELECT status FROM reservations WHERE reservation_no = $1",
      ["R-MISSING-HOLD"],
    );
    expect(row.rows[0].status).toBe("cancelled");
  });

  it("lists reservations filtered by status and guest", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, currency, status)
       VALUES
        ('R-LIST-1', 'guest-1', 'standard', 'hold-a', '2027-03-10', '2027-03-12', 200, 50, 'USD', 'confirmed'),
        ('R-LIST-2', 'guest-1', 'standard', 'hold-b', '2027-04-01', '2027-04-02', 100, 50, 'USD', 'cancelled'),
        ('R-LIST-3', 'guest-2', 'standard', 'hold-c', '2027-05-01', '2027-05-03', 200, 50, 'USD', 'confirmed')`,
    );
    const app = createApp({ db: pool, publishEvent: jest.fn() });

    const all = await request(app).get("/reservations");
    expect(all.status).toBe(200);
    expect(all.body.reservations).toHaveLength(3);
    expect(all.body.reservations[0]).toMatchObject({
      reservationNo: "R-LIST-3",
      checkIn: "2027-05-01",
      checkOut: "2027-05-03",
    });

    const filtered = await request(app)
      .get("/reservations")
      .query({ guestId: "guest-1", status: "confirmed" });
    expect(filtered.body.reservations.map((r) => r.reservationNo)).toEqual([
      "R-LIST-1",
    ]);

    const bad = await request(app)
      .get("/reservations")
      .query({ from: "not-a-date" });
    expect(bad.status).toBe(400);
  });

  it("does not modify a reservation when requested dates have no availability", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, currency, status)
       VALUES ('R-MODIFY', 'guest-1', 'standard', 'hold-existing', $1, $2,
               200, 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const availability = nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [
          {
            roomTypeId: "standard",
            available: false,
            roomsAvailable: 0,
            nightlyRate: 100,
          },
        ],
      });

    const response = await request(
      createApp({ db: pool, publishEvent: jest.fn() }),
    )
      .put("/reservations/R-MODIFY")
      .send({
        roomTypeId: "standard",
        checkIn: "2027-03-20",
        checkOut: "2027-03-22",
      });

    expect(response.status).toBe(409);
    expect(availability.isDone()).toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  it("modifies a reservation by excluding the current hold from the new availability check", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, currency, status)
       VALUES ('R-MODIFY-SWAP', 'guest-1', 'standard', 'hold-existing', $1, $2,
               200, 50, 'USD', 'confirmed')`,
      [dates.checkIn, dates.checkOut],
    );

    const availability = nock(roomRate)
      .get('/availability')
      .query((query) =>
        query.roomTypeId === 'standard' &&
        query.checkIn === '2027-03-20' &&
        query.checkOut === '2027-03-22' &&
        query.excludeHoldId === 'hold-existing',
      )
      .reply(200, {
        availability: [
          {
            roomTypeId: 'standard',
            available: true,
            roomsAvailable: 1,
            nightlyRate: 125,
            currency: 'USD',
          },
        ],
      });

    const hold = nock(roomRate)
      .post('/holds', (body) =>
        body.roomTypeId === 'standard' &&
        body.checkIn === '2027-03-20' &&
        body.checkOut === '2027-03-22' &&
        body.excludeHoldId === 'hold-existing',
      )
      .reply(201, { id: 'hold-new', roomId: 'room-102', roomNumber: '102' });

    nock(roomRate).post('/holds/hold-new/confirm').reply(200, { status: 'confirmed' });
    const topUp = nock(billing)
      .post('/deposits', (body) =>
        body.reservationNo === 'R-MODIFY-SWAP' &&
        body.guestId === 'guest-1' &&
        body.amount === 25 &&
        body.currency === 'USD',
      )
      .reply(201, { id: 'deposit-topup', status: 'authorized' });
    const release = nock(roomRate).delete('/holds/hold-existing').reply(204);

    const response = await request(
      createApp({ db: pool, publishEvent: jest.fn() }),
    )
      .put('/reservations/R-MODIFY-SWAP')
      .send({
        roomTypeId: 'standard',
        checkIn: '2027-03-20',
        checkOut: '2027-03-22',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reservationNo: 'R-MODIFY-SWAP',
      checkIn: '2027-03-20',
      checkOut: '2027-03-22',
      totalAmount: 250,
      depositHeld: 75,
      roomNumber: '102',
    });
    expect(availability.isDone()).toBe(true);
    expect(hold.isDone()).toBe(true);
    expect(topUp.isDone()).toBe(true);
    expect(release.isDone()).toBe(true);
  });

  it("stores the assigned room and still books when the event broker is down", async () => {
    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-room", roomId: "room-101", roomNumber: "101" });
    nock(guestService).post("/guests/get-or-create").reply(201, { id: "guest-1", email: "guest@example.com" });
    nock(billing).post("/deposits").reply(201, { id: "deposit-room" });
    nock(roomRate).post("/holds/hold-room/confirm").reply(200, { status: "confirmed" });

    const publishEvent = jest.fn().mockRejectedValue(new Error("broker down"));
    const response = await request(createApp({ db: pool, publishEvent }))
      .post("/reservations")
      .send({ ...reservationPayload, guests: 2, additionalGuests: [{ name: "Grace Hopper", idDocument: "X9876543" }] });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ roomNumber: "101", guests: 2 });
    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      guestEmail: "guest@example.com",
      roomNumber: "101",
    }));

    const stored = await request(createApp({ db: pool }))
      .get(`/reservations/${response.body.reservationNo}`)
      .set("x-user-role", "manager");
    expect(stored.body).toMatchObject({ roomId: "room-101", roomNumber: "101", status: "pending" });
    expect(stored.body.additionalGuests).toEqual([{ position: 2, name: "Grace Hopper", idDocument: "X9876543" }]);

    const asAgent = await request(createApp({ db: pool }))
      .get(`/reservations/${response.body.reservationNo}`)
      .set("x-user-role", "agent");
    expect(asAgent.body.additionalGuests[0].idDocument).toBe("****6543");
  });

  it("rejects bookings that start in the past", async () => {
    const app = createApp({ db: pool, publishEvent: jest.fn(), clock: () => new Date("2027-03-11T09:00:00") });

    const response = await request(app).post("/reservations").send(reservationPayload);

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/past/);
  });

  it("returns 409 instead of a server error when the room is taken between search and hold", async () => {
    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
      });
    nock(roomRate).post("/holds").reply(409, { error: "Conflict" });

    const response = await request(createApp({ db: pool, publishEvent: jest.fn() }))
      .post("/reservations")
      .send(reservationPayload);

    expect(response.status).toBe(409);
  });

  it("refunds the deposit difference when a modification makes the stay cheaper", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, deposit_net, currency, status)
       VALUES ('R-SHORTER', 'guest-1', 'standard', 'hold-old', '2027-03-10', '2027-03-14',
               400, 'deposit-old', 120, 120, 'USD', 'confirmed')`,
    );
    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-shorter", roomId: "room-101", roomNumber: "101" });
    nock(roomRate).post("/holds/hold-shorter/confirm").reply(200, {});
    const refund = nock(billing)
      .post("/refunds", { depositId: "deposit-old", amount: 60, currency: "USD" })
      .reply(201, { refundId: "refund-shorter" });
    nock(roomRate).delete("/holds/hold-old").reply(204);
    nock(guestService).get("/guests/guest-1").reply(200, { email: "guest@example.com" });
    const publishNotification = jest.fn().mockResolvedValue(undefined);

    const response = await request(createApp({ db: pool, publishNotification }))
      .put("/reservations/R-SHORTER")
      .send({ roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-12" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ totalAmount: 200, depositHeld: 60 });
    expect(refund.isDone()).toBe(true);
    expect(publishNotification).toHaveBeenCalledWith(
      "ReservationModified",
      expect.objectContaining({ guestEmail: "guest@example.com", checkOut: "2027-03-12" }),
    );

    const ledger = await pool.query(
      "SELECT type, amount::float AS amount, deposit_ref FROM reservation_payments WHERE reservation_no = 'R-SHORTER'",
    );
    expect(ledger.rows).toEqual([{ type: "refund", amount: 60, deposit_ref: "deposit-old" }]);
  });

  it("returns 402 and keeps the reservation when a modification top-up is declined", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, currency, status)
       VALUES ('R-DECLINE', 'guest-1', 'standard', 'hold-keep', '2027-03-10', '2027-03-12',
               200, 60, 'USD', 'confirmed')`,
    );
    nock(roomRate)
      .get("/availability")
      .query(true)
      .reply(200, {
        availability: [{ roomTypeId: "standard", available: true, roomsAvailable: 1, nightlyRate: 100, currency: "USD" }],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-longer" });
    nock(roomRate).post("/holds/hold-longer/confirm").reply(200, {});
    nock(billing).post("/deposits").reply(402, { error: "PaymentDeclined" });
    const releaseNew = nock(roomRate).delete("/holds/hold-longer").reply(204);

    const response = await request(createApp({ db: pool }))
      .put("/reservations/R-DECLINE")
      .send({ roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-15" });

    expect(response.status).toBe(402);
    expect(releaseNew.isDone()).toBe(true);
    const row = await pool.query("SELECT hold_id, to_char(check_out, 'YYYY-MM-DD') AS check_out FROM reservations WHERE reservation_no = 'R-DECLINE'");
    expect(row.rows[0]).toEqual({ hold_id: "hold-keep", check_out: "2027-03-12" });
  });

  it("does not cancel or modify a stay that has already ended", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_amount, currency, status)
       VALUES ('R-PAST', 'guest-1', 'standard', 'hold-past', '2027-03-10', '2027-03-12',
               200, 60, 'USD', 'confirmed')`,
    );
    const app = createApp({ db: pool, clock: () => new Date("2027-03-12T10:00:00") });

    expect((await request(app).delete("/reservations/R-PAST")).status).toBe(409);
    expect((await request(app).put("/reservations/R-PAST").send({
      roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-13",
    })).status).toBe(409);
  });

  it("applies the partial policy using the stored check-in date and notifies the guest", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, currency, status)
       VALUES ('R-PARTIAL', 'guest-1', 'standard', 'hold-partial', '2027-03-10', '2027-03-12',
               200, 'deposit-partial', 60, 'USD', 'confirmed')`,
    );
    const refund = nock(billing)
      .post("/refunds", { depositId: "deposit-partial", amount: 30, currency: "USD" })
      .reply(201, { refundId: "refund-partial" });
    nock(roomRate).delete("/holds/hold-partial").reply(204);
    nock(guestService).get("/guests/guest-1").reply(200, { email: "guest@example.com", firstName: "Ada" });
    const publishNotification = jest.fn().mockResolvedValue(undefined);

    const response = await request(createApp({
      db: pool,
      publishNotification,
      cancellationPolicy: createCancellationPolicy({ name: "partial" }),
      clock: () => new Date("2027-03-01T10:00:00Z"),
    })).delete("/reservations/R-PARTIAL");

    expect(response.status).toBe(204);
    expect(refund.isDone()).toBe(true);
    expect(publishNotification).toHaveBeenCalledWith(
      "ReservationCancelled",
      expect.objectContaining({
        guestEmail: "guest@example.com",
        checkIn: "2027-03-10",
        refundAmount: 30,
        cancellationFee: 30,
      }),
    );
    const row = await pool.query("SELECT status, refund_amount::float AS refund FROM reservations WHERE reservation_no = 'R-PARTIAL'");
    expect(row.rows[0]).toEqual({ status: "cancelled", refund: 30 });
  });

  it("keeps the reservation confirmed when the refund fails during cancellation", async () => {
    await pool.query(
      `INSERT INTO reservations
        (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
         total_amount, deposit_id, deposit_amount, currency, status)
       VALUES ('R-REFUND-FAIL', 'guest-1', 'standard', 'hold-rf', '2027-03-10', '2027-03-12',
               200, 'deposit-rf', 60, 'USD', 'confirmed')`,
    );
    nock(billing).post("/refunds").reply(500, {});

    const response = await request(createApp({ db: pool })).delete("/reservations/R-REFUND-FAIL");

    expect(response.status).toBe(500);
    const row = await pool.query("SELECT status FROM reservations WHERE reservation_no = 'R-REFUND-FAIL'");
    expect(row.rows[0].status).toBe("confirmed");
  });

  const insertReservation = (no, status = "confirmed", extra = "") => pool.query(
    `INSERT INTO reservations
      (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
       total_amount, deposit_id, deposit_amount, currency, status)
     VALUES ($1, 'guest-1', 'standard', $2, '2027-03-10', '2027-03-12',
             200, $3, 60, 'USD', $4)`,
    [no, `hold-${no}`, `deposit-${no}`, status],
  ).then(() => extra && pool.query(extra, [no]));

  it("requires a passport or ID number to book", async () => {
    const response = await request(createApp({ db: pool, publishEvent: jest.fn() }))
      .post("/reservations")
      .send({ ...reservationPayload, guest: { ...reservationPayload.guest, idDocument: "  " } });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/passport/i);
  });

  it("confirms a pending reservation when its payment is approved", async () => {
    await insertReservation("R-PAY", "pending");
    const app = createApp({ db: pool, clock: () => new Date("2027-03-01T10:00:00Z") });

    const approved = await request(app).post("/reservations/R-PAY/payment-approved");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "confirmed", confirmedAt: expect.any(String) });

    const again = await request(app).post("/reservations/R-PAY/payment-approved");
    expect(again.status).toBe(200);

    await insertReservation("R-PAY-CANCELLED", "cancelled");
    expect((await request(app).post("/reservations/R-PAY-CANCELLED/payment-approved")).status).toBe(409);
    expect((await request(app).post("/reservations/R-NONE/payment-approved")).status).toBe(404);
  });

  it("lets a guest cancel only while the booking is pending", async () => {
    await insertReservation("R-GUEST-CONFIRMED", "confirmed");
    await insertReservation("R-GUEST-PENDING", "pending");
    nock(billing).post("/refunds").reply(201, { refundId: "r-1" });
    nock(roomRate).delete("/holds/hold-R-GUEST-PENDING").reply(204);
    const app = createApp({ db: pool, clock: () => new Date("2027-03-01T10:00:00Z") });

    const confirmed = await request(app).delete("/reservations/R-GUEST-CONFIRMED").set("x-user-role", "guest");
    const pending = await request(app).delete("/reservations/R-GUEST-PENDING").set("x-user-role", "guest");

    expect(confirmed.status).toBe(403);
    expect(pending.status).toBe(204);
    const rows = await pool.query("SELECT reservation_no, status FROM reservations ORDER BY reservation_no");
    expect(rows.rows).toEqual([
      { reservation_no: "R-GUEST-CONFIRMED", status: "confirmed" },
      { reservation_no: "R-GUEST-PENDING", status: "cancelled" },
    ]);
  });

  it("checks a guest in and out, recording both times and settling the bill", async () => {
    await insertReservation("R-STAY", "confirmed");
    let now = new Date("2027-03-10T14:05:00Z");
    const publishNotification = jest.fn().mockResolvedValue(undefined);
    const app = createApp({ db: pool, clock: () => now, publishNotification });
    const staff = (path, body) =>
      request(app).post(path).set("x-user-role", "agent").set("x-user-id", "reception").send(body);
    nock(guestService).get("/guests/guest-1").times(2).reply(200, { email: "guest@example.com" });

    expect((await staff("/reservations/R-STAY/check-out")).status).toBe(409);

    const checkedIn = await staff("/reservations/R-STAY/check-in");
    expect(checkedIn.status).toBe(200);
    expect(new Date(checkedIn.body.checkedInAt).toISOString()).toBe("2027-03-10T14:05:00.000Z");
    expect(checkedIn.body.checkedOutAt).toBeNull();
    expect((await staff("/reservations/R-STAY/check-in")).status).toBe(409);
    expect(publishNotification).toHaveBeenCalledWith("ReservationModified", expect.objectContaining({ event: "ReservationCheckedIn" }));

    // Total 200, deposit 60 applied, 100 approved by proof: 40 is still owed.
    now = new Date("2027-03-11T10:30:00");
    nock(billing).get("/payments/reservations/R-STAY/totals").times(2).reply(200, { approvedTotal: 100 });
    const owing = await staff("/reservations/R-STAY/check-out");
    expect(owing.status).toBe(409);
    expect(owing.body).toMatchObject({ error: "BalanceDue", balanceDue: 40 });

    const capture = nock(billing).post("/deposits/capture", { reservationNo: "R-STAY" }).reply(200, { captured: [] });
    const settle = nock(billing)
      .post("/settlements", { reservationNo: "R-STAY", guestId: "guest-1", amount: 40, currency: "USD" })
      .reply(201, { id: "11111111-1111-1111-1111-111111111111", paymentNo: "TXN-000009" });
    const freeNights = nock(roomRate).post("/holds/hold-R-STAY/complete", { checkOut: "2027-03-11" }).reply(200, {});

    const checkedOut = await staff("/reservations/R-STAY/check-out", { collectBalance: true });
    expect(checkedOut.status).toBe(200);
    expect(new Date(checkedOut.body.checkedOutAt).toISOString()).toBe(new Date("2027-03-11T10:30:00").toISOString());
    expect(checkedOut.body.statement).toEqual({
      totalAmount: 200, depositApplied: 60, approvedPayments: 100, collectedAtDesk: 40,
      settlementPaymentNo: "TXN-000009", balanceDue: 0, currency: "USD",
    });
    expect(capture.isDone() && settle.isDone() && freeNights.isDone()).toBe(true);
    expect(publishNotification).toHaveBeenCalledWith("ReservationModified", expect.objectContaining({ event: "ReservationCheckedOut" }));
    expect((await staff("/reservations/R-STAY/check-out")).status).toBe(409);

    const stored = await pool.query(
      "SELECT checked_in_by, checked_out_by, balance_collected::float AS collected FROM reservations WHERE reservation_no = 'R-STAY'",
    );
    expect(stored.rows[0]).toEqual({ checked_in_by: "reception", checked_out_by: "reception", collected: 40 });
    const ledger = await pool.query("SELECT type, amount::float AS amount FROM reservation_payments WHERE reservation_no = 'R-STAY'");
    expect(ledger.rows).toEqual([{ type: "settlement", amount: 40 }]);

    nock(billing).get("/payments/reservations/R-STAY/totals").reply(200, { approvedTotal: 100 });
    const summary = await request(app).get("/reservations/R-STAY/payment-summary");
    expect(summary.body).toMatchObject({ settledAtDesk: 40, balanceDue: 0 });

    expect((await request(app).delete("/reservations/R-STAY").set("x-user-role", "manager")).status).toBe(409);
  });

  it("undoes the check-out when the bill cannot be settled", async () => {
    await insertReservation("R-STAY-FAIL", "confirmed", "UPDATE reservations SET checked_in_at = NOW() - interval '1 hour' WHERE reservation_no = $1");
    nock(billing).get("/payments/reservations/R-STAY-FAIL/totals").reply(200, { approvedTotal: 140 });
    nock(billing).post("/deposits/capture").reply(500, {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(createApp({ db: pool }))
      .post("/reservations/R-STAY-FAIL/check-out")
      .set("x-user-role", "agent");

    expect(response.status).toBe(500);
    const row = await pool.query("SELECT checked_out_at FROM reservations WHERE reservation_no = 'R-STAY-FAIL'");
    expect(row.rows[0].checked_out_at).toBeNull();
  });

  it("asks for every guest's name and ID and lets the guest change bookings only while pending", async () => {
    const app = createApp({ db: pool, publishEvent: jest.fn() });
    const missing = await request(app).post("/reservations").send({ ...reservationPayload, guests: 3, additionalGuests: [{ name: "Only One", idDocument: "A1" }] });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("each of the 3 guests");

    await insertReservation("R-PENDING-EDIT", "pending");
    await insertReservation("R-CONFIRMED-EDIT", "confirmed");
    const guestApp = createApp({ db: pool, publishNotification: jest.fn(), clock: () => new Date("2027-03-01T10:00:00Z") });
    const confirmed = await request(guestApp).put("/reservations/R-CONFIRMED-EDIT").set("x-user-role", "guest")
      .send({ roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-13" });
    expect(confirmed.status).toBe(403);

    const tooFew = await request(guestApp).put("/reservations/R-PENDING-EDIT").set("x-user-role", "guest")
      .send({ roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-12", guests: 2 });
    expect(tooFew.status).toBe(400);

    nock(guestService).get("/guests/guest-1").reply(200, { email: "guest@example.com" });
    const named = await request(guestApp).put("/reservations/R-PENDING-EDIT").set("x-user-role", "guest")
      .send({ roomTypeId: "standard", checkIn: "2027-03-10", checkOut: "2027-03-12", additionalGuests: [] });
    expect(named.status).toBe(200);
  });

  it("refuses check-in for unpaid, early or guest requests", async () => {
    await insertReservation("R-UNPAID", "pending");
    await insertReservation("R-EARLY", "confirmed");
    const app = createApp({ db: pool, clock: () => new Date("2027-03-09T12:00:00") });

    const unpaid = await request(app).post("/reservations/R-UNPAID/check-in").set("x-user-role", "agent");
    const early = await request(app).post("/reservations/R-EARLY/check-in").set("x-user-role", "agent");
    const byGuest = await request(app).post("/reservations/R-EARLY/check-in").set("x-user-role", "guest");

    expect(unpaid.status).toBe(409);
    expect(unpaid.body.message).toMatch(/payment/);
    expect(early.status).toBe(409);
    expect(byGuest.status).toBe(403);
  });

  it("counts bookings per guest", async () => {
    await insertReservation("R-C1", "pending");
    await insertReservation("R-C2", "cancelled");
    await insertReservation("R-C3", "confirmed", "UPDATE reservations SET checked_in_at = NOW() - interval '2 days', checked_out_at = NOW() WHERE reservation_no = $1");

    const response = await request(createApp({ db: pool })).get("/reservations/guest-counts");

    expect(response.status).toBe(200);
    expect(response.body.counts).toEqual([{ guestId: "guest-1", total: 3, active: 1, completed: 1, cancelled: 1 }]);
  });

  it("cancels the booking's payment proofs and tells the guest", async () => {
    await insertReservation("R-CXL-PAY", "confirmed");
    nock(billing).post("/refunds").reply(201, { refundId: "r-1" });
    nock(roomRate).delete("/holds/hold-R-CXL-PAY").reply(204);
    const proofs = nock(billing)
      .post("/payments/reservations/R-CXL-PAY/cancel")
      .reply(200, { cancelledProofs: ["PMT-000010"], refundDue: [{ paymentNo: "PMT-000009", amount: 140 }], refundDueTotal: 140 });
    nock(guestService).get("/guests/guest-1").reply(200, { email: "guest@example.com" });
    const publishNotification = jest.fn().mockResolvedValue(undefined);

    const response = await request(createApp({ db: pool, publishNotification, clock: () => new Date("2027-03-01T10:00:00Z") }))
      .delete("/reservations/R-CXL-PAY")
      .set("x-user-role", "agent");

    expect(response.status).toBe(204);
    expect(proofs.isDone()).toBe(true);
    expect(publishNotification).toHaveBeenCalledWith("ReservationCancelled", expect.objectContaining({
      cancelledProofs: ["PMT-000010"],
      proofRefundDue: 140,
    }));
  });

  it("still cancels when billing is unreachable, and retries the proof cancellation later", async () => {
    await insertReservation("R-CXL-RETRY", "confirmed");
    nock(billing).post("/refunds").reply(201, { refundId: "r-2" });
    nock(roomRate).delete("/holds/hold-R-CXL-RETRY").times(2).reply(204);
    nock(billing).post("/payments/reservations/R-CXL-RETRY/cancel").reply(500, {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ db: pool, clock: () => new Date("2027-03-01T10:00:00Z") });

    expect((await request(app).delete("/reservations/R-CXL-RETRY").set("x-user-role", "agent")).status).toBe(204);

    const retry = nock(billing).post("/payments/reservations/R-CXL-RETRY/cancel").reply(200, { cancelledProofs: [], refundDue: [], refundDueTotal: 0 });
    expect((await request(app).delete("/reservations/R-CXL-RETRY").set("x-user-role", "agent")).status).toBe(409);
    expect(retry.isDone()).toBe(true);
  });
});

