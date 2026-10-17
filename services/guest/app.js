import { randomUUID } from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { buildGuest } from './guest-builder.js';

const guestFields = `
  id,
  email,
  first_name AS "firstName",
  last_name AS "lastName",
  phone,
  address,
  id_document AS "idDocument",
  preferences,
  loyalty_tier AS "loyaltyTier",
  loyalty_number AS "loyaltyNumber",
  consent_at AS "consentAt"
`;

function guestRowValues(guest) {
  return [
    guest.email,
    guest.firstName,
    guest.lastName,
    guest.phone,
    guest.address,
    guest.idDocument,
    guest.preferences,
    guest.loyaltyTier,
    guest.loyaltyNumber,
    guest.consentAt
  ];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function actorFromRequest(req) {
  return {
    id: req.headers['x-user-id'] || null,
    role: req.headers['x-user-role'] || 'agent',
  };
}

function serializeGuest(row, actor) {
  const isOwner = actor.role === 'guest' && actor.id === row.id;
  const canSeeFullDocument = actor.role === 'manager' || isOwner;
  return {
    ...row,
    idDocument: canSeeFullDocument ? row.idDocument : maskDocument(row.idDocument),
  };
}

function isUniqueViolation(error) {
  return error.code === '23505';
}

function internalTokenGuard(req, res, next) {
  const required = process.env.INTERNAL_TOKEN;
  if (!required) return next();
  if (req.headers['x-internal-token'] !== required) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function guestResponseFields(role = 'agent', requesterGuestId) {
  const masked = role === 'manager' || role === 'guest';
  return {
    maskIdDocument: masked && requesterGuestId,
  };
}

function maskDocument(value) {
  if (typeof value !== 'string' || !value) return value ?? null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Asks the reservation service whether the guest has a current or upcoming confirmed stay.
async function guestHasActiveReservations(guestId) {
  const base = (process.env.RESERVATION_SERVICE_URL || 'http://reservation:3000').replace(/\/$/, '');
  const query = new URLSearchParams({ guestId, status: 'confirmed', from: localDate(new Date()) });
  const response = await fetch(`${base}/reservations?${query}`, {
    headers: process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}
  });
  if (!response.ok) throw new Error(`Reservation lookup failed (${response.status})`);
  const data = await response.json();
  return (data.reservations ?? []).length > 0;
}

export function createApp({ db = pool, hasActiveReservations = guestHasActiveReservations } = {}) {
  const app = express();
  app.use(express.json());
  app.use(internalTokenGuard);

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/auth/register', async (req, res, next) => {
    const { password } = req.body ?? {};
    const built = buildGuest(req.body);
    if (built.error) {
      return errorResponse(res, 400, 'BadRequest', built.error);
    }
    if (typeof password !== 'string' || password.length < 8) {
      return errorResponse(res, 400, 'BadRequest', 'A password of at least 8 characters is required.');
    }

    const guest = built.guest;
    if (req.headers['x-user-role'] !== 'manager') {
      guest.loyaltyTier = 'none';
      guest.loyaltyNumber = null;
    }
    let client;

    try {
      client = await db.connect();
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [guest.email, guest.phone ?? '']
      );

      const found = await client.query(
        `SELECT ${guestFields}, password_hash AS "passwordHash"
         FROM guests
         WHERE LOWER(email) = $1
         LIMIT 1
         FOR UPDATE`,
        [guest.email]
      );

      if (found.rowCount) {
        if (found.rows[0].passwordHash !== null) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Conflict' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        await client.query(
          `UPDATE guests SET password_hash = $2 WHERE id = $1`,
          [found.rows[0].id, passwordHash]
        );
        await client.query('COMMIT');
        return res.status(200).json({ guestId: found.rows[0].id });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const created = await client.query(
        `INSERT INTO guests (
           id, email, first_name, last_name, phone, address, id_document,
           preferences, loyalty_tier, loyalty_number, consent_at, password_hash
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id AS "guestId", ${guestFields}`,
        [randomUUID(), guest.email, guest.firstName, guest.lastName, guest.phone, guest.address, guest.idDocument, guest.preferences, guest.loyaltyTier, guest.loyaltyNumber, guest.consentAt, passwordHash]
      );

      await client.query('COMMIT');
      return res.status(201).json(created.rows[0]);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client?.release();
    }
  });

  app.post('/auth/login', async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return errorResponse(res, 400, 'BadRequest', 'Valid email and password are required.');
    }

    try {
      const result = await db.query(
        `SELECT id AS "guestId", email, password_hash AS "passwordHash"
         FROM guests WHERE LOWER(email) = $1`,
        [email]
      );
      if (!result.rowCount || !result.rows[0].passwordHash) {
        return errorResponse(res, 401, 'Unauthorized', 'Invalid credentials.');
      }

      const ok = await bcrypt.compare(password, result.rows[0].passwordHash);
      if (!ok) {
        return errorResponse(res, 401, 'Unauthorized', 'Invalid credentials.');
      }

      return res.status(200).json({
        guestId: result.rows[0].guestId,
        role: 'guest',
        email: result.rows[0].email,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/guests/get-or-create', async (req, res, next) => {
    const built = buildGuest(req.body);
    if (built.error) {
      return errorResponse(res, 400, 'BadRequest', built.error);
    }
    const actor = actorFromRequest(req);

    const guest = built.guest;
    if (actor.role !== 'manager') {
      guest.loyaltyTier = 'none';
      guest.loyaltyNumber = null;
    }
    let client;

    try {
      client = await db.connect();
      await client.query('BEGIN');

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [guest.email, guest.phone ?? '']
      );

      const found = await client.query(
        `SELECT ${guestFields}
         FROM guests
         WHERE LOWER(email) = $1
            OR ($2::text IS NOT NULL AND $2 <> ''
                AND REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2)
         LIMIT 1
         FOR UPDATE`,
        [guest.email, guest.phone ? guest.phone.replace(/\D/g, '') : null]
      );

      if (found.rowCount) {
        // Keep the stored profile, but fill details the guest has given for the first time.
        const filled = await client.query(
          `UPDATE guests
           SET id_document = COALESCE(NULLIF(id_document, ''), $2),
               address = COALESCE(NULLIF(address, ''), $3),
               updated_at = NOW()
           WHERE id = $1
           RETURNING ${guestFields}`,
          [found.rows[0].id, guest.idDocument, guest.address]
        );
        await client.query('COMMIT');
        return res.status(200).json(serializeGuest(filled.rows[0], actor));
      }

      const created = await client.query(
        `INSERT INTO guests (
           id, email, first_name, last_name, phone, address, id_document,
           preferences, loyalty_tier, loyalty_number, consent_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${guestFields}`,
        [randomUUID(), ...guestRowValues(guest)]
      );

      await client.query('COMMIT');
      return res.status(201).json(serializeGuest(created.rows[0], actor));
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) {
        return errorResponse(res, 409, 'Conflict', 'A guest with that email, phone, or loyalty number already exists.');
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
      const actor = actorFromRequest(req);
      const result = await db.query(
        `SELECT ${guestFields}
         FROM guests
         WHERE email ILIKE $1
            OR first_name ILIKE $1
            OR last_name ILIKE $1
            OR COALESCE(phone, '') ILIKE $1
            OR COALESCE(loyalty_number, '') ILIKE $1
         ORDER BY last_name, first_name, id`,
        [`%${query}%`]
      );

      return res.status(200).json({ guests: result.rows.map((row) => serializeGuest(row, actor)) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/guests', async (req, res, next) => {
    // With ids: brief name lookups. Without: the full guest directory for staff.
    if (typeof req.query.ids === 'string') {
      const ids = req.query.ids.split(',').map((item) => item.trim()).filter((item) => UUID_PATTERN.test(item));
      if (!ids.length) {
        return errorResponse(res, 400, 'BadRequest', 'A non-empty ids query parameter is required.');
      }
      try {
        const result = await db.query(
          `SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone
           FROM guests WHERE id = ANY($1::uuid[]) ORDER BY last_name, first_name, id`,
          [ids]
        );
        return res.status(200).json({ guests: result.rows });
      } catch (error) {
        return next(error);
      }
    }

    try {
      const actor = actorFromRequest(req);
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const result = await db.query(
        `SELECT ${guestFields},
                created_at AS "createdAt",
                (password_hash IS NOT NULL) AS "hasAccount"
         FROM guests
         WHERE $1 = ''
            OR email ILIKE '%' || $1 || '%'
            OR first_name ILIKE '%' || $1 || '%'
            OR last_name ILIKE '%' || $1 || '%'
            OR (first_name || ' ' || last_name) ILIKE '%' || $1 || '%'
            OR COALESCE(phone, '') ILIKE '%' || $1 || '%'
            OR COALESCE(loyalty_number, '') ILIKE '%' || $1 || '%'
         ORDER BY last_name, first_name, id`,
        [query]
      );
      return res.status(200).json({ guests: result.rows.map((row) => serializeGuest(row, actor)) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/guests/:id/export', async (req, res, next) => {
    try {
      const actor = actorFromRequest(req);
      const result = await db.query(
        `SELECT ${guestFields} FROM guests WHERE id = $1`,
        [req.params.id]
      );
      if (!result.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      return res.status(200).json({
        guest: serializeGuest(result.rows[0], actor),
        exportedAt: new Date().toISOString()
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/guests/:id', async (req, res, next) => {
    try {
      const actor = actorFromRequest(req);
      const result = await db.query(
        `SELECT ${guestFields} FROM guests WHERE id = $1`,
        [req.params.id]
      );
      if (!result.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      return res.status(200).json(serializeGuest(result.rows[0], actor));
    } catch (error) {
      return next(error);
    }
  });

  app.put('/guests/:id', async (req, res, next) => {
    const built = buildGuest(req.body);
    if (built.error) {
      return errorResponse(res, 400, 'BadRequest', built.error);
    }
    const actor = actorFromRequest(req);
    const loyaltyTierProvided = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'loyaltyTier');

    try {
      const guest = built.guest;
      const current = await db.query(
        `SELECT ${guestFields} FROM guests WHERE id = $1`,
        [req.params.id]
      );
      if (!current.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      if (actor.role === 'guest' && guest.email !== current.rows[0].email) {
        return errorResponse(res, 403, 'Forbidden', 'Guests cannot change their account email.');
      }
      if (actor.role !== 'manager' && loyaltyTierProvided && guest.loyaltyTier !== current.rows[0].loyaltyTier) {
        return errorResponse(res, 403, 'Forbidden', 'Only managers can change loyalty tier.');
      }
      if (actor.role !== 'manager' && !loyaltyTierProvided) {
        guest.loyaltyTier = current.rows[0].loyaltyTier;
      }
      if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'loyaltyNumber')) {
        guest.loyaltyNumber = current.rows[0].loyaltyNumber;
      }
      const result = await db.query(
        `UPDATE guests
         SET email = $2, first_name = $3, last_name = $4, phone = $5,
             address = $6, id_document = $7, preferences = $8,
             loyalty_tier = $9, loyalty_number = $10,
             consent_at = COALESCE($11::timestamptz, consent_at),
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${guestFields}`,
        [req.params.id, ...guestRowValues(guest)]
      );

      if (!result.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      return res.status(200).json(serializeGuest(result.rows[0], actor));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return errorResponse(res, 409, 'Conflict', 'A guest with that email, phone, or loyalty number already exists.');
      }
      return next(error);
    }
  });

  app.delete('/guests/:id', async (req, res, next) => {
    try {
      const existing = await db.query('SELECT id FROM guests WHERE id::text = $1', [req.params.id]);
      if (!existing.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
      let active;
      try {
        active = await hasActiveReservations(req.params.id);
      } catch (error) {
        console.error(error);
        return errorResponse(res, 503, 'ServiceUnavailable', 'Could not check the guest\'s reservations. Please try again.');
      }
      if (active) {
        return errorResponse(res, 409, 'Conflict', 'This guest has current or upcoming reservations. Cancel them before deleting the profile.');
      }

      const result = await db.query(
        'DELETE FROM guests WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (!result.rowCount) {
        return errorResponse(res, 404, 'NotFound', 'Guest not found.');
      }
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
