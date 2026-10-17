import { readFile } from 'node:fs/promises';
import nock from 'nock';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db.js';

const depositPayload = {
  reservationNo: 'R-10001',
  guestId: 'guest-123',
  amount: 150,
  currency: 'USD'
};

beforeAll(async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
});

beforeEach(async () => {
  await pool.query('TRUNCATE payment_proofs, payments CASCADE');
  delete process.env.PAYMENT_MODE;
  delete process.env.RESERVATION_SERVICE_URL;
});

afterAll(async () => {
  nock.restore();
  await pool.end();
});

describe('billing endpoints', () => {
  it('approves deposits by default and stores the payment', async () => {
    const response = await request(app).post('/deposits').send(depositPayload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'authorized',
      amount: 150,
      currency: 'USD'
    });

    const stored = await pool.query('SELECT * FROM payments WHERE id = $1', [response.body.depositId]);
    expect(stored.rows[0]).toMatchObject({
      type: 'deposit',
      status: 'authorized',
      reservation_no: 'R-10001',
      guest_id: 'guest-123'
    });
  });

  it('declines deposits when PAYMENT_MODE=decline', async () => {
    process.env.PAYMENT_MODE = 'decline';

    const response = await request(app).post('/deposits').send(depositPayload);

    expect(response.status).toBe(402);
    expect(response.body.error).toBe('PaymentDeclined');

    const stored = await pool.query("SELECT status FROM payments WHERE type = 'deposit'");
    expect(stored.rows).toEqual([{ status: 'declined' }]);
  });

  it('refunds an authorized deposit and stores the refund', async () => {
    const deposit = await request(app).post('/deposits').send(depositPayload);
    const response = await request(app).post('/refunds').send({
      depositId: deposit.body.depositId,
      amount: 50,
      currency: 'USD'
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      depositId: deposit.body.depositId,
      status: 'refunded',
      amount: 50,
      currency: 'USD'
    });

    const stored = await pool.query('SELECT * FROM payments WHERE id = $1', [response.body.refundId]);
    expect(stored.rows[0]).toMatchObject({
      type: 'refund',
      status: 'refunded',
      deposit_id: deposit.body.depositId
    });
  });

  it('stores, lists, streams, and reviews payment proofs', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test')
      .get('/reservations/R-10001')
      .reply(200, { reservationNo: 'R-10001', guestId: 'guest-123' });

    const created = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('proof-bytes'), 'proof.pdf');

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending' });

    const list = await request(app)
      .get('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .query({ reservationNo: 'R-10001' });

    expect(list.status).toBe(200);
    expect(list.body.proofs).toHaveLength(1);
    expect(list.body.proofs[0]).not.toHaveProperty('file_data');

    const file = await request(app)
      .get(`/payments/proofs/${created.body.id}/file`)
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest');

    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    const review = await request(app)
      .put(`/payments/proofs/${created.body.id}/review`)
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'approved' });

    expect(review.status).toBe(200);
    expect(review.body.proof).toMatchObject({ status: 'approved', reviewedBy: 'agent-1' });
  });

  it('rejects unsupported proof types and oversized uploads', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test')
      .get('/reservations/R-10001')
      .reply(200, { reservationNo: 'R-10001', guestId: 'guest-123' });

    const badType = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('plain text'), 'proof.txt');

    const large = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'proof.pdf');

    expect(badType.status).toBe(400);
    expect(large.status).toBe(413);
  });
});