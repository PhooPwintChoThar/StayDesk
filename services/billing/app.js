import { randomUUID } from 'node:crypto';
import axios from 'axios';
import express from 'express';
import multer from 'multer';
import { pool } from './db.js';
import { createPaymentGateway } from './payment-gateway.js';
import { createOutbox } from './events.js';

const allowedTypes = new Set(['image/png', 'image/jpeg', 'application/pdf']);
const paymentProofReviewedQueue = 'PaymentProofReviewed';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    const error = new Error('Invalid file type');
    error.code = 'INVALID_FILE_TYPE';
    cb(error);
  }
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const serviceUrl = () => (process.env.RESERVATION_SERVICE_URL || process.env.RESERVATION_URL || 'http://reservation:3000').replace(/\/$/, '');
const guestServiceUrl = () => (process.env.GUEST_SERVICE_URL || 'http://guest:3000').replace(/\/$/, '');

function validMoney(amount) {
  return Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === amount * 100;
}

function validCurrency(currency) {
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
}

const OPEN_RESERVATION = new Set(['pending', 'confirmed']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function actorFromRequest(req) {
  return {
    id: req.headers['x-user-id'] || null,
    role: req.headers['x-user-role'] || null,
  };
}

function isStaff(role) {
  return role === 'agent' || role === 'manager';
}

function isKnownRole(role) {
  return role === 'guest' || isStaff(role);
}

function validFileSignature(file) {
  if (file.mimetype === 'image/png') {
    return file.buffer.subarray(0, pngSignature.length).equals(pngSignature);
  }
  if (file.mimetype === 'image/jpeg') {
    return file.buffer.length >= 3 &&
      file.buffer[0] === 0xff &&
      file.buffer[1] === 0xd8 &&
      file.buffer[2] === 0xff;
  }
  if (file.mimetype === 'application/pdf') {
    return file.buffer.subarray(0, 4).toString('ascii') === '%PDF';
  }
  return false;
}

function encodeFilename(filename) {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function requireProofActor(req, res, next) {
  const actor = actorFromRequest(req);
  if (!actor.id) {
    return errorResponse(res, 401, 'Unauthorized', 'A user identity is required.');
  }
  if (!isKnownRole(actor.role)) {
    return errorResponse(res, 403, 'Forbidden', 'A valid user role is required.');
  }
  req.proofActor = actor;
  return next();
}

async function loadReservation(reservationNo) {
  const headers = process.env.INTERNAL_TOKEN
    ? { 'x-internal-token': process.env.INTERNAL_TOKEN }
    : {};
  const response = await axios.get(
    `${serviceUrl()}/reservations/${encodeURIComponent(reservationNo)}`,
    { headers, validateStatus: () => true }
  );
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Reservation lookup failed (${response.status})`);
  }
  return response.data;
}

async function ensureOwnership({ reservationNo, actor }) {
  const reservation = await loadReservation(reservationNo);
  if (!reservation) {
    return { error: [404, 'NotFound', 'Reservation not found.'] };
  }
  if (!isStaff(actor.role) && reservation.guestId !== actor.id) {
    return { error: [403, 'Forbidden', 'You do not own this reservation.'] };
  }
  return { reservation };
}

function serializeProof(row, actor) {
  // Guests see the outcome of a review, not which staff member made it.
  const reviewer = actor?.role === 'guest'
    ? {}
    : { reviewedBy: row.reviewed_by, reviewedByRole: row.reviewed_by_role };
  return {
    ...reviewer,
    id: row.id,
    paymentNo: row.payment_no,
    reservationNo: row.reservation_no,
    guestId: row.guest_id,
    amount: Number(row.amount),
    currency: row.currency,
    note: row.note,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size,
    status: row.status,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    cancelledAt: row.cancelled_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
  };
}

async function fetchProof(db, id) {
  if (!UUID_PATTERN.test(id)) return null;
  const result = await db.query('SELECT * FROM payment_proofs WHERE id = $1', [id]);
  return result.rows[0] || null;
}

function roundMoney(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

async function proofTotals(db, reservationNo, excludeId = null) {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)::float AS approved,
            COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::float AS pending
     FROM payment_proofs
     WHERE reservation_no = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [reservationNo, excludeId]
  );
  return result.rows[0];
}

// Serialises proof uploads and approvals of one reservation so balances cannot be overshot.
async function lockReservation(client, reservationNo) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proofs:${reservationNo}`]);
}

