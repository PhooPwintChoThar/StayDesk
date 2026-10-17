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

function token(role) {
  return jwt.sign({ role }, secret);
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
      .post('/deposits')
      .set('Authorization', `Bearer ${token('guest')}`)
      .send({ amount: 10 });

    expect(response.status).toBe(403);
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
      .reply(200, { reservationNo: 'R-10001', status: 'confirmed' });

    const response = await request(app)
      .get('/reservations/R-10001')
      .set('Authorization', `Bearer ${token('guest')}`);

    expect(response.status).toBe(200);
    expect(response.body.reservationNo).toBe('R-10001');
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
});
