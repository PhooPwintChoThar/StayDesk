export const QUEUE_NAME = 'ReservationConfirmed';

export async function handleReservationConfirmed(payload, mailer) {
  const required = [
    'reservationNo',
    'guestId',
    'roomTypeId',
    'checkIn',
    'checkOut',
    'confirmedAt'
  ];

  if (!payload || required.some((field) => !payload[field])) {
    throw new Error('Invalid ReservationConfirmed payload.');
  }

  const total = payload.totalAmount == null
    ? ''
    : `\nTotal: ${payload.totalAmount} ${payload.currency ?? ''}`.trimEnd();

  await mailer.sendEmail({
    to: process.env.NOTIFICATION_TEST_EMAIL || 'test@example.com',
    subject: `Reservation confirmed: ${payload.reservationNo}`,
    text: [
      `Reservation: ${payload.reservationNo}`,
      `Guest: ${payload.guestId}`,
      `Room type: ${payload.roomTypeId}`,
      `Dates: ${payload.checkIn} to ${payload.checkOut}${total}`,
      `Confirmed at: ${payload.confirmedAt}`
    ].join('\n')
  });
}

export async function startConsumer(channel, mailer) {
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.consume(QUEUE_NAME, async (message) => {
    if (!message) return;

    try {
      const payload = JSON.parse(message.content.toString());
      await handleReservationConfirmed(payload, mailer);
      channel.ack(message);
    } catch (error) {
      console.error('Failed to process ReservationConfirmed:', error);
      channel.nack(message, false, true);
    }
  });
}