import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool } from './db.js';

const HOLD_DURATION_MS = 10 * 60 * 1000;

function validDateRange(checkIn, checkOut) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(checkIn ?? '') || !datePattern.test(checkOut ?? '')) {
    return false;
  }

  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  return Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && start.toISOString().slice(0, 10) === checkIn
    && end.toISOString().slice(0, 10) === checkOut
    && end > start;
}

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

async function getAvailability(db, checkIn, checkOut, now, roomTypeId) {
  const result = await db.query(
    `SELECT
       rt.id AS "roomTypeId",
       COALESCE(rate.nightly_rate, 0)::float AS "nightlyRate",
       COALESCE(rate.currency, 'USD') AS currency,
       (
         SELECT COUNT(*)::int
         FROM rooms r
         WHERE r.room_type_id = rt.id AND r.status = 'available'
       ) AS "roomCount",
       (
         SELECT COUNT(*)::int
         FROM holds h
         WHERE h.room_type_id = rt.id
           AND h.check_in < $2::date
           AND h.check_out > $1::date
           AND (
             h.status = 'confirmed'
             OR (h.status = 'held' AND h.expires_at > $3::timestamptz)
           )
       ) AS occupied
     FROM room_types rt
     LEFT JOIN LATERAL (
       SELECT nightly_rate, currency
       FROM rate_plans
       WHERE room_type_id = rt.id AND active = TRUE
       ORDER BY nightly_rate ASC
       LIMIT 1
     ) rate ON TRUE
     WHERE ($4::text IS NULL OR rt.id = $4)
     ORDER BY rt.id`,
    [checkIn, checkOut, now, roomTypeId ?? null]
  );

  return result.rows.map((row) => {
    const roomsAvailable = Math.max(0, row.roomCount - row.occupied);
    return {
      roomTypeId: row.roomTypeId,
      available: roomsAvailable > 0,
      roomsAvailable,
      nightlyRate: row.nightlyRate,
      currency: row.currency
    };
  });
}

export function createApp({ db = pool, clock = () => new Date() } = {}) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/availability', async (req, res, next) => {
    const { checkIn, checkOut, roomTypeId } = req.query;

    if (!validDateRange(checkIn, checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid checkIn and checkOut dates are required.');
    }

    try {
      const availability = await getAvailability(
        db,
        checkIn,
        checkOut,
        clock().toISOString(),
        roomTypeId
      );
      return res.status(200).json({ availability });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/holds', async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut } = req.body ?? {};

    if (!roomTypeId || !validDateRange(checkIn, checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'roomTypeId and a valid date range are required.');
    }

    const client = await db.connect();

    try {
      const now = clock();
      const expiresAt = new Date(now.getTime() + HOLD_DURATION_MS);

      await client.query('BEGIN');

      const roomType = await client.query(
        'SELECT id FROM room_types WHERE id = $1 FOR UPDATE',
        [roomTypeId]
      );

      if (roomType.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Room type not found.');
      }

      await client.query(
        `UPDATE holds
         SET status = 'expired'
         WHERE room_type_id = $1 AND status = 'held' AND expires_at <= $2`,
        [roomTypeId, now.toISOString()]
      );

      const [availability] = await getAvailability(
        client,
        checkIn,
        checkOut,
        now.toISOString(),
        roomTypeId
      );

      if (!availability || availability.roomsAvailable < 1) {
        await client.query('ROLLBACK');
        return errorResponse(res, 409, 'Conflict', 'No rooms are available for those dates.');
      }

      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO holds (id, room_type_id, check_in, check_out, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, 'held')
         RETURNING id, room_type_id AS "roomTypeId", check_in AS "checkIn",
                   check_out AS "checkOut", expires_at AS "expiresAt", status`,
        [id, roomTypeId, checkIn, checkOut, expiresAt.toISOString()]
      );

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  app.post('/holds/:id/confirm', async (req, res, next) => {
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const selected = await client.query(
        'SELECT * FROM holds WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );

      if (selected.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Hold not found.');
      }

      const hold = selected.rows[0];
      const now = clock();

      if (hold.status !== 'held' || new Date(hold.expires_at) <= now) {
        if (hold.status === 'held') {
          await client.query("UPDATE holds SET status = 'expired' WHERE id = $1", [hold.id]);
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
        return errorResponse(res, 409, 'Conflict', 'Hold is no longer active.');
      }

      const confirmed = await client.query(
        `UPDATE holds SET status = 'confirmed'
         WHERE id = $1
         RETURNING id, room_type_id AS "roomTypeId", check_in AS "checkIn",
                   check_out AS "checkOut", expires_at AS "expiresAt", status`,
        [hold.id]
      );

      await client.query('COMMIT');
      return res.status(200).json(confirmed.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  app.delete('/holds/:id', async (req, res, next) => {
    try {
      const result = await db.query('SELECT status FROM holds WHERE id = $1', [req.params.id]);

      if (result.rowCount === 0) {
        return errorResponse(res, 404, 'NotFound', 'Hold not found.');
      }

      if (result.rows[0].status === 'confirmed') {
        return errorResponse(res, 409, 'Conflict', 'Confirmed holds cannot be released.');
      }

      await db.query(
        "UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'held'",
        [req.params.id]
      );
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'InternalServerError', message: 'An unexpected error occurred.' });
  });

  return app;
}

export const app = createApp();
