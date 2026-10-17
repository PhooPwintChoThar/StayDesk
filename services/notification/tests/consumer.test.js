import {
  handleNotification,
  handleReservationConfirmed,
  startConsumer,
  QUEUE_NAME,
  QUEUE_NAMES
} from '../consumer.js';
import { jest } from '@jest/globals';
import { createMailer } from '../mailer.js';
import { channelFactories, createNotifier } from '../channels.js';

const event = {
  reservationNo: 'R-10001',
  guestId: 'guest-123',
  roomTypeId: 'standard',
  checkIn: '2027-03-10',
  checkOut: '2027-03-12',
  guestEmail: 'guest@example.com',
  guestPhone: '+66 81 234 5678',
  totalAmount: 200,
  currency: 'USD',
  confirmedAt: '2027-03-01T10:00:00.000Z'
};

describe('ReservationConfirmed consumer', () => {
  it('sends a test email through the mailer', async () => {
    const mailer = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await handleReservationConfirmed(event, mailer);

    expect(mailer.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'guest@example.com',
      subject: 'Booking confirmed: R-10001',
      text: expect.stringContaining('Stay: 2027-03-10 to 2027-03-12')
    }));
  });

  it('sends an SMS when the event asks for that channel', async () => {
    const notifier = {
      sendEmail: jest.fn(),
      sendSms: jest.fn().mockResolvedValue(undefined)
    };

    await handleReservationConfirmed({ ...event, channel: 'sms' }, notifier);

    expect(notifier.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      to: '+66 81 234 5678',
      text: 'Booking R-10001 confirmed: 2027-03-10 to 2027-03-12.'
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
      guestPhone: '0812345678',
      amount: 42.5,
      currency: 'USD',
      status: 'approved',
      totalAmount: 300,
      paidToDate: 300,
      balanceDue: 0,
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
      subject: 'Payment confirmed: R-10001',
      text: expect.stringContaining('approved your payment of 42.50 USD')
    }));
    expect(notifier.sendEmail.mock.calls[0][0].text).toContain('Your booking is now fully paid.');
    expect(notifier.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('was not accepted')
    }));
    expect(notifier.sendSms.mock.calls[0][0].text).toContain('Reason: Receipt is unreadable.');
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

  it('drops malformed or undeliverable messages instead of requeueing them forever', async () => {
    const callbacks = [];
    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn(async (_queue, callback) => { callbacks.push(callback); }),
      ack: jest.fn(),
      nack: jest.fn()
    };
    const record = jest.fn().mockResolvedValue(undefined);
    const mailer = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await startConsumer(channel, mailer, QUEUE_NAME, { record });
    const malformed = { content: Buffer.from('not json') };
    const noRecipient = { content: Buffer.from(JSON.stringify({ ...event, guestEmail: undefined })) };
    await callbacks[0](malformed);
    await callbacks[0](noRecipient);

    expect(channel.nack).toHaveBeenCalledWith(malformed, false, false);
    expect(channel.nack).toHaveBeenCalledWith(noRecipient, false, false);
    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('retries after a delay when sending fails and records sent notifications', async () => {
    const callbacks = [];
    const channel = {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn(async (_queue, callback) => { callbacks.push(callback); }),
      ack: jest.fn(),
      nack: jest.fn()
    };
    const record = jest.fn().mockResolvedValue(undefined);
    const mailer = {
      sendEmail: jest.fn()
        .mockRejectedValueOnce(new Error('SMTP down'))
        .mockResolvedValueOnce(undefined)
    };
    const message = { content: Buffer.from(JSON.stringify(event)) };

    await startConsumer(channel, mailer, QUEUE_NAME, { record, retryDelayMs: 1 });
    await callbacks[0](message);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);

    await callbacks[0](message);
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'sent',
      channel: 'email',
      recipient: 'guest@example.com',
      subject: 'Booking confirmed: R-10001'
    }));
  });

  it('falls back to email when SMS is requested but no phone number is known', async () => {
    const notifier = { sendEmail: jest.fn().mockResolvedValue(undefined), sendSms: jest.fn() };

    await handleReservationConfirmed({ ...event, guestPhone: null, channel: 'sms' }, notifier);

    expect(notifier.sendEmail).toHaveBeenCalled();
    expect(notifier.sendSms).not.toHaveBeenCalled();
  });
});

