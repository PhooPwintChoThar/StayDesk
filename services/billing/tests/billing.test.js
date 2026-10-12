import { readFile } from 'node:fs/promises';
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
  await pool.query('TRUNCATE payments CASCADE');
  delete process.env.PAYMENT_MODE;
});

afterAll(async () => {
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
});