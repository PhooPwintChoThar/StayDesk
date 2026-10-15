import { readFile } from "node:fs/promises";
import nock from "nock";
import request from "supertest";
import { createApp } from "../app.js";
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
  depositAmount: 50,
  currency: "USD",
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
  await pool.query("TRUNCATE reservations");
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
          },
        ],
      });
    nock(roomRate).post("/holds").reply(201, { id: "hold-1" });
    nock(guestService)
      .post("/guests/get-or-create")
      .reply(201, { id: "guest-1" });
    nock(billing)
      .post(
        "/deposits",
        (body) => body.reservationNo && body.guestId === "guest-1",
      )
      .reply(201, { id: "deposit-1", status: "authorized" });
    nock(roomRate)
      .post("/holds/hold-1/confirm")
      .reply(200, { status: "confirmed" });

    const response = await request(app)
      .post("/reservations")
      .send(reservationPayload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      guestId: "guest-1",
      roomTypeId: "standard",
      totalAmount: 200,
      status: "confirmed",
    });
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationNo: response.body.reservationNo,
        guestId: "guest-1",
      }),
    );
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
});