describe('createMailer', () => {
  it('logs instead of sending when SMTP is not configured', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const mailer = createMailer({});

    await mailer.sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'Body' });

    expect(mailer.transport).toBe('log');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a@example.com'));
    log.mockRestore();
  });

  it('uses SMTP when SMTP_HOST is set', () => {
    expect(createMailer({ SMTP_HOST: 'mailpit', SMTP_PORT: '1025' }).transport).toBe('smtp');
  });

  it('tells the guest a new booking is pending until payment, and that approval confirms it', async () => {
    const notifier = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await handleNotification({ ...event, event: 'ReservationCreated' }, notifier);
    await handleNotification({
      event: 'PaymentProofReviewed', reservationNo: 'R-10001', guestId: 'guest-123', guestEmail: 'guest@example.com',
      amount: 60, currency: 'USD', status: 'approved', paymentNo: 'PMT-000042', bookingConfirmed: true
    }, notifier);

    const [created, approved] = notifier.sendEmail.mock.calls.map(([message]) => message);
    expect(created.subject).toBe('Booking received: R-10001');
    expect(created.text).toContain('pending');
    expect(approved.text).toContain('Your booking is now confirmed.');
    expect(approved.text).toContain('Payment number: PMT-000042');
  });

  it('sends a welcome email at check-in and the final bill at check-out', async () => {
    const notifier = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await handleNotification({ ...event, roomNumber: '102', event: 'ReservationCheckedIn' }, notifier);
    await handleNotification({
      ...event,
      event: 'ReservationCheckedOut',
      statement: { totalAmount: 450, depositApplied: 135, approvedPayments: 200, collectedAtDesk: 115, settlementPaymentNo: 'TXN-000012', balanceDue: 0, currency: 'USD' }
    }, notifier);

    const [checkIn, checkOut] = notifier.sendEmail.mock.calls.map(([message]) => message);
    expect(checkIn.subject).toBe('Welcome! You are checked in: R-10001');
    expect(checkIn.text).toContain('room 102');
    expect(checkOut.text).toContain('Deposit applied: -135.00 USD');
    expect(checkOut.text).toContain('Paid at the front desk: -115.00 USD (TXN-000012)');
    expect(checkOut.text).toContain('Balance due: 0.00 USD');
  });
});

describe('cancellation email', () => {
  it('tells the guest about cancelled proofs and money to be refunded', async () => {
    const mailer = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    await handleNotification({
      ...event,
      event: 'ReservationCancelled',
      refundAmount: 60,
      cancellationFee: 0,
      cancelledProofs: ['PMT-000010'],
      proofRefundDue: 140
    }, mailer);

    const { text } = mailer.sendEmail.mock.calls[0][0];
    expect(text).toContain('Deposit refund: 60.00 USD');
    expect(text).toContain('awaiting review were cancelled: PMT-000010.');
    expect(text).toContain('We will refund the 140.00 USD you paid.');
  });
});

describe('Abstract Factory: notification channels', () => {
  it('plugs in a new channel family without touching the consumer', async () => {
    const sent = [];
    channelFactories.line = {
      createMessage: (payload) => ({ subject: `LINE ${payload.reservationNo}`, text: 'hello' }),
      createSender: () => ({ recipient: () => 'line-user-1', send: async (to, message) => sent.push([to, message.subject]) })
    };
    try {
      const delivery = await createNotifier({ channel: 'line' }).notify(event);
      expect(delivery).toEqual({ channel: 'line', recipient: 'line-user-1', subject: 'LINE R-10001' });
      expect(sent).toEqual([['line-user-1', 'LINE R-10001']]);
    } finally {
      delete channelFactories.line;
    }
  });
});
