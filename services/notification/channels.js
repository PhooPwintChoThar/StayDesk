// Strategy + Factory Method: confirmation can go out as email or SMS (FR confirmation channel).

export function confirmationText(payload) {
  if (payload.event === 'PaymentProofReviewed') {
    const lines = [
      `Payment proof ${payload.status}: ${payload.reservationNo}`,
      `Amount: ${payload.amount} ${payload.currency}`,
    ];
    if (payload.reviewNote) lines.push(`Note: ${payload.reviewNote}`);
    return lines.join('\n');
  }

  const label = payload.event === 'ReservationModified'
    ? 'Reservation modified'
    : payload.event === 'ReservationCancelled'
      ? 'Reservation cancelled'
      : 'Reservation confirmed';
  const total =
    payload.totalAmount == null
      ? ""
      : `\nTotal: ${payload.totalAmount} ${payload.currency ?? ""}`.trimEnd();

  return [
    `${label}: ${payload.reservationNo}`,
    `Guest: ${payload.guestId}`,
    `Room type: ${payload.roomTypeId}`,
    `Dates: ${payload.checkIn} to ${payload.checkOut}${total}`,
    `Confirmed at: ${payload.confirmedAt}`,
  ].join("\n");
}

export function createNotifier({
  mailer,
  sms,
  channel = process.env.NOTIFICATION_CHANNEL || "email",
} = {}) {
  const emailChannel = {
    name: "email",
    async notify(payload, { to } = {}) {
      await mailer.sendEmail({
        to: payload.guestEmail || to || process.env.NOTIFICATION_TEST_EMAIL || "test@example.com",
        subject: payload.event === 'PaymentProofReviewed'
          ? `Payment proof ${payload.status}: ${payload.reservationNo}`
          : `${payload.event === 'ReservationModified' ? 'Reservation modified' : payload.event === 'ReservationCancelled' ? 'Reservation cancelled' : 'Reservation confirmed'}: ${payload.reservationNo}`,
        text: confirmationText(payload),
      });
    },
  };

  const smsChannel = {
    name: "sms",
    async notify(payload, { to } = {}) {
      await sms.sendSms({
        to: payload.guestPhone || to || process.env.NOTIFICATION_TEST_PHONE || "0000000000",
        text: payload.event === 'PaymentProofReviewed'
          ? confirmationText(payload)
          : `${payload.event === 'ReservationModified' ? 'Reservation modified' : payload.event === 'ReservationCancelled' ? 'Reservation cancelled' : 'Reservation confirmed'}: ${payload.reservationNo}`,
      });
    },
  };

  return channel === "sms" ? smsChannel : emailChannel;
}
