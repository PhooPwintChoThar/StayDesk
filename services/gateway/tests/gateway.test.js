import jwt from 'jsonwebtoken';
import nock from 'nock';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';

const secret = 'gateway-test-secret';
const roomRateUrl = 'http://room-rate.test';
const reservationUrl = 'http://reservation.test';
const guestUrl = 'http://guest.test';
const billingUrl = 'http://billing.test';

function token(role, claims = {}) {
  return jwt.sign({ ...claims, role }, secret);
}

function uniqueIp(tag) {
  return `203.0.113.${tag}`;
}

describe('gateway authentication and proxying', () => {
  beforeAll(() => {
    process.env.ROOM_RATE_SERVICE_URL = roomRateUrl;
    process.env.RESERVATION_SERVICE_URL = reservationUrl;
    process.env.GUEST_SERVICE_URL = guestUrl;
    process.env.BILLING_SERVICE_URL = billingUrl;
    process.env.USERS_JSON = JSON.stringify([
      {
        username: 'agent',
        role: 'agent',
        passwordHash: bcrypt.hashSync('agent123', 10)
      },
      {
        username: 'reception',
        role: 'agent',
        passwordHash: bcrypt.hashSync('reception123', 10)
      },
      {
        username: 'manager',
        role: 'manager',
        passwordHash: bcrypt.hashSync('manager123', 10)
      }
    ]);
  });

  beforeEach(() => {
    process.env.ALLOW_DEV_LOGIN = 'false';
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    delete process.env.USERS_JSON;
    delete process.env.ALLOW_DEV_LOGIN;
  });

  afterAll(() => nock.restore());

  it('allows public availability search without a token', async () => {
    const app = createApp({ secret });
    nock(roomRateUrl)
      .get('/availability')
      .query(true)
      .reply(200, { availability: [] });

    const response = await request(app).get('/availability').query({
      checkIn: '2027-03-10',
      checkOut: '2027-03-12'
    });

    expect(response.status).toBe(200);
  });

  it('allows room type selection data without a token', async () => {
    const app = createApp({ secret });
    const upstream = nock(roomRateUrl)
      .get('/room-types')
      .reply(200, { roomTypes: [{ id: 'standard', name: 'Standard' }] });

    const response = await request(app).get('/room-types');

    expect(response.status).toBe(200);
    expect(response.body.roomTypes).toEqual([{ id: 'standard', name: 'Standard' }]);
    expect(upstream.isDone()).toBe(true);
  });

  it('returns 401 when the JWT is missing or invalid', async () => {
    const app = createApp({ secret });

    const missing = await request(app).get('/reservations');
    const invalid = await request(app)
      .get('/reservations')
      .set('Authorization', 'Bearer invalid-token');

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it('accepts credential login when dev login is off', async () => {
    process.env.ALLOW_DEV_LOGIN = 'false';
    const app = createApp({ secret });

    const success = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('10'))
      .send({ username: 'agent', password: 'agent123' });

    const failure = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('11'))
      .send({ username: 'agent', password: 'bad-password' });

    const disabledDevLogin = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('12'))
      .send({ role: 'manager' });

    expect(success.status).toBe(200);
    expect(jwt.verify(success.body.token, secret)).toMatchObject({ role: 'agent', sub: 'agent' });
    expect(failure.status).toBe(401);
    expect(disabledDevLogin.status).toBe(400);
  });

  it.each([
    ['reception', 'reception123', 'agent'],
    ['manager', 'manager123', 'manager']
  ])('accepts the %s demo credentials', async (username, password, role) => {
    const app = createApp({ secret });
    const response = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('15'))
      .send({ username, password });

    expect(response.status).toBe(200);
    expect(jwt.verify(response.body.token, secret)).toMatchObject({
      role,
      sub: username
    });
  });

  it('accepts dev login only when explicitly enabled', async () => {
    process.env.ALLOW_DEV_LOGIN = 'true';
    const app = createApp({ secret });

    const response = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('13'))
      .send({ role: 'manager' });

    expect(response.status).toBe(200);
    expect(jwt.verify(response.body.token, secret)).toMatchObject({ role: 'manager' });
  });

  it('rate limits repeated login attempts from the same ip', async () => {
    process.env.ALLOW_DEV_LOGIN = 'false';
    const app = createApp({ secret });
    const ip = uniqueIp('14');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await request(app)
        .post('/login')
        .set('X-Forwarded-For', ip)
        .send({ username: 'agent', password: 'bad-password' });
      expect(response.status).toBe(401);
    }

    const limited = await request(app)
      .post('/login')
      .set('X-Forwarded-For', ip)
      .send({ username: 'agent', password: 'bad-password' });

    expect(limited.status).toBe(429);
  });

  it('returns 403 when a guest requests an agent-only route', async () => {
    const app = createApp({ secret });

    const response = await request(app)
      .get('/guests/search?q=smith')
      .set('Authorization', `Bearer ${token('guest')}`);

    expect(response.status).toBe(403);
  });

  it('never exposes internal hold, deposit or refund endpoints', async () => {
    const app = createApp({ secret });

    for (const [method, path] of [['post', '/deposits'], ['post', '/refunds'], ['post', '/holds'], ['delete', '/holds/h-1'], ['get', '/payments/reservations/R-1/totals'], ['post', '/settlements'], ['post', '/deposits/capture']]) {
      const response = await request(app)[method](path)
        .set('Authorization', `Bearer ${token('manager', { sub: 'manager' })}`)
        .send({});
      expect(response.status).toBe(404);
    }
  });

  it('passes payment files and room photos through byte for byte', async () => {
    const app = createApp({ secret });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe, 0x80]);
    nock(billingUrl)
      .get('/payments/proofs/p-1/file')
      .times(2)
      .reply(200, png, { 'Content-Type': 'image/png', 'Content-Disposition': "attachment; filename*=UTF-8''p.png" });
    nock(roomRateUrl)
      .get('/room-types/standard/photos/ph-1')
      .reply(200, png, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    const binary = (req) => req.buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

    for (let view = 0; view < 2; view += 1) {
      const file = await binary(request(app)
        .get('/payments/proofs/p-1/file')
        .set('Authorization', `Bearer ${token('agent', { sub: 'agent' })}`));
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['content-disposition']).toContain('p.png');
      expect(Buffer.compare(file.body, png)).toBe(0);
    }

    const photo = await binary(request(app).get('/room-types/standard/photos/ph-1'));
    expect(photo.status).toBe(200);
    expect(photo.headers['cache-control']).toContain('max-age');
    expect(Buffer.compare(photo.body, png)).toBe(0);
  });

  it('keeps payment approval internal and check-in for staff only', async () => {
    const app = createApp({ secret });
    nock(reservationUrl).post('/reservations/R-1/check-in').reply(200, { checkedInAt: 'now' });

    const approve = await request(app)
      .post('/reservations/R-1/payment-approved')
      .set('Authorization', `Bearer ${token('manager', { sub: 'manager' })}`);
    const guestCheckIn = await request(app)
      .post('/reservations/R-1/check-in')
      .set('Authorization', `Bearer ${token('guest', { guestId: 'g-1' })}`);
    const agentCheckIn = await request(app)
      .post('/reservations/R-1/check-in')
      .set('Authorization', `Bearer ${token('agent', { sub: 'reception' })}`);

    expect(approve.status).toBe(404);
    expect(guestCheckIn.status).toBe(403);
    expect(agentCheckIn.status).toBe(200);
  });

  it('keeps the guest directory and booking counts for staff only', async () => {
    const app = createApp({ secret });
    nock(reservationUrl).get('/reservations/guest-counts').reply(200, { counts: [] });
    nock(guestUrl).get('/guests').reply(200, { guests: [] });
    nock(reservationUrl).get('/reservations/guest-counts').reply(200, { counts: [] });
    const guestToken = `Bearer ${token('guest', { guestId: 'g-1' })}`;
    const agentToken = `Bearer ${token('agent', { sub: 'reception' })}`;

    expect((await request(app).get('/guests').set('Authorization', guestToken)).status).toBe(403);
    expect((await request(app).get('/reservations/guest-counts').set('Authorization', guestToken)).status).toBe(403);
    expect((await request(app).get('/guests').set('Authorization', agentToken)).status).toBe(200);
    expect((await request(app).get('/reservations/guest-counts').set('Authorization', agentToken)).status).toBe(200);
  });

  it('sends the internal token on guest sign-in and registration', async () => {
    process.env.INTERNAL_TOKEN = 'internal-secret';
    try {
      const app = createApp({ secret });
      const register = nock(guestUrl, { reqheaders: { 'x-internal-token': 'internal-secret' } })
        .post('/auth/register').reply(201, { guestId: 'g-9' });
      const login = nock(guestUrl, { reqheaders: { 'x-internal-token': 'internal-secret' } })
        .post('/auth/login').reply(200, { guestId: 'g-9' });

      expect((await request(app).post('/auth/register').send({ email: 'a@b.c' })).status).toBe(201);
      const signIn = await request(app).post('/login').set('x-forwarded-for', uniqueIp(77)).send({ username: 'a@b.c', password: 'secret123' });
      expect(signIn.status).toBe(200);
      expect(register.isDone() && login.isDone()).toBe(true);
    } finally {
      delete process.env.INTERNAL_TOKEN;
    }
  });

  it('lets agents check room availability', async () => {
    const app = createApp({ secret });
    nock(roomRateUrl).get('/rooms/availability').query(true).reply(200, { rooms: [] });

    const response = await request(app)
      .get('/rooms/availability?checkIn=2027-01-01&checkOut=2027-01-02')
      .set('Authorization', `Bearer ${token('agent', { sub: 'reception' })}`);

    expect(response.status).toBe(200);
  });

  it('lets only managers change rooms and room types, and keeps rooms away from guests', async () => {
    const app = createApp({ secret });
    const upstream = nock(roomRateUrl)
      .post('/room-types')
      .reply(201, { id: 'suite' })
      .put('/rooms/r-1/maintenance')
      .reply(200, { id: 'r-1', status: 'maintenance' })
      .get('/rooms')
      .reply(200, { rooms: [] });

    const agentCreate = await request(app)
      .post('/rooms')
      .set('Authorization', `Bearer ${token('agent', { sub: 'agent' })}`)
      .send({ roomNumber: '1' });
    const agentMaintenance = await request(app)
      .put('/rooms/r-1/maintenance')
      .set('Authorization', `Bearer ${token('agent', { sub: 'agent' })}`)
      .send({});
    const guestList = await request(app)
      .get('/rooms')
      .set('Authorization', `Bearer ${token('guest', { guestId: 'g-1' })}`);
    const managerType = await request(app)
      .post('/room-types')
      .set('Authorization', `Bearer ${token('manager', { sub: 'manager' })}`)
      .send({ name: 'Suite' });
    const managerMaintenance = await request(app)
      .put('/rooms/r-1/maintenance')
      .set('Authorization', `Bearer ${token('manager', { sub: 'manager' })}`)
      .send({ from: '2027-01-01', to: '2027-01-02' });
    const agentList = await request(app)
      .get('/rooms')
      .set('Authorization', `Bearer ${token('agent', { sub: 'agent' })}`);

    expect(agentCreate.status).toBe(403);
    expect(agentMaintenance.status).toBe(403);
    expect(guestList.status).toBe(403);
    expect(managerType.status).toBe(201);
    expect(managerMaintenance.status).toBe(200);
    expect(agentList.status).toBe(200);
    expect(upstream.isDone()).toBe(true);
  });

  it('issues a JWT for a credential login', async () => {
    const app = createApp({ secret });

    const response = await request(app)
      .post('/login')
      .send({ username: 'agent', password: 'agent123' });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
    const decoded = jwt.verify(response.body.token, secret);
    expect(decoded.role).toBe('agent');
  });

  it('lets a guest look up, modify, or cancel a reservation by confirmation number', async () => {
    const app = createApp({ secret });
    nock(reservationUrl)
      .get('/reservations/R-10001')
      .twice()
      .reply(200, { reservationNo: 'R-10001', guestId: 'guest-123', status: 'confirmed' });

    const response = await request(app)
      .get('/reservations/R-10001')
      .set('Authorization', `Bearer ${token('guest', { guestId: 'guest-123' })}`);

    expect(response.status).toBe(200);
    expect(response.body.reservationNo).toBe('R-10001');
  });

  it('denies guest ownership routes when the JWT has no guestId', async () => {
    const app = createApp({ secret });

    const response = await request(app)
      .get('/reservations/R-10001')
      .set('Authorization', `Bearer ${token('guest')}`);

    expect(response.status).toBe(403);
  });

  it('forces guest reservation lists to their own guestId and uses guestId as identity', async () => {
    const app = createApp({ secret });
    const upstream = nock(reservationUrl)
      .get('/reservations')
      .query({ guestId: 'guest-123', status: 'confirmed' })
      .matchHeader('x-user-id', 'guest-123')
      .reply(200, { reservations: [{ reservationNo: 'R-10001', guestId: 'guest-123' }] });

    const response = await request(app)
      .get('/reservations')
      .query({
        guestId: ['another-guest', 'third-guest'],
        guestEmail: 'another@example.com',
        guestPhone: '5550000',
        status: 'confirmed'
      })
      .set('Authorization', `Bearer ${token('guest', { sub: 'guest@example.com', guestId: 'guest-123' })}`);

    expect(response.status).toBe(200);
    expect(response.body.reservations[0].guestId).toBe('guest-123');
    expect(upstream.isDone()).toBe(true);
  });

  it.each(['agent', 'manager'])('allows %s to list reservations using the staff subject', async (role) => {
    const app = createApp({ secret });
    const upstream = nock(reservationUrl)
      .get('/reservations')
      .query({ status: 'confirmed' })
      .matchHeader('x-user-id', `${role}-123`)
      .reply(200, { reservations: [] });

    const response = await request(app)
      .get('/reservations?status=confirmed')
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-123` })}`);

    expect(response.status).toBe(200);
    expect(upstream.isDone()).toBe(true);
  });

  it('allows a guest to create a reservation only for their authenticated email', async () => {
    const app = createApp({ secret });
    const upstream = nock(reservationUrl)
      .post('/reservations', {
        guest: { email: 'guest@example.com', firstName: 'Test', lastName: 'Guest' },
        roomTypeId: 'standard'
      })
      .matchHeader('x-user-id', 'guest-123')
      .reply(201, { reservationNo: 'R-10002', guestId: 'guest-123' });

    const response = await request(app)
      .post('/reservations')
      .set('Authorization', `Bearer ${token('guest', { sub: 'guest@example.com', guestId: 'guest-123' })}`)
      .send({
        guest: { email: 'guest@example.com', firstName: 'Test', lastName: 'Guest' },
        roomTypeId: 'standard'
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ guestId: 'guest-123' });
    expect(upstream.isDone()).toBe(true);
  });

  it('denies a guest from creating a reservation for a different email', async () => {
    const app = createApp({ secret });
    const response = await request(app)
      .post('/reservations')
      .set('Authorization', `Bearer ${token('guest', { sub: 'guest@example.com', guestId: 'guest-123' })}`)
      .send({ guest: { email: 'other@example.com' }, roomTypeId: 'standard' });

    expect(response.status).toBe(403);
  });

  it.each(['agent', 'manager'])('allows %s to create a reservation', async (role) => {
    const app = createApp({ secret });
    const upstream = nock(reservationUrl)
      .post('/reservations', { guest: { email: 'guest@example.com' }, roomTypeId: 'standard' })
      .matchHeader('x-user-id', `${role}-1`)
      .reply(201, { reservationNo: 'R-10003' });

    const response = await request(app)
      .post('/reservations')
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-1` })}`)
      .send({ guest: { email: 'guest@example.com' }, roomTypeId: 'standard' });

    expect(response.status).toBe(201);
    expect(upstream.isDone()).toBe(true);
  });

  it.each([
    ['payment-summary', { approvedAmount: 42.5, balanceDue: 107.5 }],
    ['cancellation-quote', { refundAmount: 45, feeAmount: 0 }]
  ])('allows an owning guest to read reservation %s', async (route, body) => {
    const app = createApp({ secret });
    nock(reservationUrl)
      .get('/reservations/R-10001')
      .matchHeader('x-user-id', 'guest-123')
      .reply(200, { reservationNo: 'R-10001', guestId: 'guest-123' });
    nock(reservationUrl)
      .get(`/reservations/R-10001/${route}`)
      .reply(200, body);

    const response = await request(app)
      .get(`/reservations/R-10001/${route}`)
      .set('Authorization', `Bearer ${token('guest', { guestId: 'guest-123' })}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
  });

  it.each([
    ['agent', 'payment-summary'],
    ['manager', 'payment-summary'],
    ['agent', 'cancellation-quote'],
    ['manager', 'cancellation-quote']
  ])('allows %s to read a reservation %s', async (role, route) => {
    const app = createApp({ secret });
    const body = { reservationNo: 'R-10001' };
    const upstream = nock(reservationUrl)
      .get(`/reservations/R-10001/${route}`)
      .matchHeader('x-user-id', `${role}-1`)
      .reply(200, body);

    const response = await request(app)
      .get(`/reservations/R-10001/${route}`)
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-1` })}`);

    expect(response.status).toBe(200);
    expect(upstream.isDone()).toBe(true);
  });

  it.each([
    ['payment-summary', { approvedAmount: 42.5 }],
    ['cancellation-quote', { refundAmount: 45 }]
  ])('denies a guest reading another guest reservation %s', async (route) => {
    const app = createApp({ secret });
    const ownershipLookup = nock(reservationUrl)
      .get('/reservations/R-10001')
      .reply(200, { reservationNo: 'R-10001', guestId: 'someone-else' });

    const response = await request(app)
      .get(`/reservations/R-10001/${route}`)
      .set('Authorization', `Bearer ${token('guest', { guestId: 'guest-123' })}`);

    expect(response.status).toBe(403);
    expect(ownershipLookup.isDone()).toBe(true);
  });

  it.each([
    ['guest', 403],
    ['agent', 403],
    ['manager', 204]
  ])('applies %s permissions to guest deletion', async (role, expectedStatus) => {
    const app = createApp({ secret });
    if (role === 'manager') {
      nock(guestUrl).delete('/guests/guest-123').reply(204);
    }

    const response = await request(app)
      .delete('/guests/guest-123')
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-1`, guestId: 'guest-123' })}`);

    expect(response.status).toBe(expectedStatus);
  });

  it.each([
    ['guest', 403],
    ['agent', 200],
    ['manager', 200]
  ])('applies %s permissions to guest export', async (role, expectedStatus) => {
    const app = createApp({ secret });
    if (role !== 'guest') {
      nock(guestUrl)
        .get('/guests/guest-123/export')
        .reply(200, { guest: { id: 'guest-123' } });
    }

    const response = await request(app)
      .get('/guests/guest-123/export')
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-1`, guestId: 'guest-123' })}`);

    expect(response.status).toBe(expectedStatus);
  });

  it.each([
    ['guest', 403],
    ['agent', 200],
    ['manager', 200]
  ])('applies %s permissions to payment proof review', async (role, expectedStatus) => {
    const app = createApp({ secret });
    if (role !== 'guest') {
      nock(billingUrl)
        .put('/payments/proofs/proof-1/review', { decision: 'approved' })
        .matchHeader('x-user-id', `${role}-1`)
        .reply(200, { proof: { id: 'proof-1', status: 'approved' } });
    }

    const response = await request(app)
      .put('/payments/proofs/proof-1/review')
      .set('Authorization', `Bearer ${token(role, { sub: `${role}-1`, guestId: 'guest-123' })}`)
      .send({ decision: 'approved' });

    expect(response.status).toBe(expectedStatus);
  });

  it('proxies an authorized request and returns the service response', async () => {
    const app = createApp({ secret });
    const upstream = nock(roomRateUrl)
      .get('/availability')
      .query({ checkIn: '2027-03-10', checkOut: '2027-03-12' })
      .reply(200, { availability: [{ roomTypeId: 'standard', available: true }] });

    const response = await request(app)
      .get('/availability')
      .query({ checkIn: '2027-03-10', checkOut: '2027-03-12' })
      .set('Authorization', `Bearer ${token('guest')}`);

    expect(response.status).toBe(200);
    expect(response.body.availability[0]).toMatchObject({
      roomTypeId: 'standard',
      available: true
    });
    expect(upstream.isDone()).toBe(true);
  });

  it('forwards multipart payment proof uploads intact', async () => {
    const app = createApp({ secret });
    const upstream = nock(billingUrl)
      .post('/payments/proofs', (body) => {
        const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
        return text.includes('R-10001') && text.includes('proof.pdf');
      })
      .matchHeader('content-type', (value) => String(value).includes('multipart/form-data'))
      .reply(201, { id: 'proof-1', status: 'pending' });

    const response = await request(app)
      .post('/payments/proofs')
      .set('Authorization', `Bearer ${token('guest')}`)
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('proof-bytes'), 'proof.pdf');

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'pending' });
    expect(upstream.isDone()).toBe(true);
  });

  it('completes a guest payment-proof flow through the gateway', async () => {
    const app = createApp({ secret });
    nock(guestUrl)
      .post('/auth/login', { email: 'guest@example.com', password: 'guestpass123' })
      .reply(200, { guestId: 'guest-123', role: 'guest' });
    const login = await request(app)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp('20'))
      .send({ username: 'guest@example.com', password: 'guestpass123' });
    expect(login.status).toBe(200);
    const guestAuth = `Bearer ${login.body.token}`;

    const reservations = nock(reservationUrl)
      .get('/reservations')
      .query({ guestId: 'guest-123' })
      .matchHeader('x-user-id', 'guest-123')
      .reply(200, { reservations: [{ reservationNo: 'R-10001', guestId: 'guest-123' }] });
    const listed = await request(app).get('/reservations?guestId=other-guest').set('Authorization', guestAuth);
    expect(listed.status).toBe(200);
    expect(listed.body.reservations[0].guestId).toBe('guest-123');
    expect(reservations.isDone()).toBe(true);

    const upload = nock(billingUrl)
      .post('/payments/proofs', (body) => {
        const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
        return text.includes('R-10001') && text.includes('evidence.pdf');
      })
      .matchHeader('content-type', (value) => String(value).includes('multipart/form-data'))
      .matchHeader('x-user-id', 'guest-123')
      .reply(201, { id: 'proof-e2e', status: 'pending' });
    const uploaded = await request(app)
      .post('/payments/proofs')
      .set('Authorization', guestAuth)
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('%PDF-1.4\npayment evidence'), 'evidence.pdf');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ id: 'proof-e2e', status: 'pending' });
    expect(upload.isDone()).toBe(true);

    const review = nock(billingUrl)
      .put('/payments/proofs/proof-e2e/review', { decision: 'approved' })
      .matchHeader('x-user-id', 'agent-1')
      .reply(200, { proof: { id: 'proof-e2e', status: 'approved' } });
    const reviewed = await request(app)
      .put('/payments/proofs/proof-e2e/review')
      .set('Authorization', `Bearer ${token('agent', { sub: 'agent-1' })}`)
      .send({ decision: 'approved' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.proof.status).toBe('approved');
    expect(review.isDone()).toBe(true);

    nock(reservationUrl)
      .get('/reservations/R-10001')
      .matchHeader('x-user-id', 'guest-123')
      .reply(200, { reservationNo: 'R-10001', guestId: 'guest-123' });
    const summary = nock(reservationUrl)
      .get('/reservations/R-10001/payment-summary')
      .reply(200, {
        reservationNo: 'R-10001',
        totalAmount: 200,
        depositHeld: 60,
        approvedProofsTotal: 42.5,
        balanceDue: 97.5,
        currency: 'USD'
      });
    const paymentSummary = await request(app)
      .get('/reservations/R-10001/payment-summary')
      .set('Authorization', guestAuth);
    expect(paymentSummary.status).toBe(200);
    expect(paymentSummary.body).toMatchObject({ approvedProofsTotal: 42.5, balanceDue: 97.5 });
    expect(summary.isDone()).toBe(true);
  });
});
