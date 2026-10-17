# RabbitMQ events

## `ReservationConfirmed`

Published by the reservation service after the room hold is confirmed and the deposit is authorized.

### Payload

| Field | Type | Description |
|---|---|---|
| `reservationNo` | string | Reservation identifier |
| `guestId` | string | Guest identifier |
| `guestEmail` | string | Guest email used for confirmation, when known |
| `guestPhone` | string | Guest phone used for SMS confirmation, when known |
| `channel` | string | `email` or `sms` |
| `roomTypeId` | string | Reserved room type |
| `checkIn` | string | Check-in date in `YYYY-MM-DD` format |
| `checkOut` | string | Check-out date in `YYYY-MM-DD` format |
| `totalAmount` | number | Reservation amount |
| `currency` | string | ISO 4217 currency code |
| `confirmedAt` | string | Confirmation timestamp in ISO 8601 format |

### Example

```json
{
  "reservationNo": "R-10001",
  "guestId": "guest-123",
  "roomTypeId": "standard",
  "checkIn": "2026-11-01",
  "checkOut": "2026-11-04",
  "totalAmount": 450,
  "currency": "USD",
  "confirmedAt": "2026-10-12T10:30:00Z"
}
```