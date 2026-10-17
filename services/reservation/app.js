import { randomUUID } from "node:crypto";
import axios from "axios";
import express from "express";
import { pool } from "./db.js";
import { HttpError, runSaga } from "./saga.js";
import { createCancellationPolicy } from "./cancellation-policy.js";

const DEPOSIT_PERCENT = 30;

const url = (names, fallback) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name].replace(/\/$/, "");
  }
  return fallback;
};

const roomRateUrl = () =>
  url(["ROOM_RATE_URL", "ROOM_RATE_SERVICE_URL"], "http://room-rate:3000");
const guestUrl = () =>
  url(["GUEST_URL", "GUEST_SERVICE_URL"], "http://guest:3000");
const billingUrl = () =>
  url(["BILLING_URL", "BILLING_SERVICE_URL"], "http://billing:3000");

function validDates(checkIn, checkOut) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(checkIn ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(checkOut ?? "")
  )
    return false;

  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start.toISOString().slice(0, 10) === checkIn &&
    end.toISOString().slice(0, 10) === checkOut &&
    end > start
  );
}

function totalPrice(nightlyRate, checkIn, checkOut) {
  const nights =
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) /
    86_400_000;
  return Math.round(Number(nightlyRate) * nights * 100) / 100;
}

function depositPrice(amount) {
  return Math.round(((amount * DEPOSIT_PERCENT) / 100) * 100) / 100;
}

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function parseGuests(value) {
  if (value == null || value === "") return null;
  const guests = Number(value);
  return Number.isInteger(guests) && guests >= 1 ? guests : undefined;
}

function actorFromRequest(req) {
  return {
    id: req.headers["x-user-id"] || null,
    role: req.headers["x-user-role"] || null,
  };
}

function depositHeldValue(reservation) {
  return Number(
    reservation.depositHeld ??
    reservation.deposit_net ??
    reservation.depositAmount ??
    reservation.deposit_amount ??
    0,
  );
}

function currencyValue(reservation) {
  return String(reservation.currency ?? "USD").trim();
}

function quoteFromHours(hoursBeforeCheckIn, heldAmount, overridePercent) {
  const effectivePercent = overridePercent ?? (hoursBeforeCheckIn >= 48 ? 100 : hoursBeforeCheckIn >= 24 ? 50 : 0);
  const refundAmount = Math.round((Number(heldAmount) * effectivePercent) * 100) / 10000;
  const feeAmount = Math.round((Number(heldAmount) - refundAmount) * 100) / 100;
  return { refundAmount, feeAmount };
}

async function loadReservation(db, reservationNo) {
  const result = await db.query(
    `SELECT ${reservationSelect},
            cancelled_at AS "cancelledAt", refund_amount::float AS "refundAmount",
            cancellation_fee::float AS "cancellationFee"
     FROM reservations
     WHERE reservation_no = $1`,
    [reservationNo],
  );
  return result.rows[0] || null;
}

async function loadPaymentSources(db, reservation) {
  const result = await db.query(
    `SELECT rp.id,
            rp.billing_payment_id AS "billingPaymentId",
            rp.type,
            rp.amount::float AS amount,
            rp.currency,
            rp.created_at AS "createdAt",
            COALESCE((
              SELECT SUM(r.amount)::float
              FROM reservation_payments r
              WHERE r.reservation_no = rp.reservation_no
                AND r.type IN ('refund', 'cancellation_refund')
                AND r.deposit_ref = rp.billing_payment_id
            ), 0)::float AS refunded
     FROM reservation_payments rp
     WHERE rp.reservation_no = $1
       AND rp.type IN ('deposit', 'topup')
     ORDER BY rp.created_at DESC, rp.id DESC`,
    [reservation.reservation_no],
  );
  if (result.rowCount === 0 && reservation.deposit_id) {
    return [{
      id: `legacy-${reservation.deposit_id}`,
      billingPaymentId: reservation.deposit_id,
      type: 'deposit',
      amount: Number(reservation.deposit_amount),
      currency: reservation.currency,
      createdAt: reservation.created_at,
      refunded: 0,
    }];
  }
  return result.rows;
}

