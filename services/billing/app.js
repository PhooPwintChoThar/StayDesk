import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { createPaymentGateway } from './payment-gateway.js';

function validMoney(amount) {
  return Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === amount * 100;
}

function validCurrency(currency) {
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
}

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

export function createApp({
  db = pool,
  paymentGateway
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const required = process.env.INTERNAL_TOKEN;
    if (!required || req.headers['x-internal-token'] === required) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  const gatewayForRequest = () =>
    paymentGateway ?? createPaymentGateway(process.env.PAYMENT_MODE);

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/deposits', async (req, res, next) => {
    const { reservationNo, guestId, amount, currency } = req.body ?? {};

    if (!reservationNo || !guestId || !validMoney(amount) || !validCurrency(currency)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid reservationNo, guestId, amount, and currency are required.');
    }

    try {
      const id = randomUUID();
      const decision = gatewayForRequest().authorize({
        reservationNo,
        guestId,
        amount,
        currency
      });
      const status = decision.approved ? 'authorized' : 'declined';

      await db.query(
        `INSERT INTO payments (id, type, reservation_no, guest_id, amount, currency, status)
         VALUES ($1, 'deposit', $2, $3, $4, $5, $6)`,
        [id, reservationNo, guestId, amount, currency, status]
      );

      if (!decision.approved) {
        return res.status(402).json({
          error: 'PaymentDeclined',
          message: decision.reason || 'The deposit was declined.'
        });
      }

      return res.status(201).json({
        depositId: id,
        status: 'authorized',
        amount,
        currency
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/refunds', async (req, res, next) => {
    const { depositId, amount, currency } = req.body ?? {};

    if (!depositId || !validMoney(amount) || !validCurrency(currency)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid depositId, amount, and currency are required.');
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, amount, currency
         FROM payments
         WHERE id = $1 AND type = 'deposit' AND status = 'authorized'
         FOR UPDATE`,
        [depositId]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Authorized deposit not found.');
      }

      const deposit = result.rows[0];
      if (deposit.currency.trim() !== currency) {
        await client.query('ROLLBACK');
        return errorResponse(res, 400, 'BadRequest', 'Refund currency must match the deposit currency.');
      }

      const refundedResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS total
         FROM payments
         WHERE deposit_id = $1 AND type = 'refund'`,
        [depositId]
      );

      const depositCents = Math.round(Number(deposit.amount) * 100);
      const refundedCents = Math.round(Number(refundedResult.rows[0].total) * 100);
      const refundCents = Math.round(amount * 100);

      if (refundedCents + refundCents > depositCents) {
        await client.query('ROLLBACK');
        return errorResponse(res, 409, 'Conflict', 'Refund exceeds the remaining deposit amount.');
      }

      const refundId = randomUUID();
      await client.query(
        `INSERT INTO payments (id, type, deposit_id, amount, currency, status)
         VALUES ($1, 'refund', $2, $3, $4, 'refunded')`,
        [refundId, depositId, amount, currency]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        refundId,
        depositId,
        status: 'refunded',
        amount,
        currency
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'InternalServerError', message: 'An unexpected error occurred.' });
  });

  return app;
}

export const app = createApp();
