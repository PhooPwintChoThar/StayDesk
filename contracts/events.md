# RabbitMQ events

Reservation events use durable queues with the same names as the event types:
`ReservationConfirmed`, `ReservationModified`, `ReservationCancelled`, and
`PaymentProofReviewed`.

## Shared payload

All three events contain the reservation snapshot fields below. Guest contact
details and the preferred notification channel are optional.

| Field | Type | Description |
|---|---|---|
| `reservationNo` | string | Reservation identifier |
| `guestId` | string | Guest identifier |
| `guestEmail` | string, optional | Guest email used for notification, when known |
| `guestPhone` | string, optional | Guest phone used for notification, when known |
| `notificationChannel` | string, optional | `email` or `sms`; omitted values use `NOTIFICATION_CHANNEL` |
| `channel` | string, optional legacy alias | Existing publishers may use `email` or `sms` in this field |
| `guestName` | string, optional | Guest full name for the greeting |
| `roomTypeId` | string | Reserved room type |
| `roomNumber` | string, optional | Room assigned to the stay |
| `guests` | number, optional | Number of guests |
| `depositAmount` | number, optional | Deposit charged (`ReservationConfirmed`) |
| `refundAmount` | number, optional | Refund issued (`ReservationCancelled`) |
| `cancellationFee` | number, optional | Fee kept (`ReservationCancelled`) |
| `checkIn` | string | Check-in date in `YYYY-MM-DD` format |
| `checkOut` | string | Check-out date in `YYYY-MM-DD` format |
| `totalAmount` | number | Reservation amount |
| `currency` | string | ISO 4217 currency code |
| `confirmedAt` | string | Event timestamp in ISO 8601 format |
| `event` | string | Event type |

## `ReservationConfirmed`

Published after the room hold is confirmed and the deposit is authorized.

## `ReservationModified`

Published after a confirmed reservation has been successfully modified.

## `ReservationCancelled`

Published after a confirmed reservation has been cancelled and its refund and
cancellation fee have been recorded.

## `PaymentProofReviewed`

Published after an agent or manager approves or rejects a pending payment
proof. Delivery is best-effort; a notification outage does not fail the review
API request.

| Field | Type | Description |
|---|---|---|
| `event` | string | `PaymentProofReviewed` |
| `reservationNo` | string | Reservation identifier |
| `guestId` | string | Guest identifier |
| `guestEmail` | string, optional | Guest email address |
| `guestPhone` | string, optional | Guest phone number |
| `amount` | number | Submitted proof amount |
| `currency` | string | ISO 4217 currency code |
| `status` | string | `approved` or `rejected` |
| `reviewNote` | string, optional | Reviewer note, typically present for a rejection |
| `notificationChannel` | string | `email` whenever the guest has an email address |
| `checkIn`, `checkOut` | string, approvals only | Stay dates |
| `roomTypeId`, `roomNumber` | string, approvals only | Booked room |
| `totalAmount` | number, approvals only | Booking total |
| `paidToDate` | number, approvals only | Deposit plus all approved proofs |
| `balanceDue` | number, approvals only | Remaining balance; `0` means fully paid |

An approval is the guest's payment confirmation and is always sent by email.

## Delivery

The notification service sends email over SMTP (Mailpit by default in Docker
Compose) and records every attempt in `notification_db.notifications` with
status `sent`, `failed` (retried after 5 s) or `skipped` (malformed payload or
no recipient; dropped instead of requeued).
