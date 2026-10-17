import { createNotifier, MissingRecipientError } from './channels.js';

export const QUEUE_NAME = 'ReservationConfirmed';
export const QUEUE_NAMES = [
  'ReservationConfirmed',
  'ReservationModified',
  'ReservationCancelled',
  'PaymentProofReviewed'
];

const RETRY_DELAY_MS = 5000;

export class InvalidPayloadError extends Error {}

const required = [
  'reservationNo',
  'guestId',
  'roomTypeId',
  'checkIn',
  'checkOut',
  'confirmedAt'
];

function adapterFor(payload, notifier) {
  if (typeof notifier.notify === 'function') return notifier;
  return createNotifier({
    mailer: notifier,
    sms: notifier,
    channel: payload.notificationChannel || payload.channel || process.env.NOTIFICATION_CHANNEL || 'email'
  });
}

export async function handleReservationConfirmed(payload, notifier) {
  if (!payload || required.some((field) => !payload[field])) {
    throw new InvalidPayloadError('Invalid ReservationConfirmed payload.');
  }

  return adapterFor(payload, notifier).notify(payload);
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
    throw new InvalidPayloadError('Invalid PaymentProofReviewed payload.');
  }

  return adapterFor(payload, notifier).notify(payload);
}

export async function handleNotification(payload, notifier) {
  if (payload?.event === 'PaymentProofReviewed') {
    return handlePaymentProofReviewed(payload, notifier);
  }
  return handleReservationConfirmed(payload, notifier);
}

export async function startConsumer(
  channel,
  notifier,
  queueName = QUEUE_NAME,
  { record = async () => {}, enrich = async (payload) => payload, retryDelayMs = RETRY_DELAY_MS } = {}
) {
  await channel.assertQueue(queueName, { durable: true });
  await channel.consume(queueName, async (message) => {
    if (!message) return;

    let payload = null;
    try {
      payload = JSON.parse(message.content.toString());
      payload = await enrich(payload);
      const delivery = await handleNotification(payload, notifier);
      await record({ queueName, payload, status: 'sent', ...delivery }).catch((error) => console.error(error));
      channel.ack(message);
    } catch (error) {
      const permanent = error instanceof SyntaxError ||
        error instanceof InvalidPayloadError ||
        error instanceof MissingRecipientError;
      console.error(`Failed to process ${queueName}:`, error.message);
      await record({
        queueName,
        payload,
        status: permanent ? 'skipped' : 'failed',
        error: error.message
      }).catch((recordError) => console.error(recordError));

      if (permanent) {
        // A malformed or undeliverable message will never succeed; drop it instead of looping.
        channel.nack(message, false, false);
      } else {
        setTimeout(() => channel.nack(message, false, true), retryDelayMs);
      }
    }
  });
}
