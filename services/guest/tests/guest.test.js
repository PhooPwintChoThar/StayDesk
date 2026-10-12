import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db.js';

beforeAll(async () => {
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  await pool.query('TRUNCATE guests CASCADE');
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
});