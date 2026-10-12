import { randomUUID } from 'node:crypto';
import axios from 'axios';
import express from 'express';
import { pool } from './db.js';

const url = (names, fallback) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name].replace(/\/$/, '');
  }
  return fallback;
};

const roomRateUrl = () => url(
  ['ROOM_RATE_URL', 'ROOM_RATE_SERVICE_URL'],
  'http://room-rate:3000'
);
const guestUrl = () => url(['GUEST_URL', 'GUEST_SERVICE_URL'], 'http://guest:3000');
const billingUrl = () => url(['BILLING_URL', 'BILLING_SERVICE_URL'], 'http://billing:3000');

function validDates(checkIn, checkOut) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(checkOut ?? '')) return false;

  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  return Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start.toISOString().slice(0, 10) === checkIn &&
    end.toISOString().slice(0, 10) === checkOut &&
    end > start;
}

function totalPrice(nightlyRate, checkIn, checkOut) {
  const nights = (Date.parse(`${checkOut}T00:00:00Z`) -
    Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000;
  return Math.round(Number(nightlyRate) * nights * 100) / 100;
}

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

async function releaseHold(id) {
  if (id) await axios.delete(`${roomRateUrl()}/holds/${id}`);
}

async function publishConfirmed(payload) {
  const amqp = await import('amqplib');
  const connection = await amqp.connect(
    process.env.RABBITMQ_URL || 'amqp://localhost:5672'
  );

  try {
    const channel = await connection.createChannel();
    await channel.assertQueue('ReservationConfirmed', { durable: true });
    channel.sendToQueue(
      'ReservationConfirmed',
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' }
    );
    await channel.close();
  } finally {
    await connection.close();
  }
}

export function createApp({ db = pool, http = axios, publishEvent = publishConfirmed } = {}) {
  const app = express();
  app.use(express.json());

  const release = async (id) => {
    if (id) await http.delete(`${roomRateUrl()}/holds/${id}`);
  };

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/reservations', async (req, res, next) => {
    const { guest, roomTypeId, checkIn, checkOut, depositAmount, currency } = req.body ?? {};

    if (!guest || !roomTypeId || !validDates(checkIn, checkOut) ||
        !Number.isFinite(depositAmount) || depositAmount <= 0 ||
        !/^[A-Z]{3}$/.test(currency ?? '')) {
      return fail(res, 400, 'BadRequest', 'Valid guest, room type, dates, deposit, and currency are required.');
    }

    const reservationNo = `R-${randomUUID()}`;
    let holdId;
    let guestId;
    let depositId;
    let saved = false;

    try {
      const availabilityResult = await http.get(`${roomRateUrl()}/availability`, {
        params: { checkIn, checkOut, roomTypeId }
      });
      const availability = availabilityResult.data.availability?.find(
        (item) => item.roomTypeId === roomTypeId
      );

      if (!availability?.available || availability.roomsAvailable < 1) {
        return fail(res, 409, 'Conflict', 'No rooms are available for those dates.');
      }

      const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
      const holdResult = await http.post(`${roomRateUrl()}/holds`, {
        roomTypeId, checkIn, checkOut
      });
      holdId = holdResult.data.id;

      const guestResult = await http.post(`${guestUrl()}/guests/get-or-create`, guest);
      guestId = guestResult.data.id;

      let depositResult;
      try {
        depositResult = await http.post(`${billingUrl()}/deposits`, {
          reservationNo, guestId, amount: depositAmount, currency
        });
      } catch (error) {
        if (error.response?.status === 402) {
          await release(holdId);
          holdId = undefined;
          return fail(res, 402, 'PaymentDeclined', 'The deposit was declined.');
        }
        throw error;
      }
      depositId = depositResult.data.depositId;

      await db.query(
        `INSERT INTO reservations
          (reservation_no, guest_id, room_type_id, hold_id, check_in, check_out,
           total_amount, deposit_id, deposit_amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed')`,
        [reservationNo, guestId, roomTypeId, holdId, checkIn, checkOut,
          amount, depositId, depositAmount, currency]
      );
      saved = true;

      await http.post(`${roomRateUrl()}/holds/${holdId}/confirm`);

      await publishEvent({
        reservationNo,
        guestId,
        roomTypeId,
        checkIn,
        checkOut,
        totalAmount: amount,
        currency,
        confirmedAt: new Date().toISOString()
      });

      return res.status(201).json({
        reservationNo, guestId, roomTypeId, checkIn, checkOut,
        totalAmount: amount, currency, status: 'confirmed'
      });
    } catch (error) {
      if (saved) {
        await db.query('DELETE FROM reservations WHERE reservation_no = $1', [reservationNo])
          .catch(() => {});
      }
      if (holdId) await release(holdId).catch(() => {});
      if (depositId) {
        await http.post(`${billingUrl()}/refunds`, {
          depositId, amount: depositAmount, currency
        }).catch(() => {});
      }
      return next(error);
    }
  });

  app.get('/reservations/:no', async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT reservation_no AS "reservationNo", guest_id AS "guestId",
                room_type_id AS "roomTypeId", check_in AS "checkIn",
                check_out AS "checkOut", total_amount::float AS "totalAmount",
                deposit_id AS "depositId", deposit_amount::float AS "depositAmount",
                currency, status
         FROM reservations WHERE reservation_no = $1`,
        [req.params.no]
      );

      if (!result.rowCount) return fail(res, 404, 'NotFound', 'Reservation not found.');
      return res.status(200).json(result.rows[0]);
    } catch (error) {
      return next(error);
    }
  });

  app.put('/reservations/:no', async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut } = req.body ?? {};

    if (!roomTypeId || !validDates(checkIn, checkOut)) {
      return fail(res, 400, 'BadRequest', 'Valid room type and dates are required.');
    }

    let newHoldId;
    try {
      const found = await db.query(
        'SELECT * FROM reservations WHERE reservation_no = $1',
        [req.params.no]
      );
      if (!found.rowCount) return fail(res, 404, 'NotFound', 'Reservation not found.');

      const current = found.rows[0];
      if (current.status !== 'confirmed') {
        return fail(res, 409, 'Conflict', 'Only confirmed reservations can be modified.');
      }

      const availabilityResult = await http.get(`${roomRateUrl()}/availability`, {
        params: { checkIn, checkOut, roomTypeId }
      });
      const availability = availabilityResult.data.availability?.find(
        (item) => item.roomTypeId === roomTypeId
      );

      if (!availability?.available || availability.roomsAvailable < 1) {
        return fail(res, 409, 'Conflict', 'No rooms are available for those dates.');
      }

      const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
      const holdResult = await http.post(`${roomRateUrl()}/holds`, {
        roomTypeId, checkIn, checkOut
      });
      newHoldId = holdResult.data.id;

      await http.post(`${roomRateUrl()}/holds/${newHoldId}/confirm`);

      const updated = await db.query(
        `UPDATE reservations
         SET room_type_id = $2, hold_id = $3, check_in = $4,
             check_out = $5, total_amount = $6
         WHERE reservation_no = $1
         RETURNING reservation_no AS "reservationNo", guest_id AS "guestId",
                   room_type_id AS "roomTypeId", check_in AS "checkIn",
                   check_out AS "checkOut", total_amount::float AS "totalAmount",
                   currency, status`,
        [req.params.no, roomTypeId, newHoldId, checkIn, checkOut, amount]
      );

      await release(current.hold_id);
      return res.status(200).json(updated.rows[0]);
    } catch (error) {
      if (newHoldId) await release(newHoldId).catch(() => {});
      return next(error);
    }
  });

  app.delete('/reservations/:no', async (req, res, next) => {
    try {
      const found = await db.query(
        'SELECT * FROM reservations WHERE reservation_no = $1',
        [req.params.no]
      );
      if (!found.rowCount) return fail(res, 404, 'NotFound', 'Reservation not found.');

      const reservation = found.rows[0];
      if (reservation.status !== 'confirmed') {
        return fail(res, 409, 'Conflict', 'Reservation is already cancelled.');
      }

      const percent = Number(process.env.CANCELLATION_REFUND_PERCENT ?? 100);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error('CANCELLATION_REFUND_PERCENT must be between 0 and 100.');
      }

      await release(reservation.hold_id);

      const refundAmount = Math.round(
        Number(reservation.deposit_amount) * percent
      ) / 100;

      if (refundAmount > 0 && reservation.deposit_id) {
        await http.post(`${billingUrl()}/refunds`, {
          depositId: reservation.deposit_id,
          amount: refundAmount,
          currency: reservation.currency.trim()
        });
      }

      await db.query(
        "UPDATE reservations SET status = 'cancelled' WHERE reservation_no = $1",
        [req.params.no]
      );
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.'
    });
  });

  return app;
}

export const app = createApp();
