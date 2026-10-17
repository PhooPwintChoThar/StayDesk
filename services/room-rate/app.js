import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { pool } from './db.js';
import { canTransition } from './hold-state.js';

const HOLD_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_CURRENCY = process.env.HOTEL_CURRENCY || 'USD';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS_PER_UPLOAD = 20;

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_UPLOAD }
}).array('photos', MAX_PHOTOS_PER_UPLOAD);

function photoType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

// Photo list for a room type row aliased as rt.
const PHOTOS_JSON = `
  COALESCE((
    SELECT json_agg(json_build_object('id', p.id, 'url', '/room-types/' || rt.id || '/photos/' || p.id)
                    ORDER BY p.sort_order, p.created_at)
    FROM room_type_photos p WHERE p.room_type_id = rt.id
  ), '[]'::json) AS photos`;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDateRange(checkIn, checkOut) {
  return validDate(checkIn) && validDate(checkOut) && checkOut > checkIn;
}

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

// Current date in the server's calendar (not the UTC date of now).
function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'room-type';
}

function parseRoomTypeInput(body, { partial = false } = {}) {
  const input = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    input.name = cleanText(body.name);
    if (!input.name) errors.push('name is required');
  }
  if (!partial || body.description !== undefined) {
    input.description = cleanText(body.description) || null;
  }
  if (!partial || body.maxOccupancy !== undefined) {
    input.maxOccupancy = Number(body.maxOccupancy);
    if (!Number.isInteger(input.maxOccupancy) || input.maxOccupancy < 1 || input.maxOccupancy > 20) {
      errors.push('maxOccupancy must be a whole number between 1 and 20');
    }
  }
  if (!partial || body.nightlyRate !== undefined) {
    input.nightlyRate = Number(body.nightlyRate);
    if (!Number.isFinite(input.nightlyRate) || input.nightlyRate <= 0 || Math.round(input.nightlyRate * 100) !== input.nightlyRate * 100) {
      errors.push('nightlyRate must be a positive amount with at most 2 decimals');
    }
  }
  if (!partial) {
    input.currency = cleanText(body.currency).toUpperCase() || DEFAULT_CURRENCY;
    if (!/^[A-Z]{3}$/.test(input.currency)) errors.push('currency must be a 3-letter code');
  }

  return errors.length ? { error: `${errors.join('; ')}.` } : { input };
}

// A room is free for [checkIn, checkOut) when it is not under maintenance in that
// window and no active hold is assigned to it. $1 checkIn, $2 checkOut, $3 now.
const ROOM_IS_FREE = `
  NOT (r.status = 'maintenance' AND r.maintenance_from < $2::date AND r.maintenance_to > $1::date)
  AND NOT EXISTS (
    SELECT 1 FROM holds h
    WHERE h.room_id = r.id
      AND ($4::text IS NULL OR h.id <> $4)
      AND h.check_in < $2::date
      AND h.check_out > $1::date
      AND (h.status = 'confirmed' OR (h.status = 'held' AND h.expires_at > $3::timestamptz))
  )`;

async function getAvailability(db, checkIn, checkOut, now, { roomTypeId, guests, excludeHoldId } = {}) {
  const result = await db.query(
    `SELECT
       rt.id AS "roomTypeId",
       rt.name,
       rt.description,
       rt.max_occupancy AS "maxOccupancy",
       rate.nightly_rate::float AS "nightlyRate",
       rate.currency,
       (SELECT COUNT(*)::int FROM rooms r WHERE r.room_type_id = rt.id AND ${ROOM_IS_FREE}) AS "roomsAvailable",
       ${PHOTOS_JSON}
     FROM room_types rt
     JOIN LATERAL (
       SELECT nightly_rate, currency
       FROM rate_plans
       WHERE room_type_id = rt.id AND active = TRUE
       ORDER BY nightly_rate ASC
       LIMIT 1
     ) rate ON TRUE
     WHERE ($5::text IS NULL OR rt.id = $5)
       AND ($6::int IS NULL OR rt.max_occupancy >= $6)
     ORDER BY rate.nightly_rate, rt.name`,
    [checkIn, checkOut, now, excludeHoldId ?? null, roomTypeId ?? null, guests ?? null]
  );

  return result.rows.map((row) => ({
    ...row,
    currency: row.currency.trim(),
    available: row.roomsAvailable > 0
  }));
}

