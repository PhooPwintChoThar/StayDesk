import { handleReservationConfirmed, startConsumer, QUEUE_NAME } from '../consumer.js';
import { jest } from '@jest/globals';

const event = {
  reservationNo: 'R-10001',
  guestId: 'guest-123',
  roomTypeId: 'standard',
  checkIn: '2027-03-10',
  checkOut: '2027-03-12',
  totalAmount: 200,
  currency: 'USD',
  confirmedAt: '2027-03-01T10:00:00.000Z'
};

describe('ReservationConfirmed consumer', () => {
  it('sends a test email through the mailer', async () => {
    const mailer = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await handleReservationConfirmed(event, mailer);

    expect(mailer.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: expect.any(String),
      subject: 'Reservation confirmed: R-10001',
      text: expect.stringContaining('Dates: 2027-03-10 to 2027-03-12')
    }));
  });

  it('rejects malformed event payloads', async () => {
    const mailer = { sendEmail: jest.fn() };

    await expect(handleReservationConfirmed({}, mailer))
      .rejects.toThrow('Invalid ReservationConfirmed payload.');
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it('asserts a durable queue and acknowledges successfully processed messages', async () => {
    const payload = Buffer.from(JSON.stringify(event));
    const message = { content: payload };
    const mailer = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn(async (_queue, callback) => {
        await callback(message);
      }),
      ack: jest.fn(),
      nack: jest.fn()
    };

    await startConsumer(channel, mailer);

    expect(channel.assertQueue).toHaveBeenCalledWith(QUEUE_NAME, { durable: true });
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});