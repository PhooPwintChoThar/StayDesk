import { createNotifier } from './channels.js';

export const QUEUE_NAME = 'ReservationConfirmed';
export const QUEUE_NAMES = ['ReservationConfirmed', 'ReservationModified', 'ReservationCancelled'];

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

  const channel = payload.channel || process.env.NOTIFICATION_CHANNEL || 'email';
  const adapter = typeof notifier.notify === 'function'
    ? notifier
    : createNotifier({
      mailer: notifier,
      sms: notifier,
      channel
    });

  await adapter.notify(payload);
}

export async function startConsumer(channel, notifier, queueName = QUEUE_NAME) {
  await channel.assertQueue(queueName, { durable: true });
  await channel.consume(queueName, async (message) => {
    if (!message) return;

    try {
      const payload = JSON.parse(message.content.toString());
      await handleReservationConfirmed(payload, notifier);
      channel.ack(message);
    } catch (error) {
      console.error(`Failed to process ${queueName}:`, error);
      channel.nack(message, false, true);
    }
  });
}