const roomSelect = `
  SELECT r.id,
         r.room_number AS "roomNumber",
         r.status,
         to_char(r.maintenance_from, 'YYYY-MM-DD') AS "maintenanceFrom",
         to_char(r.maintenance_to, 'YYYY-MM-DD') AS "maintenanceTo",
         r.maintenance_note AS "maintenanceNote",
         r.room_type_id AS "roomTypeId",
         rt.name AS "roomTypeName",
         rt.max_occupancy AS "maxOccupancy",
         rate.nightly_rate::float AS "nightlyRate",
         TRIM(rate.currency) AS currency,
         (SELECT COUNT(*)::int FROM holds h
          WHERE h.room_id = r.id AND h.status = 'confirmed' AND h.check_out > $1::date) AS "upcomingReservations"
  FROM rooms r
  JOIN room_types rt ON rt.id = r.room_type_id
  LEFT JOIN LATERAL (
    SELECT nightly_rate, currency
    FROM rate_plans
    WHERE room_type_id = r.room_type_id AND active = TRUE
    ORDER BY nightly_rate ASC
    LIMIT 1
  ) rate ON TRUE`;

const holdReturning = `
  RETURNING id, room_type_id AS "roomTypeId", room_id AS "roomId",
            to_char(check_in, 'YYYY-MM-DD') AS "checkIn",
            to_char(check_out, 'YYYY-MM-DD') AS "checkOut",
            expires_at AS "expiresAt", status`;

