import { createNotifier } from './channels.js';

export const QUEUE_NAME = 'ReservationConfirmed';
export const QUEUE_NAMES = [
  'ReservationConfirmed',
  'ReservationModified',
  'ReservationCancelled',
  'PaymentProofReviewed'
];

const required = [
  'reservationNo',
  'guestId',
  'roomTypeId',
  'checkIn',
  'checkOut',
  'confirmedAt'
];

export async function handleReservationConfirmed(payload, notifier) {
  if (!payload || required.some((field) => !payload[field])) {
    throw new Error('Invalid ReservationConfirmed payload.');
  }

  const channel = payload.notificationChannel || payload.channel || process.env.NOTIFICATION_CHANNEL || 'email';
  const adapter = typeof notifier.notify === 'function'
    ? notifier
    : createNotifier({
      mailer: notifier,
      sms: notifier,
      channel
    });

  await adapter.notify(payload);
}

export async function handlePaymentProofReviewed(payload, notifier) {
  const required = ['reservationNo', 'guestId', 'amount', 'currency', 'status'];
  if (
    !payload ||
    required.some((field) => payload[field] === null || payload[field] === undefined || payload[field] === '') ||
    !Number.isFinite(Number(payload.amount)) ||
    Number(payload.amount) <= 0 ||
    typeof payload.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(payload.currency) ||
    !['approved', 'rejected'].includes(payload.status)
  ) {
    throw new Error('Invalid PaymentProofReviewed payload.');
  }

  const channel = payload.notificationChannel || payload.channel || process.env.NOTIFICATION_CHANNEL || 'email';
  const adapter = typeof notifier.notify === 'function'
    ? notifier
    : createNotifier({
      mailer: notifier,
      sms: notifier,
      channel
    });

  await adapter.notify(payload);
}

export async function handleNotification(payload, notifier) {
  if (payload?.event === 'PaymentProofReviewed') {
    return handlePaymentProofReviewed(payload, notifier);
  }
  return handleReservationConfirmed(payload, notifier);
}

export async function startConsumer(channel, notifier, queueName = QUEUE_NAME) {
  await channel.assertQueue(queueName, { durable: true });
  await channel.consume(queueName, async (message) => {
    if (!message) return;

    try {
      const payload = JSON.parse(message.content.toString());
      await handleNotification(payload, notifier);
      channel.ack(message);
    } catch (error) {
      console.error(`Failed to process ${queueName}:`, error);
      channel.nack(message, false, true);
    }
  });
}
