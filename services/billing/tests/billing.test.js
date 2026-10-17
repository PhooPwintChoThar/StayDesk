import { readFile } from 'node:fs/promises';
import nock from 'nock';
import request from 'supertest';
import { jest } from '@jest/globals';
import { app, createApp } from '../app.js';
import { pool } from '../db.js';

const reservationFixture = {
  reservationNo: 'R-10001',
  guestId: 'guest-123',
  status: 'confirmed',
  currency: 'USD',
  totalAmount: 300,
  depositHeld: 90,
  checkIn: '2027-03-10',
  checkOut: '2027-03-12',
  roomTypeId: 'standard',
};

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
  nock.cleanAll();
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
      .times(2)
      .reply(200, reservationFixture);

    const created = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('%PDF-1.4\nproof bytes'), 'proof.pdf');

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
    expect(list.body.proofs[0]).not.toHaveProperty('reviewedBy');
    expect(list.body.proofs[0]).not.toHaveProperty('reviewedByRole');

    const guestReview = await request(app)
      .put('/payments/proofs/not-a-proof/review')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .send({ decision: 'approved' });
    const file = await request(app)
      .get(`/payments/proofs/${created.body.id}/file`)
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest');

    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toBe("attachment; filename*=UTF-8''proof.pdf");
    expect(guestReview.status).toBe(403);

    nock('http://reservation.test').post('/reservations/R-10001/payment-approved').reply(200, { status: 'confirmed' });
    const review = await request(app)
      .put(`/payments/proofs/${created.body.id}/review`)
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'approved' });

    expect(review.status).toBe(200);
    expect(review.body.proof).toMatchObject({ status: 'approved', reviewedBy: 'agent-1' });
    expect(created.body.paymentNo).toMatch(/^PMT-\d{6}$/);
    expect(review.body.proof.paymentNo).toBe(created.body.paymentNo);
  });

  it('rejects unsupported proof types and oversized uploads', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test')
      .get('/reservations/R-10001')
      .reply(200, reservationFixture);

    const badType = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('plain text'), 'proof.txt');

    const spoofedType = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'spoofed.pdf', {
        contentType: 'application/pdf'
      });

    const large = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'proof.pdf');

    expect(badType.status).toBe(400);
    expect(spoofedType.status).toBe(400);
    expect(large.status).toBe(413);
  });

  it('accepts PNG and JPEG files whose magic bytes match their MIME types', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test')
      .get('/reservations/R-10001')
      .twice()
      .reply(200, reservationFixture);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

    const pngUpload = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '10')
      .field('currency', 'USD')
      .attach('file', png, 'proof.png');
    const jpegUpload = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '10')
      .field('currency', 'USD')
      .attach('file', jpeg, 'proof.jpg');

    expect(pngUpload.status).toBe(201);
    expect(jpegUpload.status).toBe(201);
  });

  it('requires an authenticated identity and limits guests to their own proof files', async () => {
    const missingUploadIdentity = await request(app)
      .post('/payments/proofs')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001');
    const missingListIdentity = await request(app)
      .get('/payments/proofs')
      .set('x-user-role', 'guest');
    const missingFileIdentity = await request(app)
      .get('/payments/proofs/00000000-0000-0000-0000-000000000001/file')
      .set('x-user-role', 'guest');
    const invalidRole = await request(app)
      .get('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'unknown');

    expect(missingUploadIdentity.status).toBe(401);
    expect(missingListIdentity.status).toBe(401);
    expect(missingFileIdentity.status).toBe(401);
    expect(invalidRole.status).toBe(403);

    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test')
      .get('/reservations/R-OTHER')
      .reply(200, { ...reservationFixture, reservationNo: 'R-OTHER', guestId: 'guest-999' });
    const deniedUpload = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-OTHER')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('%PDF-1.4\nproof'), 'proof.pdf');
    expect(deniedUpload.status).toBe(403);

    nock('http://reservation.test')
      .get('/reservations/R-10001')
      .reply(200, reservationFixture);
    const created = await request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', '42.50')
      .field('currency', 'USD')
      .attach('file', Buffer.from('%PDF-1.4\nproof'), 'proof "safe".pdf');
    await pool.query(
      'UPDATE payment_proofs SET file_name = $1 WHERE id = $2',
      ['unsafe"\r\nX-Injected: 1.pdf', created.body.id]
    );
    const ownFile = await request(app)
      .get(`/payments/proofs/${created.body.id}/file`)
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest');
    const otherGuestFile = await request(app)
      .get(`/payments/proofs/${created.body.id}/file`)
      .set('x-user-id', 'guest-456')
      .set('x-user-role', 'guest');

    expect(created.status).toBe(201);
    expect(ownFile.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''unsafe%22%0D%0AX-Injected%3A%201.pdf"
    );
    expect(ownFile.headers['content-disposition']).not.toMatch(/[\r\n"]/);
    expect(otherGuestFile.status).toBe(403);
  });

  it('does not fail proof review when its notification publisher rejects', async () => {
    const proofId = '00000000-0000-0000-0000-000000000099';
    await pool.query(
      `INSERT INTO payment_proofs (
        id, reservation_no, guest_id, amount, currency, file_name, file_type,
        file_size, file_data, status
      ) VALUES ($1, 'R-10001', 'guest-123', 25, 'USD', 'proof.pdf',
                'application/pdf', 8, $2, 'pending')`,
      [proofId, Buffer.from('%PDF-1.4')]
    );
    const notifyProofReview = jest.fn().mockRejectedValue(new Error('notification unavailable'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(createApp({ db: pool, notifyProofReview }))
      .put(`/payments/proofs/${proofId}/review`)
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'rejected', note: 'Receipt is unreadable.' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(200);
    expect(response.body.proof.status).toBe('rejected');
    expect(notifyProofReview).toHaveBeenCalledWith(expect.objectContaining({
      reservationNo: 'R-10001',
      guestId: 'guest-123',
      amount: 25,
      currency: 'USD',
      status: 'rejected',
      reviewNote: 'Receipt is unreadable.',
      event: 'PaymentProofReviewed'
    }));
    expect(log).toHaveBeenCalledWith('Failed to send payment proof review notification:', 'notification unavailable');
    log.mockRestore();
  });

  const uploadProof = (amount, overrides = {}) =>
    request(app)
      .post('/payments/proofs')
      .set('x-user-id', 'guest-123')
      .set('x-user-role', 'guest')
      .field('reservationNo', 'R-10001')
      .field('amount', String(amount))
      .field('currency', overrides.currency ?? 'USD')
      .attach('file', Buffer.from('%PDF-1.4\nproof'), 'proof.pdf');

  it('rejects proofs above the outstanding balance, in the wrong currency, or for cancelled stays', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test').get('/reservations/R-10001').times(4).reply(200, reservationFixture);
    nock('http://reservation.test').get('/reservations/R-10001').reply(200, { ...reservationFixture, status: 'cancelled' });

    const first = await uploadProof(200);
    const tooMuch = await uploadProof(10.01);
    const wrongCurrency = await uploadProof(5, { currency: 'EUR' });
    const exact = await uploadProof(10);
    const cancelled = await uploadProof(1);

    expect(first.status).toBe(201);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toContain('10.00 USD');
    expect(wrongCurrency.status).toBe(400);
    expect(exact.status).toBe(201);
    expect(cancelled.status).toBe(409);

    const stored = await pool.query('SELECT COUNT(*)::int AS count FROM payment_proofs');
    expect(stored.rows[0].count).toBe(2);
  });

  it('confirms an approved payment to the guest with the remaining balance', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test').get('/reservations/R-10001').times(2).reply(200, reservationFixture);
    const notifyProofReview = jest.fn().mockResolvedValue(undefined);
    const confirmReservationPayment = jest.fn().mockResolvedValue(undefined);
    const reviewApp = createApp({ db: pool, notifyProofReview, confirmReservationPayment });

    const created = await uploadProof(110);
    const review = await request(reviewApp)
      .put(`/payments/proofs/${created.body.id}/review`)
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'approved' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(review.status).toBe(200);
    expect(notifyProofReview).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PaymentProofReviewed',
      status: 'approved',
      reservationNo: 'R-10001',
      amount: 110,
      checkIn: '2027-03-10',
      totalAmount: 300,
      paidToDate: 200,
      balanceDue: 100,
      bookingConfirmed: false,
      paymentNo: expect.stringMatching(/^PMT-/),
    }));
    expect(confirmReservationPayment).toHaveBeenCalledWith('R-10001');
  });

  it('refuses to approve a proof for a cancelled reservation or beyond the balance', async () => {
    const insert = (id, amount, status = 'pending') => pool.query(
      `INSERT INTO payment_proofs (id, reservation_no, guest_id, amount, currency, file_name, file_type, file_size, file_data, status)
       VALUES ($1, 'R-10001', 'guest-123', $2, 'USD', 'p.pdf', 'application/pdf', 8, $3, $4)`,
      [id, amount, Buffer.from('%PDF-1.4'), status]
    );
    await insert('00000000-0000-0000-0000-000000000001', 150, 'approved');
    await insert('00000000-0000-0000-0000-000000000002', 100);
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test').get('/reservations/R-10001').reply(200, reservationFixture);
    nock('http://reservation.test').get('/reservations/R-10001').reply(200, { ...reservationFixture, status: 'cancelled' });
    const review = () => request(createApp({ db: pool, notifyProofReview: jest.fn() }))
      .put('/payments/proofs/00000000-0000-0000-0000-000000000002/review')
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'approved' });

    const overBalance = await review();
    const cancelled = await review();
    const unknown = await request(app)
      .put('/payments/proofs/not-a-uuid/review')
      .set('x-user-id', 'agent-1')
      .set('x-user-role', 'agent')
      .send({ decision: 'approved' });

    expect(overBalance.status).toBe(409);
    expect(overBalance.body.message).toContain('60.00 USD');
    expect(cancelled.status).toBe(409);
    expect(unknown.status).toBe(404);
    const stored = await pool.query("SELECT status FROM payment_proofs WHERE id = '00000000-0000-0000-0000-000000000002'");
    expect(stored.rows[0].status).toBe('pending');
  });

  it('reports approved and pending proof totals for a reservation', async () => {
    const insert = (id, amount, status) => pool.query(
      `INSERT INTO payment_proofs (id, reservation_no, guest_id, amount, currency, file_name, file_type, file_size, file_data, status)
       VALUES ($1, 'R-TOTALS', 'guest-123', $2, 'USD', 'p.pdf', 'application/pdf', 8, $3, $4)`,
      [id, amount, Buffer.from('%PDF-1.4'), status]
    );
    await insert('00000000-0000-0000-0000-000000000011', 40, 'approved');
    await insert('00000000-0000-0000-0000-000000000012', 2.5, 'approved');
    await insert('00000000-0000-0000-0000-000000000013', 10, 'pending');
    await insert('00000000-0000-0000-0000-000000000014', 99, 'rejected');

    const response = await request(app).get('/payments/reservations/R-TOTALS/totals');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reservationNo: 'R-TOTALS', approvedTotal: 42.5, pendingTotal: 10 });
  });

  it('confirms a pending booking on approval and keeps the proof pending if that fails', async () => {
    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    const pendingReservation = { ...reservationFixture, status: 'pending' };
    nock('http://reservation.test').get('/reservations/R-10001').times(3).reply(200, pendingReservation);
    const created = await uploadProof(50);
    expect(created.status).toBe(201);

    const failing = createApp({ db: pool, notifyProofReview: jest.fn(), confirmReservationPayment: jest.fn().mockRejectedValue(new Error('down')) });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await request(failing)
      .put(`/payments/proofs/${created.body.id}/review`)
      .set('x-user-id', 'agent-1').set('x-user-role', 'agent')
      .send({ decision: 'approved' });
    log.mockRestore();
    expect(failed.status).toBe(502);
    expect((await pool.query('SELECT status FROM payment_proofs WHERE id = $1', [created.body.id])).rows[0].status).toBe('pending');

    const confirmReservationPayment = jest.fn().mockResolvedValue(undefined);
    const ok = await request(createApp({ db: pool, notifyProofReview: jest.fn(), confirmReservationPayment }))
      .put(`/payments/proofs/${created.body.id}/review`)
      .set('x-user-id', 'agent-1').set('x-user-role', 'agent')
      .send({ decision: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body.bookingConfirmed).toBe(true);
    expect(confirmReservationPayment).toHaveBeenCalledWith('R-10001');
  });

  it('gives every payment a traceable number and finds proofs by it', async () => {
    const deposit = await request(app).post('/deposits').send(depositPayload);
    const refund = await request(app).post('/refunds').send({ depositId: deposit.body.depositId, amount: 10, currency: 'USD' });
    expect(deposit.body.paymentNo).toMatch(/^TXN-\d{6}$/);
    expect(refund.body.paymentNo).toMatch(/^TXN-\d{6}$/);
    expect(refund.body.paymentNo).not.toBe(deposit.body.paymentNo);
    const storedRefund = await pool.query('SELECT reservation_no FROM payments WHERE id = $1', [refund.body.refundId]);
    expect(storedRefund.rows[0].reservation_no).toBe('R-10001');

    process.env.RESERVATION_SERVICE_URL = 'http://reservation.test';
    nock('http://reservation.test').get('/reservations/R-10001').reply(200, reservationFixture);
    const created = await uploadProof(20);
    const found = await request(app)
      .get('/payments/proofs')
      .set('x-user-id', 'agent-1').set('x-user-role', 'agent')
      .query({ q: created.body.paymentNo });
    expect(found.body.proofs.map((proof) => proof.id)).toEqual([created.body.id]);
  });

  it('captures the deposit, records a desk settlement and lists every transaction', async () => {
    const deposit = await request(app).post('/deposits').send(depositPayload);
    await request(app).post('/refunds').send({ depositId: deposit.body.depositId, amount: 20, currency: 'USD' });

    const captured = await request(app).post('/deposits/capture').send({ reservationNo: 'R-10001' });
    expect(captured.body.captured).toEqual([{ paymentNo: deposit.body.paymentNo, amount: 150 }]);
    expect((await request(app).post('/deposits/capture').send({ reservationNo: 'R-10001' })).body.captured).toEqual([]);

    const settlement = await request(app).post('/settlements')
      .send({ reservationNo: 'R-10001', guestId: 'guest-123', amount: 95.5, currency: 'USD' });
    expect(settlement.status).toBe(201);
    expect(settlement.body.paymentNo).toMatch(/^TXN-/);

    const listed = await request(app).get('/payments/transactions')
      .set('x-user-id', 'agent-1').set('x-user-role', 'agent')
      .query({ reservationNo: 'R-10001' });
    expect(listed.body.transactions.map((tx) => [tx.type, tx.amount, tx.status])).toEqual([
      ['deposit', 150, 'captured'],
      ['refund', 20, 'refunded'],
      ['settlement', 95.5, 'captured'],
    ]);
    expect((await request(app).get('/payments/transactions')
      .set('x-user-id', 'guest-123').set('x-user-role', 'guest')
      .query({ reservationNo: 'R-10001' })).status).toBe(403);
  });

  it('records who approved a proof and in which role', async () => {
    const proofId = '00000000-0000-0000-0000-000000000077';
    await pool.query(
      `INSERT INTO payment_proofs (id, reservation_no, guest_id, amount, currency, file_name, file_type, file_size, file_data, status)
       VALUES ($1, 'R-10001', 'guest-123', 25, 'USD', 'p.pdf', 'application/pdf', 8, $2, 'pending')`,
      [proofId, Buffer.from('%PDF-1.4')]
    );
    const response = await request(createApp({ db: pool, notifyProofReview: jest.fn() }))
      .put(`/payments/proofs/${proofId}/review`)
      .set('x-user-id', 'manager').set('x-user-role', 'manager')
      .send({ decision: 'rejected', note: 'Blurry' });

    expect(response.body.proof).toMatchObject({ reviewedBy: 'manager', reviewedByRole: 'manager', reviewedAt: expect.any(String) });
  });

  it('cancels pending proofs and marks approved ones refund due when the booking is cancelled', async () => {
    const insert = (id, amount, status) => pool.query(
      `INSERT INTO payment_proofs (id, reservation_no, guest_id, amount, currency, file_name, file_type, file_size, file_data, status)
       VALUES ($1, 'R-CXL', 'guest-123', $2, 'USD', 'p.pdf', 'application/pdf', 8, $3, $4)`,
      [id, amount, Buffer.from('%PDF-1.4'), status]
    );
    await insert('00000000-0000-0000-0000-0000000000a1', 50, 'pending');
    await insert('00000000-0000-0000-0000-0000000000a2', 120, 'approved');
    await insert('00000000-0000-0000-0000-0000000000a3', 30, 'rejected');

    const cancelled = await request(app).post('/payments/reservations/R-CXL/cancel');
    const again = await request(app).post('/payments/reservations/R-CXL/cancel');

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ refundDueTotal: 120, cancelledProofs: [expect.stringMatching(/^PMT-/)] });
    expect(again.body).toMatchObject({ cancelledProofs: [], refundDue: [], refundDueTotal: 0 });
    const statuses = await pool.query("SELECT id, status FROM payment_proofs WHERE reservation_no = 'R-CXL' ORDER BY id");
    expect(statuses.rows.map((row) => row.status)).toEqual(['cancelled', 'refund_due', 'rejected']);

    const pendingReview = await request(createApp({ db: pool, notifyProofReview: jest.fn() }))
      .put('/payments/proofs/00000000-0000-0000-0000-0000000000a1/review')
      .set('x-user-id', 'agent-1').set('x-user-role', 'agent')
      .send({ decision: 'approved' });
    expect(pendingReview.status).toBe(409);

    const byGuest = await request(app).put('/payments/proofs/00000000-0000-0000-0000-0000000000a2/refund')
      .set('x-user-id', 'guest-123').set('x-user-role', 'guest');
    expect(byGuest.status).toBe(403);
    const refunded = await request(app).put('/payments/proofs/00000000-0000-0000-0000-0000000000a2/refund')
      .set('x-user-id', 'reception').set('x-user-role', 'agent');
    expect(refunded.status).toBe(200);
    expect(refunded.body.proof).toMatchObject({ status: 'refunded', refundedAt: expect.any(String) });
    const twice = await request(app).put('/payments/proofs/00000000-0000-0000-0000-0000000000a2/refund')
      .set('x-user-id', 'reception').set('x-user-role', 'agent');
    expect(twice.status).toBe(409);
  });
});

