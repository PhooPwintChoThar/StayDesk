// Strategy + Factory Method: confirmation can go out as email or SMS (FR confirmation channel).

export class MissingRecipientError extends Error {}

function money(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return `${Number(amount).toFixed(2)} ${currency ?? ''}`.trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function stayLines(payload) {
  const room = [
    payload.roomTypeName ?? payload.roomTypeId,
    payload.roomNumber ? `room ${payload.roomNumber}` : null
  ].filter(Boolean).join(', ');
  return [
    payload.checkIn && payload.checkOut ? `Stay: ${payload.checkIn} to ${payload.checkOut}` : null,
    room ? `Room: ${room}` : null,
    payload.guests ? `Guests: ${payload.guests}` : null
  ];
}

export function describeNotification(payload) {
  const ref = payload.reservationNo;
  const currency = payload.currency;
  const greeting = payload.guestName ? `Dear ${payload.guestName},` : 'Dear guest,';
  let subject;
  let shortText;
  let body;

  if (payload.event === 'PaymentProofReviewed' && payload.status === 'approved') {
    subject = `Payment confirmed: ${ref}`;
    shortText = `Payment of ${money(payload.amount, currency)} confirmed for booking ${ref}.`;
    const balance = Number(payload.balanceDue);
    body = [
      `We have received and approved your payment of ${money(payload.amount, currency)} for booking ${ref}.`,
      payload.bookingConfirmed ? 'Your booking is now confirmed. We look forward to welcoming you.' : null,
      '',
      payload.paymentNo ? `Payment number: ${payload.paymentNo}` : null,
      ...stayLines(payload),
      payload.totalAmount != null ? `Booking total: ${money(payload.totalAmount, currency)}` : null,
      payload.paidToDate != null ? `Paid to date: ${money(payload.paidToDate, currency)}` : null,
      payload.balanceDue != null
        ? balance > 0 ? `Balance due: ${money(balance, currency)}` : 'Your booking is now fully paid.'
        : null
    ];
  } else if (payload.event === 'PaymentProofReviewed') {
    subject = `Payment proof not accepted: ${ref}`;
    shortText = `Payment proof for booking ${ref} was not accepted. Reason: ${payload.reviewNote}`;
    body = [
      `We could not accept the payment proof of ${money(payload.amount, currency)} you uploaded for booking ${ref}.`,
      payload.paymentNo ? `Payment number: ${payload.paymentNo}` : null,
      `Reason: ${payload.reviewNote || 'No reason was given.'}`,
      '',
      'Please upload a new proof from the Payments page or contact the front desk.'
    ];
  } else if (payload.event === 'ReservationCancelled') {
    subject = `Booking cancelled: ${ref}`;
    shortText = `Booking ${ref} has been cancelled.`;
    body = [
      `Your booking ${ref} has been cancelled.`,
      '',
      ...stayLines(payload),
      payload.refundAmount != null ? `Deposit refund: ${money(payload.refundAmount, currency)}` : null,
      Number(payload.cancellationFee) > 0 ? `Cancellation fee: ${money(payload.cancellationFee, currency)}` : null,
      payload.cancelledProofs?.length
        ? `Payment proof(s) awaiting review were cancelled: ${payload.cancelledProofs.join(', ')}.`
        : null,
      Number(payload.proofRefundDue) > 0
        ? `We will refund the ${money(payload.proofRefundDue, currency)} you paid. Our front desk will contact you about the refund.`
        : null
    ];
  } else if (payload.event === 'ReservationCheckedIn') {
    subject = `Welcome! You are checked in: ${ref}`;
    shortText = `Welcome! You are checked in to ${payload.roomNumber ? `room ${payload.roomNumber}` : 'your room'}.`;
    body = [
      'Welcome to StayDesk Hotel. You are now checked in.',
      '',
      ...stayLines(payload),
      `Check-out date: ${payload.checkOut}`
    ];
  } else if (payload.event === 'ReservationCheckedOut') {
    const bill = payload.statement ?? {};
    const billCurrency = bill.currency ?? currency;
    subject = `Thank you for staying with us: ${ref}`;
    shortText = `You are checked out of booking ${ref}. Balance due: 0.`;
    body = [
      'You are checked out. Thank you for staying with us. Here is your final bill:',
      '',
      ...stayLines(payload),
      `Room total: ${money(bill.totalAmount ?? payload.totalAmount, billCurrency)}`,
      bill.depositApplied != null ? `Deposit applied: -${money(bill.depositApplied, billCurrency)}` : null,
      Number(bill.approvedPayments) > 0 ? `Payments received: -${money(bill.approvedPayments, billCurrency)}` : null,
      Number(bill.collectedAtDesk) > 0
        ? `Paid at the front desk: -${money(bill.collectedAtDesk, billCurrency)}${bill.settlementPaymentNo ? ` (${bill.settlementPaymentNo})` : ''}`
        : null,
      `Balance due: ${money(bill.balanceDue ?? 0, billCurrency)}`
    ];
  } else if (payload.event === 'ReservationModified') {
    subject = `Booking updated: ${ref}`;
    shortText = `Booking ${ref} updated: ${payload.checkIn} to ${payload.checkOut}.`;
    body = [
      `Your booking ${ref} has been updated. The new details are:`,
      '',
      ...stayLines(payload),
      payload.totalAmount != null ? `New total: ${money(payload.totalAmount, currency)}` : null
    ];
  } else if (payload.event === 'ReservationCreated') {
    subject = `Booking received: ${ref}`;
    shortText = `Booking ${ref} received for ${payload.checkIn} to ${payload.checkOut}. It is confirmed once your payment is approved.`;
    body = [
      `Thank you for your booking. We have received reservation ${ref}.`,
      'Its status is pending: it will be confirmed as soon as our front desk approves your payment.',
      'Upload your payment proof from the Payments page.',
      '',
      ...stayLines(payload),
      payload.totalAmount != null ? `Total: ${money(payload.totalAmount, currency)}` : null,
      payload.depositAmount != null ? `Deposit charged: ${money(payload.depositAmount, currency)}` : null
    ];
  } else {
    subject = `Booking confirmed: ${ref}`;
    shortText = `Booking ${ref} confirmed: ${payload.checkIn} to ${payload.checkOut}.`;
    body = [
      `Thank you for your booking. Your reservation ${ref} is confirmed.`,
      '',
      ...stayLines(payload),
      payload.totalAmount != null ? `Total: ${money(payload.totalAmount, currency)}` : null,
      payload.depositAmount != null ? `Deposit charged: ${money(payload.depositAmount, currency)}` : null
    ];
  }

  const lines = [greeting, '', ...body.filter((line) => line !== null), '', 'StayDesk Hotel'];
  const text = lines.join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${lines
    .map((line) => (line ? `<p style="margin:0">${escapeHtml(line)}</p>` : '<br>'))
    .join('')}</div>`;

  return { subject, text, html, shortText };
}

// Abstract Factory: every channel is a family of two matching products, a
// message format and a sender. Adding a channel (e.g. LINE or WhatsApp) means
// adding one factory here; the consumer and the events stay unchanged (NFR-7).
export const channelFactories = {
  email: {
    createMessage(payload) {
      const { subject, text, html } = describeNotification(payload);
      return { subject, text, html };
    },
    createSender({ mailer }) {
      return {
        recipient: (payload) => payload.guestEmail || process.env.NOTIFICATION_TEST_EMAIL,
        send: (to, message) => mailer.sendEmail({ to, ...message }),
      };
    },
  },
  sms: {
    createMessage(payload) {
      const { subject, shortText } = describeNotification(payload);
      return { subject, text: shortText };
    },
    createSender({ sms }) {
      return {
        recipient: (payload) => payload.guestPhone || process.env.NOTIFICATION_TEST_PHONE,
        send: (to, message) => sms.sendSms({ to, text: message.text }),
      };
    },
  },
};

function channelFrom(name, factory, deps) {
  const sender = factory.createSender(deps);
  return {
    name,
    canReach: (payload) => Boolean(sender.recipient(payload)),
    async notify(payload) {
      const to = sender.recipient(payload);
      if (!to) throw new MissingRecipientError(`No ${name} recipient for this guest.`);
      const message = factory.createMessage(payload);
      await sender.send(to, message);
      return { channel: name, recipient: to, subject: message.subject };
    },
  };
}

export function createNotifier({
  mailer,
  sms,
  channel = process.env.NOTIFICATION_CHANNEL || "email",
} = {}) {
  const deps = { mailer, sms };
  const email = channelFrom("email", channelFactories.email, deps);
  const preferred = channelFactories[channel] ? channelFrom(channel, channelFactories[channel], deps) : email;

  // A preferred channel the guest cannot be reached on falls back to email.
  return {
    name: preferred.name,
    notify: (payload) =>
      preferred !== email && !preferred.canReach(payload) && email.canReach(payload)
        ? email.notify(payload)
        : preferred.notify(payload),
  };
}
