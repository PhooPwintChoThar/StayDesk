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
  guest: { email: "guest@example.com", firstName: "Test", lastName: "Guest" },
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
      status: "confirmed",
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
      .reply(201, { id: 'hold-new' });

    nock(roomRate).post('/holds/hold-new/confirm').reply(200, { status: 'confirmed' });
    const topUp = nock(billing)
      .post('/deposits', (body) =>
        body.reservationNo === 'R-MODIFY-SWAP' &&
        body.guestId === 'guest-1' &&
        body.amount === 200 &&
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
      depositHeld: 250,
    });
    expect(availability.isDone()).toBe(true);
    expect(hold.isDone()).toBe(true);
    expect(topUp.isDone()).toBe(true);
    expect(release.isDone()).toBe(true);
  });
});
