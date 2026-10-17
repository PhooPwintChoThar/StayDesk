import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db.js';

let activeReservations = false;
const app = createApp({ hasActiveReservations: async () => activeReservations });

beforeAll(async () => {
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  await pool.query('TRUNCATE guests CASCADE');
  activeReservations = false;
});

afterAll(async () => {
  await pool.end();
});

describe('guest endpoints', () => {
  it('reports service health', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('creates a guest and finds an existing guest by email or phone', async () => {
    const created = await request(app).post('/guests/get-or-create').send({
      email: 'guest@example.com',
      firstName: 'Test',
      lastName: 'Guest',
      phone: '+66 123-456-789'
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email: 'guest@example.com',
      firstName: 'Test',
      lastName: 'Guest'
    });

    const byEmail = await request(app).post('/guests/get-or-create').send({
      email: 'GUEST@example.com',
      firstName: 'Different',
      lastName: 'Name'
    });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.id).toBe(created.body.id);

    const byPhone = await request(app).post('/guests/get-or-create').send({
      email: 'another@example.com',
      firstName: 'Different',
      lastName: 'Name',
      phone: '66123456789'
    });
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.id).toBe(created.body.id);
  });

  it('searches guests by name or email', async () => {
    await request(app).post('/guests/get-or-create').send({
      email: 'guest@example.com',
      firstName: 'Sam',
      lastName: 'Aung'
    });

    const response = await request(app).get('/guests/search').query({ q: 'sam' });

    expect(response.status).toBe(200);
    expect(response.body.guests).toHaveLength(1);
    expect(response.body.guests[0]).toMatchObject({
      email: 'guest@example.com',
      firstName: 'Sam'
    });
  });

  it('updates a guest', async () => {
    const created = await request(app).post('/guests/get-or-create').send({
      email: 'guest@example.com',
      firstName: 'Test',
      lastName: 'Guest'
    });

    const response = await request(app).put(`/guests/${created.body.id}`).send({
      email: 'updated@example.com',
      firstName: 'Updated',
      lastName: 'Guest',
      phone: '5551234'
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: created.body.id,
      email: 'updated@example.com',
      firstName: 'Updated',
      phone: '5551234'
    });
  });

  it('lets a guest update profile details without changing their email', async () => {
    const created = await request(app)
      .post('/guests/get-or-create')
      .set('x-user-role', 'manager')
      .send({
        email: 'guest@example.com',
        firstName: 'Test',
        lastName: 'Guest',
        loyaltyNumber: 'LEGACY-1'
      });

    const response = await request(app)
      .put(`/guests/${created.body.id}`)
      .set('x-user-id', created.body.id)
      .set('x-user-role', 'guest')
      .send({
        email: 'guest@example.com',
        firstName: 'Test',
        lastName: 'Guest',
        phone: '5551234',
        idDocument: 'PASSPORT-123',
        preferences: 'Quiet room'
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      email: 'guest@example.com',
      phone: '5551234',
      idDocument: 'PASSPORT-123',
      preferences: 'Quiet room',
      loyaltyNumber: 'LEGACY-1'
    });

    const stored = await request(app)
      .get(`/guests/${created.body.id}`)
      .set('x-user-id', created.body.id)
      .set('x-user-role', 'guest');
    expect(stored.body.idDocument).toBe('PASSPORT-123');
  });

  it('does not let a guest change their account email', async () => {
    const created = await request(app).post('/guests/get-or-create').send({
      email: 'guest@example.com',
      firstName: 'Test',
      lastName: 'Guest'
    });

    const response = await request(app)
      .put(`/guests/${created.body.id}`)
      .set('x-user-id', created.body.id)
      .set('x-user-role', 'guest')
      .send({
        email: 'new@example.com',
        firstName: 'Test',
        lastName: 'Guest'
      });

    expect(response.status).toBe(403);
    const stored = await request(app)
      .get(`/guests/${created.body.id}`)
      .set('x-user-id', created.body.id)
      .set('x-user-role', 'guest');
    expect(stored.body.email).toBe('guest@example.com');
  });

  it('stores profile extras, exports them, and deletes the guest', async () => {
    const created = await request(app).post('/guests/get-or-create').send({
      email: 'loyalty@example.com',
      firstName: 'Loyal',
      lastName: 'Guest',
      address: '12 Market Street',
      idDocument: 'P1234567',
      preferences: 'High floor',
      loyaltyTier: 'gold',
      loyaltyNumber: 'GOLD-1',
      consent: true
    }).set('x-user-role', 'manager');

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      address: '12 Market Street',
      loyaltyTier: 'gold',
      loyaltyNumber: 'GOLD-1'
    });

    const found = await request(app).get('/guests/search').query({ q: 'GOLD-1' });
    expect(found.body.guests).toHaveLength(1);

    const exported = await request(app).get(`/guests/${created.body.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.guest.email).toBe('loyalty@example.com');
    expect(exported.body.exportedAt).toBeDefined();

    activeReservations = true;
    const blocked = await request(app).delete(`/guests/${created.body.id}`);
    expect(blocked.status).toBe(409);

    activeReservations = false;
    const deleted = await request(app).delete(`/guests/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect((await request(app).get(`/guests/${created.body.id}`)).status).toBe(404);
    expect((await request(app).delete(`/guests/${created.body.id}`)).status).toBe(404);
  });

  it('registers and logs in a guest with a password', async () => {
    const registered = await request(app).post('/auth/register').send({
      email: 'auth@example.com',
      password: 'secret123',
      firstName: 'Auth',
      lastName: 'Guest',
      loyaltyTier: 'gold',
      loyaltyNumber: 'GOLD-AUTH'
    });

    expect(registered.status).toBe(201);
    expect(registered.body.guestId).toEqual(expect.any(String));
    expect(registered.body).toMatchObject({ loyaltyTier: 'none', loyaltyNumber: null });

    const loggedIn = await request(app).post('/auth/login').send({
      email: 'auth@example.com',
      password: 'secret123'
    });

    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body).toMatchObject({
      guestId: registered.body.guestId,
      role: 'guest'
    });
  });

  it('does not allow registration to overwrite an existing password or profile', async () => {
    const registered = await request(app).post('/auth/register').send({
      email: 'protected@example.com',
      password: 'original123',
      firstName: 'Original',
      lastName: 'Guest'
    });

    const takeover = await request(app).post('/auth/register').send({
      email: 'protected@example.com',
      password: 'attacker123',
      firstName: 'Changed',
      lastName: 'Profile',
      loyaltyTier: 'gold'
    });

    const login = await request(app).post('/auth/login').send({
      email: 'protected@example.com',
      password: 'original123'
    });
    const guest = await request(app).get(`/guests/${registered.body.guestId}`);

    expect(takeover.status).toBe(409);
    expect(takeover.body).toEqual({ error: 'Conflict' });
    expect(login.status).toBe(200);
    expect(guest.body).toMatchObject({
      firstName: 'Original',
      lastName: 'Guest',
      loyaltyTier: 'none'
    });
  });

  it('sets a password for a booking guest without changing their profile', async () => {
    const profile = await request(app).post('/guests/get-or-create').send({
      email: 'booking@example.com',
      firstName: 'Booking',
      lastName: 'Guest',
      phone: '+66 555 1234',
      loyaltyTier: 'gold',
      loyaltyNumber: 'GOLD-BOOKING'
    });

    const registered = await request(app).post('/auth/register').send({
      email: 'booking@example.com',
      password: 'newsecret123',
      firstName: 'Changed',
      lastName: 'Name',
      phone: '0000000000',
      loyaltyTier: 'platinum'
    });
    const stored = await request(app).get(`/guests/${profile.body.id}`);
    const login = await request(app).post('/auth/login').send({
      email: 'booking@example.com',
      password: 'newsecret123'
    });

    expect(registered.status).toBe(200);
    expect(registered.body).toEqual({ guestId: profile.body.id });
    expect(stored.body).toMatchObject({
      firstName: 'Booking',
      lastName: 'Guest',
      phone: '+66 555 1234',
      loyaltyTier: 'none',
      loyaltyNumber: null
    });
    expect(login.status).toBe(200);
  });

  it('ignores non-manager loyalty assignment while preserving an existing tier', async () => {
    const ignored = await request(app).post('/guests/get-or-create').send({
      email: 'ignored-tier@example.com',
      firstName: 'No',
      lastName: 'Tier',
      loyaltyTier: 'gold',
      loyaltyNumber: 'GOLD-IGNORED'
    });
    const managed = await request(app).post('/guests/get-or-create')
      .set('x-user-role', 'manager')
      .send({
        email: 'managed-tier@example.com',
        firstName: 'Managed',
        lastName: 'Tier',
        loyaltyTier: 'gold',
        loyaltyNumber: 'GOLD-MANAGED'
      });
    const unchanged = await request(app).post('/guests/get-or-create')
      .set('x-user-role', 'agent')
      .send({
        email: 'managed-tier@example.com',
        firstName: 'Changed',
        lastName: 'Name',
        loyaltyTier: 'platinum',
        loyaltyNumber: 'PLATINUM-ATTEMPT'
      });

    expect(ignored.body).toMatchObject({ loyaltyTier: 'none', loyaltyNumber: null });
    expect(managed.body).toMatchObject({ loyaltyTier: 'gold', loyaltyNumber: 'GOLD-MANAGED' });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ loyaltyTier: 'gold', loyaltyNumber: 'GOLD-MANAGED' });
  });

  it('returns 404 when updating an unknown guest', async () => {
    const response = await request(app).put('/guests/00000000-0000-0000-0000-000000000001').send({
      email: 'missing@example.com',
      firstName: 'Missing',
      lastName: 'Guest'
    });

    expect(response.status).toBe(404);
  });

  it('validates search and guest input', async () => {
    const emptySearch = await request(app).get('/guests/search');
    const invalidGuest = await request(app).post('/guests/get-or-create').send({ email: 'bad' });

    expect(emptySearch.status).toBe(400);
    expect(invalidGuest.status).toBe(400);
  });

  it('stores a passport number given at booking on an existing profile without overwriting one', async () => {
    const created = await request(app).post('/guests/get-or-create').send({
      email: 'returning@example.com', firstName: 'Re', lastName: 'Turn'
    });

    const withPassport = await request(app).post('/guests/get-or-create').set('x-user-role', 'manager').send({
      email: 'returning@example.com', firstName: 'Re', lastName: 'Turn', idDocument: 'P7654321'
    });
    const another = await request(app).post('/guests/get-or-create').set('x-user-role', 'manager').send({
      email: 'returning@example.com', firstName: 'Re', lastName: 'Turn', idDocument: 'OTHER-1'
    });

    expect(withPassport.status).toBe(200);
    expect(withPassport.body).toMatchObject({ id: created.body.id, idDocument: 'P7654321' });
    expect(another.body.idDocument).toBe('P7654321');
  });

  it('lists every guest profile for staff, masking ID numbers for agents', async () => {
    await request(app).post('/auth/register').send({
      email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', password: 'secret123', idDocument: 'P1234567'
    });
    await request(app).post('/guests/get-or-create').send({ email: 'walkin@example.com', firstName: 'Walk', lastName: 'In' });

    const asAgent = await request(app).get('/guests').set('x-user-role', 'agent');
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.guests.map((guest) => [guest.email, guest.hasAccount])).toEqual([
      ['walkin@example.com', false],
      ['ada@example.com', true]
    ]);
    expect(asAgent.body.guests[1]).toMatchObject({ idDocument: '****4567', createdAt: expect.any(String) });

    const asManager = await request(app).get('/guests').query({ q: 'ada love' }).set('x-user-role', 'manager');
    expect(asManager.body.guests).toHaveLength(1);
    expect(asManager.body.guests[0].idDocument).toBe('P1234567');

    expect((await request(app).get('/guests').query({ ids: 'not-a-uuid' })).status).toBe(400);

    await request(app).post('/guests/get-or-create').set('x-user-role', 'manager')
      .send({ email: 'gold@example.com', firstName: 'Gold', lastName: 'Member', loyaltyTier: 'gold', loyaltyNumber: 'GOLD-77' });
    const byLoyalty = await request(app).get('/guests').query({ q: 'gold-77' }).set('x-user-role', 'agent');
    expect(byLoyalty.body.guests.map((guest) => guest.email)).toEqual(['gold@example.com']);
  });
});

