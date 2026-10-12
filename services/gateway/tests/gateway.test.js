import jwt from 'jsonwebtoken';
import nock from 'nock';
import request from 'supertest';
import { createApp } from '../app.js';

const secret = 'gateway-test-secret';
const roomRateUrl = 'http://room-rate.test';

function token(role) {
  return jwt.sign({ role }, secret);
}

describe('gateway authentication and proxying', () => {
  beforeAll(() => {
    process.env.ROOM_RATE_SERVICE_URL = roomRateUrl;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.restore();
  });

  it('returns 401 when the JWT is missing or invalid', async () => {
    const app = createApp({ secret });

    const missing = await request(app).get('/availability');
    const invalid = await request(app)
      .get('/availability')
      .set('Authorization', 'Bearer invalid-token');

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it('returns 403 when a guest requests an agent-only route', async () => {
    const app = createApp({ secret });

    const response = await request(app)
      .post('/deposits')
      .set('Authorization', `Bearer ${token('guest')}`)
      .send({ amount: 10 });

    expect(response.status).toBe(403);
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
});