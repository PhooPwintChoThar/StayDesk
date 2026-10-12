import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db.js';


const checkIn = '2027-03-10';
const checkOut = '2027-03-12';

beforeAll(async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
});

beforeEach(async () => {
  await pool.query('TRUNCATE holds, rooms, rate_plans, room_types, hotels CASCADE');
  await pool.query(`
    INSERT INTO hotels (id, name) VALUES ('test-hotel', 'Test Hotel');
    INSERT INTO room_types (id, hotel_id, name)
      VALUES ('test-room-type', 'test-hotel', 'Test Room');
    INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency)
      VALUES ('test-rate', 'test-room-type', 120.00, 'USD');
    INSERT INTO rooms (id, hotel_id, room_type_id, room_number)
      VALUES ('test-room-1', 'test-hotel', 'test-room-type', '101');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('room-rate endpoints', () => {
  it('returns availability for a room type', async () => {
    const response = await request(app)
      .get('/availability')
      .query({ checkIn, checkOut });

    expect(response.status).toBe(200);
    expect(response.body.availability).toEqual([
      expect.objectContaining({
        roomTypeId: 'test-room-type',
        available: true,
        roomsAvailable: 1,
        nightlyRate: 120,
        currency: 'USD'
      })
    ]);
  });

  it('reduces availability after a hold is created', async () => {
    const created = await request(app).post('/holds').send({
      roomTypeId: 'test-room-type',
      checkIn,
      checkOut
    });

    expect(created.status).toBe(201);

    const response = await request(app)
      .get('/availability')
      .query({ checkIn, checkOut });

    expect(response.body.availability[0]).toMatchObject({
      available: false,
      roomsAvailable: 0
    });
  });

  it('stops counting a hold after its 10-minute expiry', async () => {
    const created = await request(app).post('/holds').send({
      roomTypeId: 'test-room-type',
      checkIn,
      checkOut
    });
    expect(created.status).toBe(201);

    await pool.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1", [created.body.id]);

    const response = await request(app)
      .get('/availability')
      .query({ checkIn, checkOut });

    expect(response.body.availability[0]).toMatchObject({
      available: true,
      roomsAvailable: 1
    });
  });

  it('allows only one of two concurrent holds on the last room', async () => {
    const payload = { roomTypeId: 'test-room-type', checkIn, checkOut };

    const responses = await Promise.all([
      request(app).post('/holds').send(payload),
      request(app).post('/holds').send(payload)
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
  });

  it('confirms and releases a hold', async () => {
    const created = await request(app).post('/holds').send({
      roomTypeId: 'test-room-type',
      checkIn,
      checkOut
    });

    const confirmed = await request(app).post(`/holds/${created.body.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');

    const release = await request(app).delete(`/holds/${created.body.id}`);
    expect(release.status).toBe(204);
  });
});