function amountStillOwed(reservation) {
  return roundMoney(Number(reservation.totalAmount) - Number(reservation.depositHeld ?? reservation.depositAmount ?? 0));
}

async function loadGuestContact(guestId) {
  const headers = process.env.INTERNAL_TOKEN
    ? { 'x-internal-token': process.env.INTERNAL_TOKEN }
    : {};
  const response = await axios.get(
    `${guestServiceUrl()}/guests/${encodeURIComponent(guestId)}`,
    { headers, validateStatus: () => true }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Guest lookup failed (${response.status})`);
  }
  return {
    guestEmail: response.data.email || null,
    guestPhone: response.data.phone || null,
    guestName: [response.data.firstName, response.data.lastName].filter(Boolean).join(' ') || null,
  };
}

// Stored in the outbox first, so the guest's email survives a broker outage.
export const outbox = createOutbox({ db: pool });

async function sendPaymentProofReviewedNotification(payload) {
  const contact = await loadGuestContact(payload.guestId).catch((error) => {
    console.error(`Guest lookup for notification failed: ${error.message}`);
    return {};
  });
  // Payment confirmations always go to the guest's email when one is on file.
  await outbox.enqueue(paymentProofReviewedQueue, {
    ...payload,
    ...contact,
    notificationChannel: contact.guestEmail ? 'email' : process.env.NOTIFICATION_CHANNEL || 'email',
  });
}

async function notifyProofReviewIfConfigured(payload) {
  if (!process.env.RABBITMQ_URL) return;
  await sendPaymentProofReviewedNotification(payload);
}

async function markReservationPaid(reservationNo) {
  const headers = process.env.INTERNAL_TOKEN
    ? { 'x-internal-token': process.env.INTERNAL_TOKEN }
    : {};
  await axios.post(
    `${serviceUrl()}/reservations/${encodeURIComponent(reservationNo)}/payment-approved`,
    {},
    { headers }
  );
}

export function createApp({
  db = pool,
  paymentGateway,
  notifyProofReview = notifyProofReviewIfConfigured,
  confirmReservationPayment = markReservationPaid
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

      const inserted = await db.query(
        `INSERT INTO payments (id, type, reservation_no, guest_id, amount, currency, status)
         VALUES ($1, 'deposit', $2, $3, $4, $5, $6)
         RETURNING payment_no`,
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
        paymentNo: inserted.rows[0].payment_no,
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
      const inserted = await client.query(
        `INSERT INTO payments (id, type, reservation_no, deposit_id, amount, currency, status)
         SELECT $1, 'refund', reservation_no, $2, $3, $4, 'refunded' FROM payments WHERE id = $2
         RETURNING payment_no`,
        [refundId, depositId, amount, currency]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        refundId,
        depositId,
        paymentNo: inserted.rows[0].payment_no,
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

  // Internal (check-out): apply the deposit to the bill.
  app.post('/deposits/capture', async (req, res, next) => {
    const reservationNo = String(req.body?.reservationNo || '').trim();
    if (!reservationNo) return errorResponse(res, 400, 'BadRequest', 'reservationNo is required.');
    try {
      const captured = await db.query(
        `UPDATE payments SET status = 'captured', captured_at = NOW()
         WHERE reservation_no = $1 AND type = 'deposit' AND status = 'authorized'
         RETURNING payment_no, amount::float AS amount`,
        [reservationNo]
      );
      return res.status(200).json({
        captured: captured.rows.map((row) => ({ paymentNo: row.payment_no, amount: row.amount }))
      });
    } catch (error) {
      return next(error);
    }
  });

  // Internal (check-out): the remaining balance was paid at the front desk.
  app.post('/settlements', async (req, res, next) => {
    const { reservationNo, guestId, amount, currency } = req.body ?? {};
    if (!reservationNo || !guestId || !validMoney(amount) || !validCurrency(currency)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid reservationNo, guestId, amount, and currency are required.');
    }
    try {
      const id = randomUUID();
      const inserted = await db.query(
        `INSERT INTO payments (id, type, reservation_no, guest_id, amount, currency, status, captured_at)
         VALUES ($1, 'settlement', $2, $3, $4, $5, 'captured', NOW())
         RETURNING payment_no`,
        [id, reservationNo, guestId, amount, currency]
      );
      return res.status(201).json({ id, paymentNo: inserted.rows[0].payment_no, amount, currency, status: 'captured' });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/payments/transactions', requireProofActor, async (req, res, next) => {
    if (!isStaff(req.proofActor.role)) {
      return errorResponse(res, 403, 'Forbidden', 'Only agents and managers can view transactions.');
    }
    const reservationNo = String(req.query.reservationNo || '').trim();
    if (!reservationNo) return errorResponse(res, 400, 'BadRequest', 'reservationNo is required.');
    try {
      const result = await db.query(
        `SELECT id, payment_no AS "paymentNo", type, amount::float AS amount, TRIM(currency) AS currency,
                status, created_at AS "createdAt", captured_at AS "capturedAt"
         FROM payments
         WHERE reservation_no = $1
            OR deposit_id IN (SELECT id FROM payments WHERE reservation_no = $1)
         ORDER BY created_at, payment_no`,
        [reservationNo]
      );
      return res.status(200).json({ transactions: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/payments/proofs', requireProofActor, upload.single('file'), async (req, res, next) => {
    try {
      const actor = req.proofActor;
      const reservationNo = String(req.body?.reservationNo || '').trim();
      const amount = Number(req.body?.amount);
      const currency = String(req.body?.currency || '').trim().toUpperCase();
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;

      if (!reservationNo || !validMoney(amount) || !validCurrency(currency) || !req.file) {
        return errorResponse(res, 400, 'BadRequest', 'Valid reservationNo, amount, currency, and file are required.');
      }
      if (!validFileSignature(req.file)) {
        return errorResponse(res, 400, 'BadRequest', 'The file content does not match its declared type.');
      }

      const ownership = await ensureOwnership({ reservationNo, actor });
      if (ownership.error) {
        const [status, error, message] = ownership.error;
        return errorResponse(res, status, error, message);
      }

      const reservation = ownership.reservation;
      if (!OPEN_RESERVATION.has(reservation.status)) {
        return errorResponse(res, 409, 'Conflict', 'Payments cannot be submitted for a cancelled reservation.');
      }
      if (String(reservation.currency || '').trim() !== currency) {
        return errorResponse(res, 400, 'BadRequest', `The payment currency must be ${String(reservation.currency).trim()}.`);
      }

      const proofId = randomUUID();
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await lockReservation(client, reservationNo);
        const totals = await proofTotals(client, reservationNo);
        const outstanding = roundMoney(amountStillOwed(reservation) - totals.approved - totals.pending);
        if (amount > outstanding) {
          await client.query('ROLLBACK');
          return errorResponse(
            res,
            400,
            'BadRequest',
            outstanding > 0
              ? `The amount exceeds the outstanding balance of ${outstanding.toFixed(2)} ${currency} (including proofs awaiting review).`
              : 'Nothing is outstanding on this reservation (including proofs awaiting review).'
          );
        }
        await client.query(
          `INSERT INTO payment_proofs (
            id, reservation_no, guest_id, amount, currency, note, file_name,
            file_type, file_size, file_data, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
          [
            proofId,
            reservationNo,
            reservation.guestId,
            amount,
            currency,
            note,
            req.file.originalname,
            req.file.mimetype,
            req.file.size,
            req.file.buffer,
          ]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      const stored = await fetchProof(db, proofId);
      return res.status(201).json({ id: proofId, paymentNo: stored.payment_no, status: 'pending' });
    } catch (error) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return errorResponse(res, 413, 'PayloadTooLarge', 'The uploaded file must be 5 MB or smaller.');
      }
      if (error.code === 'INVALID_FILE_TYPE') {
        return errorResponse(res, 400, 'BadRequest', 'Only PNG, JPEG, or PDF files are allowed.');
      }
      return next(error);
    }
  });

  // Internal: proof totals for one reservation (the gateway does not expose this route).
  app.get('/payments/reservations/:no/totals', async (req, res, next) => {
    try {
      const totals = await proofTotals(db, req.params.no);
      return res.status(200).json({
        reservationNo: req.params.no,
        approvedTotal: roundMoney(totals.approved),
        pendingTotal: roundMoney(totals.pending),
      });
    } catch (error) {
      return next(error);
    }
  });

  // Internal: the reservation was cancelled, so its proofs are settled too.
  // Idempotent, so the reservation service can safely call it again.
  app.post('/payments/reservations/:no/cancel', async (req, res, next) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockReservation(client, req.params.no);
      const cancelled = await client.query(
        `UPDATE payment_proofs SET status = 'cancelled', cancelled_at = NOW()
         WHERE reservation_no = $1 AND status = 'pending'
         RETURNING payment_no`,
        [req.params.no]
      );
      const refundDue = await client.query(
        `UPDATE payment_proofs SET status = 'refund_due', cancelled_at = NOW()
         WHERE reservation_no = $1 AND status = 'approved'
         RETURNING payment_no, amount::float AS amount`,
        [req.params.no]
      );
      await client.query('COMMIT');
      return res.status(200).json({
        reservationNo: req.params.no,
        cancelledProofs: cancelled.rows.map((row) => row.payment_no),
        refundDue: refundDue.rows.map((row) => ({ paymentNo: row.payment_no, amount: row.amount })),
        refundDueTotal: roundMoney(refundDue.rows.reduce((sum, row) => sum + row.amount, 0)),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  // Staff confirm that money owed back after a cancellation was returned.
  app.put('/payments/proofs/:id/refund', async (req, res, next) => {
    const actor = actorFromRequest(req);
    if (!isStaff(actor.role)) {
      return errorResponse(res, 403, 'Forbidden', 'Only agents and managers can record refunds.');
    }
    try {
      if (!UUID_PATTERN.test(req.params.id)) {
        return errorResponse(res, 404, 'NotFound', 'Payment proof not found.');
      }
      const updated = await db.query(
        `UPDATE payment_proofs SET status = 'refunded', refunded_at = NOW(), refunded_by = $2
         WHERE id = $1 AND status = 'refund_due'
         RETURNING *`,
        [req.params.id, actor.id]
      );
      if (updated.rowCount) return res.status(200).json({ proof: serializeProof(updated.rows[0], actor) });
      const proof = await fetchProof(db, req.params.id);
      if (!proof) return errorResponse(res, 404, 'NotFound', 'Payment proof not found.');
      return errorResponse(res, 409, 'Conflict', 'Only payments with a refund due can be marked refunded.');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/payments/proofs', requireProofActor, async (req, res, next) => {
    try {
      const actor = req.proofActor;
      const { reservationNo, status } = req.query;
      const clauses = [];
      const values = [];

      if (!isStaff(actor.role)) {
        clauses.push('guest_id = $' + (values.length + 1));
        values.push(actor.id);
      }

      if (reservationNo) {
        clauses.push('reservation_no = $' + (values.length + 1));
        values.push(String(reservationNo));
      }

      if (req.query.q) {
        clauses.push(`(reservation_no ILIKE $${values.length + 1} OR payment_no ILIKE $${values.length + 1})`);
        values.push(`%${String(req.query.q).trim()}%`);
      }

      if (status) {
        clauses.push('status = $' + (values.length + 1));
        values.push(String(status));
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await db.query(`SELECT * FROM payment_proofs ${where} ORDER BY created_at DESC, id DESC`, values);
      return res.status(200).json({ proofs: result.rows.map((row) => serializeProof(row, actor)) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/payments/proofs/:id/file', requireProofActor, async (req, res, next) => {
    try {
      const actor = req.proofActor;
      const proof = await fetchProof(db, req.params.id);
      if (!proof) {
        return errorResponse(res, 404, 'NotFound', 'Payment proof not found.');
      }

      if (!isStaff(actor.role) && proof.guest_id !== actor.id) {
        return errorResponse(res, 403, 'Forbidden', 'You do not have access to this payment proof.');
      }

      res.setHeader('Content-Type', proof.file_type);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeFilename(proof.file_name)}`);
      return res.status(200).send(Buffer.from(proof.file_data));
    } catch (error) {
      return next(error);
    }
  });

  app.put('/payments/proofs/:id/review', async (req, res, next) => {
    try {
      const actor = actorFromRequest(req);
      if (!isStaff(actor.role)) {
        return errorResponse(res, 403, 'Forbidden', 'Only agents and managers can review payment proofs.');
      }

      const decision = String(req.body?.decision || '').trim();
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      if (!['approved', 'rejected'].includes(decision)) {
        return errorResponse(res, 400, 'BadRequest', 'A valid decision is required.');
      }
      if (decision === 'rejected' && !note) {
        return errorResponse(res, 400, 'BadRequest', 'A rejection note is required.');
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const proofResult = UUID_PATTERN.test(req.params.id)
          ? await client.query('SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE', [req.params.id])
          : { rowCount: 0, rows: [] };
        if (!proofResult.rowCount) {
          await client.query('ROLLBACK');
          return errorResponse(res, 404, 'NotFound', 'Payment proof not found.');
        }

        const proof = proofResult.rows[0];
        if (proof.status !== 'pending') {
          await client.query('ROLLBACK');
          return errorResponse(res, 409, 'Conflict', 'Only pending proofs can be reviewed.');
        }

        let reservation = null;
        let approvedTotal = null;
        if (decision === 'approved') {
          await lockReservation(client, proof.reservation_no);
          reservation = await loadReservation(proof.reservation_no);
          if (!reservation) {
            await client.query('ROLLBACK');
            return errorResponse(res, 409, 'Conflict', 'The reservation for this proof no longer exists; reject it instead.');
          }
          if (!OPEN_RESERVATION.has(reservation.status)) {
            await client.query('ROLLBACK');
            return errorResponse(res, 409, 'Conflict', 'The reservation is cancelled; reject this proof instead.');
          }
          const totals = await proofTotals(client, proof.reservation_no, proof.id);
          const outstanding = roundMoney(amountStillOwed(reservation) - totals.approved);
          if (Number(proof.amount) > outstanding) {
            await client.query('ROLLBACK');
            return errorResponse(
              res,
              409,
              'Conflict',
              `Approving this proof would exceed the outstanding balance of ${Math.max(0, outstanding).toFixed(2)} ${proof.currency.trim()}.`
            );
          }
          approvedTotal = roundMoney(totals.approved + Number(proof.amount));
        }

        const updated = await client.query(
          `UPDATE payment_proofs
           SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4, reviewed_by_role = $5
           WHERE id = $1
           RETURNING *`,
          [req.params.id, decision, actor.id, decision === 'rejected' ? note : (note || null), actor.role]
        );

        // An approved payment confirms a pending booking; both succeed or neither does.
        const bookingConfirmed = decision === 'approved' && reservation.status === 'pending';
        if (decision === 'approved') {
          try {
            await confirmReservationPayment(proof.reservation_no);
          } catch (error) {
            await client.query('ROLLBACK');
            console.error(error);
            return errorResponse(res, 502, 'BadGateway', 'The booking could not be confirmed, so the payment was not approved. Please try again.');
          }
        }
        await client.query('COMMIT');

        const paidToDate = reservation
          ? roundMoney(Number(reservation.depositHeld ?? 0) + approvedTotal)
          : null;
        void Promise.resolve()
          .then(() => notifyProofReview({
            reservationNo: proof.reservation_no,
            paymentNo: proof.payment_no,
            bookingConfirmed,
            guestId: proof.guest_id,
            amount: Number(proof.amount),
            currency: proof.currency.trim(),
            status: decision,
            reviewNote: updated.rows[0].review_note,
            reviewedAt: updated.rows[0].reviewed_at,
            event: 'PaymentProofReviewed',
            ...(reservation ? {
              checkIn: reservation.checkIn,
              checkOut: reservation.checkOut,
              roomTypeId: reservation.roomTypeId,
              roomNumber: reservation.roomNumber ?? null,
              totalAmount: Number(reservation.totalAmount),
              paidToDate,
              balanceDue: Math.max(0, roundMoney(Number(reservation.totalAmount) - paidToDate)),
            } : {}),
          }))
          .catch((error) => console.error('Failed to send payment proof review notification:', error.message));
        return res.status(200).json({ proof: serializeProof(updated.rows[0]), bookingConfirmed });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return next(error);
    }
  });

  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return errorResponse(res, 413, 'PayloadTooLarge', 'The uploaded file must be 5 MB or smaller.');
    }
    if (err?.code === 'INVALID_FILE_TYPE') {
      return errorResponse(res, 400, 'BadRequest', 'Only PNG, JPEG, or PDF files are allowed.');
    }
    return next(err);
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'InternalServerError', message: 'An unexpected error occurred.' });
  });

  return app;
}

export const app = createApp();
