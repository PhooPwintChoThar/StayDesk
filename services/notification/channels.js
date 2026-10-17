// Strategy + Factory Method: confirmation can go out as email or SMS (FR confirmation channel).

export function confirmationText(payload) {
  const total =
    payload.totalAmount == null
      ? ""
      : `\nTotal: ${payload.totalAmount} ${payload.currency ?? ""}`.trimEnd();

  return [
    `Reservation: ${payload.reservationNo}`,
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
        subject: `Reservation confirmed: ${payload.reservationNo}`,
        text: confirmationText(payload),
      });
    },
  };

  const smsChannel = {
    name: "sms",
    async notify(payload, { to } = {}) {
      await sms.sendSms({
        to: payload.guestPhone || to || process.env.NOTIFICATION_TEST_PHONE || "0000000000",
        text: `Reservation confirmed: ${payload.reservationNo}`,
      });
    },
  };

  return channel === "sms" ? smsChannel : emailChannel;
}
