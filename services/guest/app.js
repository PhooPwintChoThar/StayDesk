import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool } from './db.js';

const guestFields = `
  id,
  email,
  first_name AS "firstName",
  last_name AS "lastName",
  phone
`;

function validGuest(body) {
  return typeof body?.email === 'string' && body.email.trim() !== ''
    && typeof body?.firstName === 'string' && body.firstName.trim() !== ''
    && typeof body?.lastName === 'string' && body.lastName.trim() !== ''
    && (body.phone == null || typeof body.phone === 'string');
}

function guestValues(body) {
  return [
    body.email.trim().toLowerCase(),
    body.firstName.trim(),
    body.lastName.trim(),
    body.phone?.trim() || null
  ];
}

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function isUniqueViolation(error) {
  return error.code === '23505';
}

export function createApp({ db = pool } = {}) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/guests/get-or-create', async (req, res, next) => {
    if (!validGuest(req.body)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid email, firstName, and lastName are required.');
    }

    const [email, firstName, lastName, phone] = guestValues(req.body);
    let client;

    try {
      client = await db.connect();
      await client.query('BEGIN');

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [email, phone ?? '']
      );

      const found = await client.query(
        `SELECT ${guestFields}
         FROM guests
         WHERE LOWER(email) = $1
            OR ($2::text IS NOT NULL AND $2 <> ''
                AND REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2)
         LIMIT 1
         FOR UPDATE`,
        [email, phone ? phone.replace(/\D/g, '') : null]
      );

      if (found.rowCount) {
        await client.query('COMMIT');
        return res.status(200).json(found.rows[0]);
      }

      const created = await client.query(
        `INSERT INTO guests (id, email, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${guestFields}`,
        [randomUUID(), email, firstName, lastName, phone]
      );

      await client.query('COMMIT');
      return res.status(201).json(created.rows[0]);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) {
        return errorResponse(res, 409, 'Conflict', 'A guest with that email or phone already exists.');
      }
      return next(error);
    } finally {
      client?.release();
    }
  });

  app.get('/guests/search', async (req, res, next) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      return errorResponse(res, 400, 'BadRequest', 'A non-empty q search parameter is required.');
    }

    try {
      const result = await db.query(
        `SELECT ${guestFields}
         FROM guests
         WHERE email ILIKE $1
            OR first_name ILIKE $1
            OR last_name ILIKE $1
            OR COALESCE(phone, '') ILIKE $1
         ORDER BY last_name, first_name, id`,
        [`%${query}%`]
      );

      return res.status(200).json({ guests: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.put('/guests/:id', async (req, res, next) => {
    if (!validGuest(req.body)) {
      return errorResponse(res, 400, 'BadRequest', 'Valid email, firstName, and lastName are required.');
    }

    try {
      const [email, firstName, lastName, phone] = guestValues(req.body);
      const result = await db.query(
        `UPDATE guests
         SET email = $2, first_name = $3, last_name = $4, phone = $5,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${guestFields}`,
        [req.params.id, email, firstName, lastName, phone]
      );

      if (!result.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      return res.status(200).json(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return errorResponse(res, 409, 'Conflict', 'A guest with that email or phone already exists.');
      }
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
