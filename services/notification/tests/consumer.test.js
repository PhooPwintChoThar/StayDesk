import {
  handleNotification,
  handleReservationConfirmed,
  startConsumer,
  QUEUE_NAME,
  QUEUE_NAMES
} from '../consumer.js';
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

  it('sends an SMS when the event asks for that channel', async () => {
    const notifier = {
      sendEmail: jest.fn(),
      sendSms: jest.fn().mockResolvedValue(undefined)
    };

    await handleReservationConfirmed({ ...event, channel: 'sms' }, notifier);

    expect(notifier.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Reservation confirmed: R-10001'
    }));
    expect(notifier.sendEmail).not.toHaveBeenCalled();
  });

  it('prefers the notificationChannel event field when selecting a channel', async () => {
    const notifier = {
      sendEmail: jest.fn(),
      sendSms: jest.fn().mockResolvedValue(undefined)
    };

    await handleReservationConfirmed({ ...event, notificationChannel: 'sms' }, notifier);

    expect(notifier.sendSms).toHaveBeenCalled();
    expect(notifier.sendEmail).not.toHaveBeenCalled();
  });

  it('notifies guests when a payment proof is approved or rejected', async () => {
    const notifier = {
      sendEmail: jest.fn().mockResolvedValue(undefined),
      sendSms: jest.fn().mockResolvedValue(undefined)
    };
    const approved = {
      event: 'PaymentProofReviewed',
      reservationNo: 'R-10001',
      guestId: 'guest-123',
      guestEmail: 'guest@example.com',
      amount: 42.5,
      currency: 'USD',
      status: 'approved',
      notificationChannel: 'email'
    };
    const rejected = {
      ...approved,
      status: 'rejected',
      reviewNote: 'Receipt is unreadable.',
      notificationChannel: 'sms'
    };

    await handleNotification(approved, notifier);
    await handleNotification(rejected, notifier);

    expect(QUEUE_NAMES).toContain('PaymentProofReviewed');
    expect(notifier.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'guest@example.com',
      subject: 'Payment proof approved: R-10001',
      text: expect.stringContaining('Amount: 42.5 USD')
    }));
    expect(notifier.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Payment proof rejected: R-10001')
    }));
    expect(notifier.sendSms.mock.calls[0][0].text).toContain('Note: Receipt is unreadable.');
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