export function createApp({ db = pool, clock = () => new Date() } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const required = process.env.INTERNAL_TOKEN;
    if (!required || req.headers['x-internal-token'] === required) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  const today = () => localDate(clock());

  async function loadRoom(client, id) {
    const result = await client.query(`${roomSelect} WHERE r.id = $2`, [today(), id]);
    return result.rows[0] || null;
  }

  async function loadRoomType(client, id) {
    const result = await client.query(
      `SELECT rt.id, rt.name, rt.description, rt.max_occupancy AS "maxOccupancy",
              rate.nightly_rate::float AS "nightlyRate", TRIM(rate.currency) AS currency,
              (SELECT COUNT(*)::int FROM rooms r WHERE r.room_type_id = rt.id) AS "roomCount",
              ${PHOTOS_JSON}
       FROM room_types rt
       LEFT JOIN LATERAL (
         SELECT nightly_rate, currency FROM rate_plans
         WHERE room_type_id = rt.id AND active = TRUE
         ORDER BY nightly_rate ASC LIMIT 1
       ) rate ON TRUE
       WHERE ($1::text IS NULL OR rt.id = $1)
       ORDER BY rate.nightly_rate NULLS LAST, rt.name`,
      [id]
    );
    return id == null ? result.rows : result.rows[0] || null;
  }

  // Locks the room type so hold assignment and room changes for that type are serialised.
  async function lockRoomType(client, id) {
    const result = await client.query('SELECT id FROM room_types WHERE id = $1 FOR UPDATE', [id]);
    return result.rowCount > 0;
  }

  async function activeHoldsForRoom(client, roomId, from, to) {
    const result = await client.query(
      `SELECT to_char(check_in, 'YYYY-MM-DD') AS "checkIn", to_char(check_out, 'YYYY-MM-DD') AS "checkOut"
       FROM holds
       WHERE room_id = $1
         AND check_out > $2::date
         AND ($3::date IS NULL OR check_in < $3::date)
         AND (status = 'confirmed' OR (status = 'held' AND expires_at > $4::timestamptz))
       ORDER BY check_in`,
      [roomId, from, to, clock().toISOString()]
    );
    return result.rows;
  }

  async function insertRoomType(client, input) {
    const base = slugify(input.name);
    const taken = await client.query('SELECT 1 FROM room_types WHERE id = $1', [base]);
    const id = taken.rowCount ? `${base}-${randomBytes(3).toString('hex')}` : base;

    await client.query(
      `INSERT INTO room_types (id, name, description, max_occupancy) VALUES ($1, $2, $3, $4)`,
      [id, input.name, input.description, input.maxOccupancy]
    );
    await client.query(
      `INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency, active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [`${id}-standard`, id, input.nightlyRate, input.currency]
    );
    return id;
  }

  async function inTransaction(res, next, work) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const outcome = await work(client);
      if (outcome?.error) {
        await client.query('ROLLBACK');
        return errorResponse(res, ...outcome.error);
      }
      await client.query('COMMIT');
      return res.status(outcome.status).json(outcome.body);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        const message = error.constraint?.startsWith('room_types')
          ? 'A room type with this name already exists.'
          : 'A room with this number already exists.';
        return errorResponse(res, 409, 'Conflict', message);
      }
      return next(error);
    } finally {
      client.release();
    }
  }

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/room-types', async (_req, res, next) => {
    try {
      return res.status(200).json({ roomTypes: await loadRoomType(db, null) });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/room-types', (req, res, next) => {
    const parsed = parseRoomTypeInput(req.body ?? {});
    if (parsed.error) return errorResponse(res, 400, 'BadRequest', parsed.error);

    return inTransaction(res, next, async (client) => {
      const id = await insertRoomType(client, parsed.input);
      return { status: 201, body: await loadRoomType(client, id) };
    });
  });

  app.patch('/room-types/:id', (req, res, next) => {
    const parsed = parseRoomTypeInput(req.body ?? {}, { partial: true });
    if (parsed.error) return errorResponse(res, 400, 'BadRequest', parsed.error);
    const { input } = parsed;
    if (!Object.keys(input).length) {
      return errorResponse(res, 400, 'BadRequest', 'Provide name, description, maxOccupancy or nightlyRate to update.');
    }

    return inTransaction(res, next, async (client) => {
      if (!(await lockRoomType(client, req.params.id))) {
        return { error: [404, 'NotFound', 'Room type not found.'] };
      }

      await client.query(
        `UPDATE room_types
         SET name = COALESCE($2, name),
             description = CASE WHEN $3::boolean THEN $4 ELSE description END,
             max_occupancy = COALESCE($5, max_occupancy)
         WHERE id = $1`,
        [req.params.id, input.name ?? null, input.description !== undefined, input.description ?? null, input.maxOccupancy ?? null]
      );

      if (input.nightlyRate !== undefined) {
        const updated = await client.query(
          `UPDATE rate_plans SET nightly_rate = $2
           WHERE id = (
             SELECT id FROM rate_plans WHERE room_type_id = $1 AND active = TRUE
             ORDER BY nightly_rate ASC LIMIT 1
           )`,
          [req.params.id, input.nightlyRate]
        );
        if (!updated.rowCount) {
          await client.query(
            `INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency, active)
             VALUES ($1, $2, $3, $4, TRUE)`,
            [`${req.params.id}-${randomBytes(3).toString('hex')}`, req.params.id, input.nightlyRate, DEFAULT_CURRENCY]
          );
        }
      }

      return { status: 200, body: await loadRoomType(client, req.params.id) };
    });
  });

  app.delete('/room-types/:id', (req, res, next) =>
    inTransaction(res, next, async (client) => {
      if (!(await lockRoomType(client, req.params.id))) {
        return { error: [404, 'NotFound', 'Room type not found.'] };
      }
      const rooms = await client.query('SELECT 1 FROM rooms WHERE room_type_id = $1 LIMIT 1', [req.params.id]);
      if (rooms.rowCount) {
        return { error: [409, 'Conflict', 'Move or delete the rooms of this type first.'] };
      }
      const holds = await client.query('SELECT 1 FROM holds WHERE room_type_id = $1 LIMIT 1', [req.params.id]);
      if (holds.rowCount) {
        return { error: [409, 'Conflict', 'This room type has booking history and cannot be deleted.'] };
      }
      await client.query('DELETE FROM rate_plans WHERE room_type_id = $1', [req.params.id]);
      await client.query('DELETE FROM room_types WHERE id = $1', [req.params.id]);
      return { status: 200, body: { id: req.params.id, deleted: true } };
    })
  );

  app.post('/room-types/:id/photos', (req, res, next) => {
    photoUpload(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'Each photo must be 8 MB or smaller.'
          : uploadError.code === 'LIMIT_FILE_COUNT' || uploadError.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Upload up to ${MAX_PHOTOS_PER_UPLOAD} photos at a time in the "photos" field.`
            : 'The photo upload could not be read.';
        return errorResponse(res, 400, 'BadRequest', message);
      }
      const files = req.files ?? [];
      if (!files.length) return errorResponse(res, 400, 'BadRequest', 'Choose at least one photo.');
      const typed = files.map((file) => ({ file, type: photoType(file.buffer) }));
      const invalid = typed.find((item) => !item.type);
      if (invalid) {
        return errorResponse(res, 400, 'BadRequest', `${invalid.file.originalname} is not a JPEG, PNG or WebP image.`);
      }

      return inTransaction(res, next, async (client) => {
        if (!(await lockRoomType(client, req.params.id))) {
          return { error: [404, 'NotFound', 'Room type not found.'] };
        }
        const last = await client.query(
          'SELECT COALESCE(MAX(sort_order), -1)::int AS max FROM room_type_photos WHERE room_type_id = $1',
          [req.params.id]
        );
        let order = last.rows[0].max;
        for (const { file, type } of typed) {
          await client.query(
            `INSERT INTO room_type_photos (id, room_type_id, content_type, data, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [randomUUID(), req.params.id, type, file.buffer, ++order]
          );
        }
        return { status: 201, body: await loadRoomType(client, req.params.id) };
      });
    });
  });

  app.get('/room-types/:id/photos/:photoId', async (req, res, next) => {
    try {
      const result = await db.query(
        'SELECT content_type, data FROM room_type_photos WHERE id = $1 AND room_type_id = $2',
        [req.params.photoId, req.params.id]
      );
      if (!result.rowCount) return errorResponse(res, 404, 'NotFound', 'Photo not found.');
      res.setHeader('Content-Type', result.rows[0].content_type);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.status(200).send(result.rows[0].data);
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/room-types/:id/photos/:photoId', async (req, res, next) => {
    try {
      const deleted = await db.query(
        'DELETE FROM room_type_photos WHERE id = $1 AND room_type_id = $2',
        [req.params.photoId, req.params.id]
      );
      if (!deleted.rowCount) return errorResponse(res, 404, 'NotFound', 'Photo not found.');
      return res.status(200).json(await loadRoomType(db, req.params.id));
    } catch (error) {
      return next(error);
    }
  });

  // Per-room view of a date range for the front desk: free, booked or under maintenance.
  app.get('/rooms/availability', async (req, res, next) => {
    const { checkIn, checkOut } = req.query;
    if (!validDateRange(checkIn, checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid checkIn and checkOut dates are required.');
    }
    try {
      const result = await db.query(
        `SELECT r.id, r.room_number AS "roomNumber", r.room_type_id AS "roomTypeId",
                rt.name AS "roomTypeName", rt.max_occupancy AS "maxOccupancy",
                rate.nightly_rate::float AS "nightlyRate", TRIM(rate.currency) AS currency,
                (r.status = 'maintenance' AND r.maintenance_from < $2::date AND r.maintenance_to > $1::date) AS "inMaintenance",
                to_char(r.maintenance_from, 'YYYY-MM-DD') AS "maintenanceFrom",
                to_char(r.maintenance_to, 'YYYY-MM-DD') AS "maintenanceTo",
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'checkIn', to_char(h.check_in, 'YYYY-MM-DD'),
                    'checkOut', to_char(h.check_out, 'YYYY-MM-DD'),
                    'status', h.status) ORDER BY h.check_in)
                  FROM holds h
                  WHERE h.room_id = r.id AND h.check_in < $2::date AND h.check_out > $1::date
                    AND (h.status = 'confirmed' OR (h.status = 'held' AND h.expires_at > $3::timestamptz))
                ), '[]'::json) AS bookings
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN LATERAL (
           SELECT nightly_rate, currency FROM rate_plans
           WHERE room_type_id = r.room_type_id AND active = TRUE
           ORDER BY nightly_rate ASC LIMIT 1
         ) rate ON TRUE
         ORDER BY LENGTH(r.room_number), r.room_number`,
        [checkIn, checkOut, clock().toISOString()]
      );
      const rooms = result.rows.map(({ inMaintenance, ...room }) => ({
        ...room,
        state: inMaintenance ? 'maintenance' : room.bookings.length ? 'booked' : 'available'
      }));
      return res.status(200).json({
        checkIn,
        checkOut,
        rooms,
        summary: {
          total: rooms.length,
          available: rooms.filter((room) => room.state === 'available').length,
          booked: rooms.filter((room) => room.state === 'booked').length,
          maintenance: rooms.filter((room) => room.state === 'maintenance').length
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/rooms', async (_req, res, next) => {
    try {
      // Maintenance windows that have ended put the room back in service.
      await db.query(
        `UPDATE rooms
         SET status = 'available', maintenance_from = NULL, maintenance_to = NULL, maintenance_note = NULL
         WHERE status = 'maintenance' AND maintenance_to <= $1::date`,
        [today()]
      );
      const result = await db.query(
        `${roomSelect} ORDER BY LENGTH(r.room_number), r.room_number`,
        [today()]
      );
      return res.status(200).json({ rooms: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/rooms', (req, res, next) => {
    const body = req.body ?? {};
    const roomNumber = cleanText(body.roomNumber);
    if (!roomNumber) {
      return errorResponse(res, 400, 'BadRequest', 'roomNumber is required.');
    }
    if (!body.roomTypeId === !body.newRoomType) {
      return errorResponse(res, 400, 'BadRequest', 'Choose an existing roomTypeId or describe a newRoomType.');
    }

    let newRoomType;
    if (body.newRoomType) {
      const parsed = parseRoomTypeInput(body.newRoomType);
      if (parsed.error) return errorResponse(res, 400, 'BadRequest', parsed.error);
      newRoomType = parsed.input;
    }

    return inTransaction(res, next, async (client) => {
      let roomTypeId = body.roomTypeId;
      if (newRoomType) {
        roomTypeId = await insertRoomType(client, newRoomType);
      } else if (!(await lockRoomType(client, roomTypeId))) {
        return { error: [404, 'NotFound', 'Room type not found.'] };
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO rooms (id, room_type_id, room_number, status) VALUES ($1, $2, $3, 'available')`,
        [id, roomTypeId, roomNumber]
      );
      return { status: 201, body: await loadRoom(client, id) };
    });
  });

  app.patch('/rooms/:id', (req, res, next) => {
    const body = req.body ?? {};
    const roomNumber = body.roomNumber === undefined ? undefined : cleanText(body.roomNumber);
    const roomTypeId = body.roomTypeId === undefined ? undefined : cleanText(body.roomTypeId);
    if (roomNumber === undefined && roomTypeId === undefined) {
      return errorResponse(res, 400, 'BadRequest', 'Provide roomNumber or roomTypeId to update.');
    }
    if (roomNumber === '' || roomTypeId === '') {
      return errorResponse(res, 400, 'BadRequest', 'roomNumber and roomTypeId cannot be empty.');
    }

    return inTransaction(res, next, async (client) => {
      const room = await loadRoom(client, req.params.id);
      if (!room) return { error: [404, 'NotFound', 'Room not found.'] };

      if (roomTypeId && roomTypeId !== room.roomTypeId) {
        for (const typeId of [room.roomTypeId, roomTypeId].sort()) {
          if (!(await lockRoomType(client, typeId))) {
            return { error: [404, 'NotFound', 'Room type not found.'] };
          }
        }
        const booked = await activeHoldsForRoom(client, room.id, today(), null);
        if (booked.length) {
          return {
            error: [409, 'Conflict', `Room ${room.roomNumber} has ${booked.length} upcoming reservation(s); its room type cannot change until they are completed or cancelled.`]
          };
        }
      }

      await client.query(
        `UPDATE rooms SET room_number = COALESCE($2, room_number), room_type_id = COALESCE($3, room_type_id)
         WHERE id = $1`,
        [room.id, roomNumber ?? null, roomTypeId ?? null]
      );
      return { status: 200, body: await loadRoom(client, room.id) };
    });
  });

  app.delete('/rooms/:id', (req, res, next) =>
    inTransaction(res, next, async (client) => {
      const room = await loadRoom(client, req.params.id);
      if (!room) return { error: [404, 'NotFound', 'Room not found.'] };
      await lockRoomType(client, room.roomTypeId);

      const booked = await activeHoldsForRoom(client, room.id, today(), null);
      if (booked.length) {
        return {
          error: [409, 'Conflict', `Room ${room.roomNumber} has ${booked.length} upcoming reservation(s) and cannot be deleted.`]
        };
      }
      await client.query('DELETE FROM rooms WHERE id = $1', [room.id]);
      return { status: 200, body: { id: room.id, deleted: true } };
    })
  );

  app.put('/rooms/:id/maintenance', (req, res, next) => {
    const { from, to } = req.body ?? {};
    const note = cleanText(req.body?.note) || null;
    if (!validDateRange(from, to)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid from and to dates are required, and to must be after from.');
    }
    if (from < today()) {
      return errorResponse(res, 400, 'BadRequest', 'Maintenance cannot start in the past.');
    }

    return inTransaction(res, next, async (client) => {
      const room = await loadRoom(client, req.params.id);
      if (!room) return { error: [404, 'NotFound', 'Room not found.'] };
      await lockRoomType(client, room.roomTypeId);

      const booked = await activeHoldsForRoom(client, room.id, from, to);
      if (booked.length) {
        const stays = booked.map((stay) => `${stay.checkIn} to ${stay.checkOut}`).join(', ');
        return {
          error: [409, 'Conflict', `Room ${room.roomNumber} is reserved during that period (${stays}). Choose dates without reservations.`]
        };
      }

      await client.query(
        `UPDATE rooms
         SET status = 'maintenance', maintenance_from = $2, maintenance_to = $3, maintenance_note = $4
         WHERE id = $1`,
        [room.id, from, to, note]
      );
      return { status: 200, body: await loadRoom(client, room.id) };
    });
  });

  app.delete('/rooms/:id/maintenance', (req, res, next) =>
    inTransaction(res, next, async (client) => {
      const updated = await client.query(
        `UPDATE rooms
         SET status = 'available', maintenance_from = NULL, maintenance_to = NULL, maintenance_note = NULL
         WHERE id = $1`,
        [req.params.id]
      );
      if (!updated.rowCount) return { error: [404, 'NotFound', 'Room not found.'] };
      return { status: 200, body: await loadRoom(client, req.params.id) };
    })
  );

  app.get('/availability', async (req, res, next) => {
    const { checkIn, checkOut, roomTypeId, excludeHoldId } = req.query;
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
      const availability = await getAvailability(db, checkIn, checkOut, clock().toISOString(), {
        roomTypeId: typeof roomTypeId === 'string' && roomTypeId ? roomTypeId : null,
        guests,
        excludeHoldId: typeof excludeHoldId === 'string' && excludeHoldId ? excludeHoldId : null
      });
      return res.status(200).json({ availability });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/holds', async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut } = req.body ?? {};
    const excludeHoldId = typeof req.body?.excludeHoldId === 'string' && req.body.excludeHoldId
      ? req.body.excludeHoldId
      : null;

    if (!roomTypeId || !validDateRange(checkIn, checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'roomTypeId and a valid date range are required.');
    }

    const client = await db.connect();

    try {
      const now = clock();
      const expiresAt = new Date(now.getTime() + HOLD_DURATION_MS);

      await client.query('BEGIN');

      if (!(await lockRoomType(client, roomTypeId))) {
        await client.query('ROLLBACK');
        return errorResponse(res, 404, 'NotFound', 'Room type not found.');
      }

      await client.query(
        `UPDATE holds
         SET status = 'expired'
         WHERE room_type_id = $1 AND status = 'held' AND expires_at <= $2`,
        [roomTypeId, now.toISOString()]
      );

      // Prefer the room of the hold being replaced so a modified stay keeps its room.
      const free = await client.query(
        `SELECT r.id, r.room_number AS "roomNumber"
         FROM rooms r
         WHERE r.room_type_id = $5 AND ${ROOM_IS_FREE}
         ORDER BY (r.id = (SELECT room_id FROM holds WHERE id = $4)) DESC NULLS LAST,
                  LENGTH(r.room_number), r.room_number
         LIMIT 1`,
        [checkIn, checkOut, now.toISOString(), excludeHoldId, roomTypeId]
      );

      if (!free.rowCount) {
        await client.query('ROLLBACK');
        return errorResponse(res, 409, 'Conflict', 'No rooms are available for those dates.');
      }

      const room = free.rows[0];
      const result = await client.query(
        `INSERT INTO holds (id, room_type_id, room_id, check_in, check_out, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'held')
         ${holdReturning}`,
        [randomUUID(), roomTypeId, room.id, checkIn, checkOut, expiresAt.toISOString()]
      );

      await client.query('COMMIT');
      return res.status(201).json({ ...result.rows[0], roomNumber: room.roomNumber });
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
        await client.query("UPDATE holds SET status = 'expired' WHERE id = $1", [hold.id]);
        await client.query('COMMIT');
        return errorResponse(res, 409, 'Conflict', 'Hold is no longer active.');
      }

      if (!canTransition(hold.status, 'confirmed')) {
        await client.query('ROLLBACK');
        return errorResponse(res, 409, 'Conflict', 'Hold is no longer active.');
      }

      const confirmed = await client.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1 ${holdReturning}`,
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

  // Check-out: the stay ends on checkOut, so later nights become bookable again.
  app.post('/holds/:id/complete', async (req, res, next) => {
    const { checkOut } = req.body ?? {};
    if (!validDate(checkOut)) {
      return errorResponse(res, 400, 'BadRequest', 'A valid checkOut date is required.');
    }
    try {
      const completed = await db.query(
        `UPDATE holds
         SET check_out = GREATEST(check_in + 1, LEAST(check_out, $2::date))
         WHERE id = $1 AND status = 'confirmed'
         ${holdReturning}`,
        [req.params.id, checkOut]
      );
      if (completed.rowCount) return res.status(200).json(completed.rows[0]);
      const current = await db.query('SELECT status FROM holds WHERE id = $1', [req.params.id]);
      if (!current.rowCount) return errorResponse(res, 404, 'NotFound', 'Hold not found.');
      return errorResponse(res, 409, 'Conflict', `Hold is ${current.rows[0].status}.`);
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/holds/:id', async (req, res, next) => {
    try {
      const released = await db.query(
        `UPDATE holds SET status = 'released'
         WHERE id = $1 AND status IN ('held', 'confirmed')
         RETURNING id`,
        [req.params.id]
      );
      if (released.rowCount) return res.status(204).end();

      const current = await db.query('SELECT status FROM holds WHERE id = $1', [req.params.id]);
      if (!current.rowCount) return errorResponse(res, 404, 'NotFound', 'Hold not found.');
      return errorResponse(res, 409, 'Conflict', `Hold is already ${current.rows[0].status}.`);
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

// Older holds were pooled by room type; give each active one a concrete room.
export async function assignRoomsToLegacyHolds(db = pool, now = new Date()) {
  const legacy = await db.query(
    `SELECT id, room_type_id, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out
     FROM holds
     WHERE room_id IS NULL
       AND (status = 'confirmed' OR (status = 'held' AND expires_at > $1))
     ORDER BY check_in, id`,
    [now.toISOString()]
  );

  for (const hold of legacy.rows) {
    const free = await db.query(
      `SELECT r.id FROM rooms r
       WHERE r.room_type_id = $5 AND ${ROOM_IS_FREE}
       ORDER BY LENGTH(r.room_number), r.room_number
       LIMIT 1`,
      [hold.check_in, hold.check_out, now.toISOString(), null, hold.room_type_id]
    );
    if (free.rowCount) {
      await db.query('UPDATE holds SET room_id = $2 WHERE id = $1', [hold.id, free.rows[0].id]);
    } else {
      console.warn(`No free room to assign to hold ${hold.id} (${hold.check_in} to ${hold.check_out}).`);
    }
  }
}

export const app = createApp();
