import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { canTransition } from './hold-state.js';

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

async function getAvailability(db, checkIn, checkOut, now, { roomTypeId, hotelId, guests, excludeHoldId } = {}) {
  const result = await db.query(
    `SELECT
       rt.id AS "roomTypeId",
       rt.name AS "name",
       rt.hotel_id AS "hotelId",
       rt.max_occupancy AS "maxOccupancy",
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
           AND ($7::text IS NULL OR h.id <> $7)
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
       AND ($5::text IS NULL OR rt.hotel_id = $5)
       AND ($6::int IS NULL OR rt.max_occupancy >= $6)
     ORDER BY rt.id`,
    [checkIn, checkOut, now, roomTypeId ?? null, hotelId ?? null, guests ?? null, excludeHoldId ?? null]
  );

  return result.rows.map((row) => {
    const roomsAvailable = Math.max(0, row.roomCount - row.occupied);
    return {
      roomTypeId: row.roomTypeId,
      name: row.name,
      hotelId: row.hotelId,
      maxOccupancy: row.maxOccupancy,
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
  app.use((req, res, next) => {
    const required = process.env.INTERNAL_TOKEN;
    if (!required || req.headers['x-internal-token'] === required) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/hotels', async (_req, res, next) => {
    try {
      const result = await db.query(
        'SELECT id, name FROM hotels ORDER BY name, id'
      );
      return res.status(200).json({ hotels: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/room-types', async (_req, res, next) => {
    try {
      const result = await db.query(
        `SELECT id, name, max_occupancy AS "maxOccupancy"
         FROM room_types
         ORDER BY name, id`
      );
      return res.status(200).json({ roomTypes: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/rate-plans', async (_req, res, next) => {
    try {
      const result = await db.query(
        `SELECT id, room_type_id AS "roomTypeId", nightly_rate AS "nightlyRate", currency, active
         FROM rate_plans
         ORDER BY room_type_id, nightly_rate`
      );
      return res.status(200).json({ ratePlans: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  const ROOM_STATUSES = ['available', 'unavailable', 'maintenance', 'inactive'];

  function isRoomStatus(value) {
    return typeof value === 'string' && ROOM_STATUSES.includes(value);
  }

  async function findRoom(client, id) {
    const result = await client.query(
      'SELECT id, room_type_id AS "roomTypeId", status FROM rooms WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  app.get('/rooms', async (_req, res, next) => {
    try {
      const result = await db.query(
        `SELECT r.id,
                r.room_number AS "roomNumber",
                r.status,
                r.hotel_id AS "hotelId",
                h.name AS "hotelName",
                r.room_type_id AS "roomTypeId",
                rt.name AS "roomTypeName",
                rt.max_occupancy AS "maxOccupancy",
                COALESCE(rate.nightly_rate, 0)::float AS "price",
                COALESCE(rate.currency, 'USD') AS currency
         FROM rooms r
         JOIN hotels h ON h.id = r.hotel_id
         JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN LATERAL (
           SELECT nightly_rate, currency
           FROM rate_plans
           WHERE room_type_id = r.room_type_id AND active = TRUE
           ORDER BY nightly_rate ASC
           LIMIT 1
         ) rate ON TRUE
         ORDER BY r.room_number`
      );
      return res.status(200).json({ rooms: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/rooms', async (req, res, next) => {
    const { hotelId, roomTypeId, roomNumber, status } = req.body ?? {};

    if (!hotelId || !roomTypeId || !roomNumber) {
      return errorResponse(res, 400, 'BadRequest', 'hotelId, roomTypeId and roomNumber are required.');
    }

    const finalStatus = status ?? 'available';
    if (!isRoomStatus(finalStatus)) {
      return errorResponse(
        res,
        400,
        'BadRequest',
        `status must be one of: ${ROOM_STATUSES.join(', ')}.`
      );
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const hotel = await client.query('SELECT id FROM hotels WHERE id = $1', [hotelId]);
      if (hotel.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Hotel not found.');
      }

      const roomType = await client.query(
        'SELECT id, hotel_id FROM room_types WHERE id = $1',
        [roomTypeId]
      );
      if (roomType.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Room type not found.');
      }
      if (roomType.rows[0].hotel_id !== hotelId) {
        await client.query('ROLLBACK');
        return errorResponse(res, 400, 'BadRequest', 'Room type does not belong to the selected hotel.');
      }

      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO rooms (id, hotel_id, room_type_id, room_number, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, room_number AS "roomNumber", status, hotel_id AS "hotelId", room_type_id AS "roomTypeId"`,
        [id, hotelId, roomTypeId, roomNumber, finalStatus]
      );

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        return errorResponse(res, 409, 'Conflict', 'A room with this number already exists in the hotel.');
      }
      return next(error);
    } finally {
      client.release();
    }
  });

  app.patch('/rooms/:id', async (req, res, next) => {
    const { status } = req.body ?? {};

    if (!isRoomStatus(status)) {
      return errorResponse(
        res,
        400,
        'BadRequest',
        `status must be one of: ${ROOM_STATUSES.join(', ')}.`
      );
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const room = await findRoom(client, req.params.id);
      if (!room) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Room not found.');
      }

      if (status !== 'available') {
        const today = clock().toISOString().slice(0, 10);
        const blocking = await client.query(
          `SELECT 1 FROM holds h
           WHERE h.room_type_id = $1
             AND h.status IN ('held', 'confirmed')
             AND h.check_out > $2::date
           LIMIT 1`,
          [room.roomTypeId, today]
        );
        if (blocking.rowCount > 0) {
          await client.query('ROLLBACK');
          return errorResponse(
            res,
            409,
            'Conflict',
            'Cannot mark the room unavailable: it has held or confirmed reservations from today onward.'
          );
        }
      }

      const updated = await client.query(
        `UPDATE rooms SET status = $1 WHERE id = $2
         RETURNING id, room_number AS "roomNumber", status, hotel_id AS "hotelId", room_type_id AS "roomTypeId"`,
        [status, req.params.id]
      );

      await client.query('COMMIT');
      return res.status(200).json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  app.get('/availability', async (req, res, next) => {
    const { checkIn, checkOut, roomTypeId, hotelId, excludeHoldId } = req.query;
    const guests = req.query.guests === undefined || req.query.guests === ''
      ? null
      : Number(req.query.guests);

    if (!validDateRange(checkIn, checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid checkIn and checkOut dates are required.');
    }

    if (guests != null && (!Number.isInteger(guests) || guests < 1)) {
      return errorResponse(res, 400, 'BadRequest', 'guests must be a positive integer.');
    }

    try {
      const availability = await getAvailability(
        db,
        checkIn,
        checkOut,
        clock().toISOString(),
        { roomTypeId, hotelId, guests, excludeHoldId: typeof excludeHoldId === 'string' ? excludeHoldId : null }
      );
      return res.status(200).json({ availability });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/holds', async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut, excludeHoldId } = req.body ?? {};

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
        { roomTypeId, excludeHoldId: typeof excludeHoldId === 'string' ? excludeHoldId : null }
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

      if (hold.status === 'held' && new Date(hold.expires_at) <= now) {
        if (!canTransition(hold.status, 'expired')) {
          await client.query('ROLLBACK');
          return errorResponse(res, 409, 'Conflict', 'Hold is no longer active.');
        }
        await client.query("UPDATE holds SET status = 'expired' WHERE id = $1", [hold.id]);
        await client.query('COMMIT');
        return errorResponse(res, 409, 'Conflict', 'Hold is no longer active.');
      }

      if (!canTransition(hold.status, 'confirmed')) {
        await client.query('ROLLBACK');
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
      const current = await db.query('SELECT status FROM holds WHERE id = $1', [req.params.id]);
      if (!current.rowCount) return errorResponse(res, 404, 'NotFound', 'Hold not found.');
      if (!canTransition(current.rows[0].status, 'released')) {
        return errorResponse(res, 409, 'Conflict', 'Hold already released.');
      }

      await db.query("UPDATE holds SET status = 'released' WHERE id = $1", [req.params.id]);
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