function allocateRefundAmount(sources, amount) {
  let remaining = Number(amount);
  const allocations = [];

  for (const source of sources) {
    if (remaining <= 0) break;
    const available = Math.max(0, Number(source.amount) - Number(source.refunded || 0));
    if (available <= 0) continue;
    const used = Math.min(remaining, available);
    allocations.push({ source, amount: used });
    remaining = Math.round((remaining - used) * 100) / 100;
  }

  if (remaining > 0) {
    throw new Error('Held amount is inconsistent with recorded deposits.');
  }

  return allocations;
}

async function writeLedgerRow(client, {
  reservationNo,
  type,
  billingPaymentId,
  depositRef,
  amount,
  currency,
  reason,
  actor,
}) {
  await client.query(
    `INSERT INTO reservation_payments (
      id, reservation_no, type, billing_payment_id, deposit_ref,
      amount, currency, reason, actor_id, actor_role
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      reservationNo,
      type,
      billingPaymentId ?? null,
      depositRef ?? null,
      amount,
      currency,
      reason ?? null,
      actor.id,
      actor.role,
    ],
  );
}

async function authorizeTopUp({ http, reservationNo, guestId, amount, currency }) {
  const response = await http.post(`${billingUrl()}/deposits`, {
    reservationNo,
    guestId,
    amount,
    currency,
  });
  return response.data.id ?? response.data.depositId;
}

async function refundAcrossSources({ http, reservationNo, sources, amount, currency }) {
  const allocations = allocateRefundAmount(sources, amount);
  const refunds = [];

  for (const allocation of allocations) {
    const response = await http.post(`${billingUrl()}/refunds`, {
      depositId: allocation.source.billingPaymentId,
      amount: allocation.amount,
      currency,
    });
    refunds.push({
      source: allocation.source,
      amount: allocation.amount,
      refundId: response.data.refundId ?? response.data.id,
    });
  }

  return refunds;
}

const reservationSelect = `
  reservation_no AS "reservationNo", guest_id AS "guestId",
  room_type_id AS "roomTypeId",
  to_char(check_in, 'YYYY-MM-DD') AS "checkIn",
  to_char(check_out, 'YYYY-MM-DD') AS "checkOut",
  total_amount::float AS "totalAmount",
  deposit_id AS "depositId", deposit_amount::float AS "depositAmount",
  COALESCE(deposit_net, deposit_amount)::float AS "depositHeld",
  currency, status, guests
`;

async function publishConfirmed(payload) {
  const amqp = await import("amqplib");
  const connection = await amqp.connect(
    process.env.RABBITMQ_URL || "amqp://localhost:5672",
  );

  try {
    const channel = await connection.createChannel();
    await channel.assertQueue("ReservationConfirmed", { durable: true });
    channel.sendToQueue(
      "ReservationConfirmed",
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
    );
    await channel.close();
  } finally {
    await connection.close();
  }
}

export function createApp({
  db = pool,
  http = axios,
  publishEvent = publishConfirmed,
  cancellationPolicy = createCancellationPolicy(),
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const required = process.env.INTERNAL_TOKEN;
    if (!required || req.headers['x-internal-token'] === required) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  const releaseHold = async (id) => {
    if (!id) return;
    try {
      await http.delete(`${roomRateUrl()}/holds/${id}`);
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404 && status !== 409) throw err;
    }
  };

  async function findAvailability(checkIn, checkOut, roomTypeId, guests, excludeHoldId) {
    const availabilityResult = await http.get(`${roomRateUrl()}/availability`, {
      params: {
        checkIn,
        checkOut,
        roomTypeId,
        guests: guests || undefined,
        excludeHoldId: excludeHoldId || undefined,
      },
    });
    return availabilityResult.data.availability?.find(
      (item) => item.roomTypeId === roomTypeId,
    );
  }

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.post("/reservations", async (req, res, next) => {
    const { guest, roomTypeId, checkIn, checkOut, channel } = req.body ?? {};
    const guests = parseGuests(req.body?.guests);
    const actor = actorFromRequest(req);

    if (!guest || !roomTypeId || !validDates(checkIn, checkOut) || guests === undefined) {
      return fail(
        res,
        400,
        "BadRequest",
        "Valid guest, room type, and dates are required.",
      );
    }

    const reservationNo = `R-${randomUUID()}`;

    try {
      const result = await runSaga([
        {
          async execute() {
            const availability = await findAvailability(
              checkIn,
              checkOut,
              roomTypeId,
              guests,
            );
            if (!availability?.available || availability.roomsAvailable < 1) {
              throw new HttpError(
                409,
                "Conflict",
                "No rooms are available for those dates.",
              );
            }
            const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
            return {
              amount,
              depositAmount: depositPrice(amount),
              currency: availability.currency,
            };
          },
        },
        {
          async execute() {
            const holdResult = await http.post(`${roomRateUrl()}/holds`, {
              roomTypeId,
              checkIn,
              checkOut,
            });
            return { holdId: holdResult.data.id };
          },
          async compensate(ctx) {
            await releaseHold(ctx.holdId);
          },
        },
        {
          async execute() {
            const guestResult = await http.post(
              `${guestUrl()}/guests/get-or-create`,
              guest,
            );
            return {
              guestId: guestResult.data.id,
              guestEmail: guestResult.data.email || guest.email,
              guestPhone: guestResult.data.phone || guest.phone,
            };
          },
        },
        {
          async execute(ctx) {
            try {
              const depositResult = await http.post(`${billingUrl()}/deposits`, {
                reservationNo,
                guestId: ctx.guestId,
                amount: ctx.depositAmount,
                currency: ctx.currency,
              });
              return {
                depositId: depositResult.data.id ?? depositResult.data.depositId,
              };
            } catch (err) {
              if (err.response?.status === 402) {
                throw new HttpError(
                  402,
                  "PaymentDeclined",
                  "The deposit was declined.",
                );
              }
              throw err;
            }
          },
          async compensate(ctx) {
            if (!ctx.depositId) return;
            await http.post(`${billingUrl()}/refunds`, {
              depositId: ctx.depositId,
              amount: ctx.depositAmount,
              currency: ctx.currency,
            });
          },
        },
        {
          async execute(ctx) {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `INSERT INTO reservations
                  (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
                   total_amount, deposit_id, deposit_amount, deposit_net, currency, status, guests)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'confirmed', $12)`,
                [
                  reservationNo,
                  ctx.guestId,
                  roomTypeId,
                  ctx.holdId,
                  checkIn,
                  checkOut,
                  ctx.amount,
                  ctx.depositId,
                  ctx.depositAmount,
                  ctx.depositAmount,
                  ctx.currency,
                  guests,
                ],
              );
              await writeLedgerRow(client, {
                reservationNo,
                type: 'deposit',
                billingPaymentId: ctx.depositId,
                amount: ctx.depositAmount,
                currency: ctx.currency,
                reason: 'initial',
                actor,
              });
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            } finally {
              client.release();
            }
            return { saved: true };
          },
          async compensate() {
            await db.query("DELETE FROM reservations WHERE reservation_no = $1", [
              reservationNo,
            ]);
          },
        },
        {
          async execute(ctx) {
            await http.post(`${roomRateUrl()}/holds/${ctx.holdId}/confirm`);
          },
        },
        {
          async execute(ctx) {
            await publishEvent({
              reservationNo,
              guestId: ctx.guestId,
              guestEmail: ctx.guestEmail,
              guestPhone: ctx.guestPhone,
              roomTypeId,
              checkIn,
              checkOut,
              totalAmount: ctx.amount,
              currency: ctx.currency,
              channel: channel === "sms" ? "sms" : "email",
              confirmedAt: new Date().toISOString(),
            });
          },
        },
      ]);

      return res.status(201).json({
        reservationNo,
        guestId: result.guestId,
        roomTypeId,
        checkIn,
        checkOut,
        totalAmount: result.amount,
        depositAmount: result.depositAmount,
        depositHeld: result.depositAmount,
        currency: result.currency,
        guests,
        status: "confirmed",
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.error, error.message);
      }
      console.error(error);
      return next(error);
    }
  });

  app.get("/reservations", async (req, res, next) => {
    const { guestId, status, from, to } = req.query;
    const isDate = (value) =>
      value == null || value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value);

    if (!isDate(from) || !isDate(to)) {
      return fail(
        res,
        400,
        "BadRequest",
        "from and to must be YYYY-MM-DD dates.",
      );
    }

    try {
      const result = await db.query(
        `SELECT ${reservationSelect}
         FROM reservations
         WHERE ($1::text IS NULL OR guest_id = $1)
           AND ($2::text IS NULL OR status = $2)
           AND ($3::date IS NULL OR check_out > $3::date)
           AND ($4::date IS NULL OR check_in < $4::date)
         ORDER BY check_in DESC, created_at DESC`,
        [guestId || null, status || null, from || null, to || null],
      );
      return res.status(200).json({ reservations: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/reservations/:no", async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT ${reservationSelect} FROM reservations WHERE reservation_no = $1`,
        [req.params.no],
      );

      if (!result.rowCount)
        return fail(res, 404, "NotFound", "Reservation not found.");
      return res.status(200).json(result.rows[0]);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/reservations/:no/cancellation-quote", async (req, res, next) => {
    try {
      const reservation = await loadReservation(db, req.params.no);
      if (!reservation) {
        return fail(res, 404, "NotFound", "Reservation not found.");
      }

      const heldAmount = depositHeldValue(reservation);
      const now = new Date();
      const checkIn = new Date(`${reservation.checkIn}T00:00:00Z`);
      const hoursBeforeCheckIn = Math.max(0, Math.round((checkIn.getTime() - now.getTime()) / 3_600_000));
      const percent = cancellationPolicy.refundPercent(reservation.checkIn, now);
      const refundAmount = Math.round((heldAmount * percent) * 100) / 10000;
      const feeAmount = Math.round((heldAmount - refundAmount) * 100) / 100;

      return res.status(200).json({
        refundAmount,
        feeAmount,
        currency: currencyValue(reservation),
        rule: cancellationPolicy.name || "full",
        hoursBeforeCheckIn,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/reservations/:no", async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut } = req.body ?? {};
    const guests = parseGuests(req.body?.guests);
    const actor = actorFromRequest(req);

    if (!roomTypeId || !validDates(checkIn, checkOut) || guests === undefined) {
      return fail(
        res,
        400,
        "BadRequest",
        "Valid room type and dates are required.",
      );
    }

    try {
      const found = await db.query(
        "SELECT * FROM reservations WHERE reservation_no = $1",
        [req.params.no],
      );
      if (!found.rowCount)
        return fail(res, 404, "NotFound", "Reservation not found.");

      const current = found.rows[0];
      if (current.status !== "confirmed") {
        return fail(
          res,
          409,
          "Conflict",
          "Only confirmed reservations can be modified.",
        );
      }

      const currentHeld = depositHeldValue(current);

      const result = await runSaga([
        {
          async execute() {
            const availability = await findAvailability(
              checkIn,
              checkOut,
              roomTypeId,
              guests ?? current.guests,
              current.hold_id,
            );
            if (!availability?.available || availability.roomsAvailable < 1) {
              throw new HttpError(
                409,
                "Conflict",
                "No rooms are available for those dates.",
              );
            }
            const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
            return {
              amount,
              delta: Math.round((amount - currentHeld) * 100) / 100,
            };
          },
        },
        {
          async execute() {
            const holdResult = await http.post(`${roomRateUrl()}/holds`, {
              roomTypeId,
              checkIn,
              checkOut,
              excludeHoldId: current.hold_id,
            });
            return { newHoldId: holdResult.data.id };
          },
          async compensate(ctx) {
            await releaseHold(ctx.newHoldId);
          },
        },
        {
          async execute(ctx) {
            await http.post(`${roomRateUrl()}/holds/${ctx.newHoldId}/confirm`);
            if (ctx.delta > 0) {
              const topUpPaymentId = await authorizeTopUp({
                http,
                reservationNo: req.params.no,
                guestId: current.guest_id,
                amount: ctx.delta,
                currency: current.currency,
              });
              return { topUpPaymentId };
            }

            if (ctx.delta < 0) {
              const sources = await loadPaymentSources(db, current);
              const refunds = await refundAcrossSources({
                http,
                reservationNo: req.params.no,
                sources,
                amount: Math.abs(ctx.delta),
                currency: current.currency,
              });
              return { refunds };
            }

            return {};
          },
        },
        {
          async execute(ctx) {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              const newDepositHeld = Math.round((currentHeld + ctx.delta) * 100) / 100;
              const updated = await client.query(
                `UPDATE reservations
                 SET room_type_id = $2, hold_id = $3, check_in = $4,
                     check_out = $5, total_amount = $6, deposit_net = $7,
                     guests = COALESCE($8, guests)
                 WHERE reservation_no = $1
                 RETURNING ${reservationSelect}`,
                [
                  req.params.no,
                  roomTypeId,
                  ctx.newHoldId,
                  checkIn,
                  checkOut,
                  ctx.amount,
                  newDepositHeld,
                  guests,
                ],
              );

              if (ctx.topUpPaymentId) {
                await writeLedgerRow(client, {
                  reservationNo: req.params.no,
                  type: 'topup',
                  billingPaymentId: ctx.topUpPaymentId,
                  amount: ctx.delta,
                  currency: current.currency,
                  reason: 'modify_increase',
                  actor,
                });
              }

              if (ctx.refunds?.length) {
                for (const refund of ctx.refunds) {
                  await writeLedgerRow(client, {
                    reservationNo: req.params.no,
                    type: 'refund',
                    billingPaymentId: refund.refundId,
                    depositRef: refund.source.billingPaymentId,
                    amount: refund.amount,
                    currency: current.currency,
                    reason: 'modify_decrease',
                    actor,
                  });
                }
              }

              await client.query('COMMIT');
              return { updated: updated.rows[0] };
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              if (ctx.topUpPaymentId) {
                await http.post(`${billingUrl()}/refunds`, {
                  depositId: ctx.topUpPaymentId,
                  amount: ctx.delta,
                  currency: current.currency,
                }).catch(() => {});
              }
              throw error;
            } finally {
              client.release();
            }
          },
        },
        {
          async execute() {
            await releaseHold(current.hold_id);
          },
        },
      ]);

      return res.status(200).json(result.updated);
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.error, error.message);
      }
      console.error(error);
      return next(error);
    }
  });

  app.delete("/reservations/:no", async (req, res, next) => {
    try {
      const found = await db.query(
        "SELECT * FROM reservations WHERE reservation_no = $1",
        [req.params.no],
      );
      if (!found.rowCount)
        return fail(res, 404, "NotFound", "Reservation not found.");

      const reservation = found.rows[0];
      if (reservation.status !== "confirmed") {
        return fail(res, 409, "Conflict", "Reservation is already cancelled.");
      }

      const actor = actorFromRequest(req);
      const waiveFee = req.body?.waiveFee === true || req.body?.waiveFee === 'true';
      if (waiveFee && actor.role !== 'manager') {
        return fail(res, 403, "Forbidden", "Only managers can waive cancellation fees.");
      }

      const heldAmount = depositHeldValue(reservation);
      const percent = waiveFee ? 100 : cancellationPolicy.refundPercent(
        reservation.check_in,
        new Date(),
      );
      const refundAmount = Math.round((heldAmount * percent) * 100) / 10000;
      const feeAmount = Math.round((heldAmount - refundAmount) * 100) / 100;
      const sources = refundAmount > 0 ? await loadPaymentSources(db, reservation) : [];
      const refunds = refundAmount > 0
        ? await refundAcrossSources({
            http,
            reservationNo: req.params.no,
            sources,
            amount: refundAmount,
            currency: currencyValue(reservation),
          })
        : [];

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE reservations
           SET status = 'cancelled', cancelled_at = NOW(),
               refund_amount = $2, cancellation_fee = $3,
               deposit_net = $4
           WHERE reservation_no = $1`,
          [req.params.no, refundAmount, feeAmount, feeAmount],
        );

        for (const refund of refunds) {
          await writeLedgerRow(client, {
            reservationNo: req.params.no,
            type: 'cancellation_refund',
            billingPaymentId: refund.refundId,
            depositRef: refund.source.billingPaymentId,
            amount: refund.amount,
            currency: currencyValue(reservation),
            reason: waiveFee ? 'waived_fee' : 'policy',
            actor,
          });
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      await releaseHold(reservation.hold_id);
      return res.status(204).end();
    } catch (error) {
      console.error(error);
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred.",
    });
  });

  return app;
}

export const app = createApp();
